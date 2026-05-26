import {
  TELEGRAM_DRAFT_KEEPALIVE_MS,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_STREAM_THROTTLE_MS,
} from "../../constants.js";
import { clampText } from "../../util.js";
import { callTelegramApi, sendTelegramMessage } from "./api.js";

const TELEGRAM_PROGRESS_PARSE_MODE = "HTML";
const ITALIC_TAG_OVERHEAD = "<i></i>".length;

function escapeTelegramHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function italicHtml(text) {
  return `<i>${escapeTelegramHtml(text)}</i>`;
}

function formatTelegramProgressText({ text, phase }, { hasSentIntermediate }) {
  if (phase === "tools") return null;
  if (phase === "text" && text?.trim()) {
    const maxContentLength = TELEGRAM_MAX_MESSAGE_LENGTH - ITALIC_TAG_OVERHEAD;
    return italicHtml(clampText(text.trim(), maxContentLength));
  }
  if (hasSentIntermediate) return null;
  return italicHtml("Thinking");
}

export class TelegramProgress {
  constructor(config, { draftId } = {}) {
    this.config = config;
    this.draftId = Number.isInteger(draftId) && draftId > 0 ? draftId : Math.floor(Math.random() * 2_147_483_647) + 1;
    this.transport = null;
    this.messageId = null;
    this.lastSentText = null;
    this.lastUpdateAt = 0;
    this.pending = null;
    this.closed = false;
    this.latestStream = { text: "", phase: "thinking", toolLabel: null };
    this.hasSentIntermediate = false;
    this.throttleTimer = null;
  }

  async start() {
    try {
      const thinking = italicHtml("Thinking");
      await callTelegramApi(this.config, "sendMessageDraft", {
        chat_id: this.config.chatId,
        draft_id: this.draftId,
        text: thinking,
        parse_mode: TELEGRAM_PROGRESS_PARSE_MODE,
      });
      this.transport = "draft";
      this.lastSentText = thinking;
      this.lastUpdateAt = Date.now();
      return;
    } catch {
      // Groups and older API servers fall back to a placeholder message + edits.
    }

    const thinking = italicHtml("Thinking");
    const message = await callTelegramApi(this.config, "sendMessage", {
      chat_id: this.config.chatId,
      text: thinking,
      parse_mode: TELEGRAM_PROGRESS_PARSE_MODE,
    });
    this.transport = "edit";
    this.messageId = message?.message_id || null;
    this.lastSentText = thinking;
    this.lastUpdateAt = Date.now();
  }

  update(stream) {
    if (this.closed || !this.transport) return;
    this.latestStream = stream;
    if (stream.phase === "text" && stream.text?.trim()) {
      this.hasSentIntermediate = true;
    }
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.closed || !this.transport) return;
    if (this.throttleTimer) return;

    const display = formatTelegramProgressText(this.latestStream, {
      hasSentIntermediate: this.hasSentIntermediate,
    });
    const now = Date.now();
    const keepaliveDue = this.transport === "draft" && now - this.lastUpdateAt >= TELEGRAM_DRAFT_KEEPALIVE_MS;
    const throttleDue = now - this.lastUpdateAt >= TELEGRAM_STREAM_THROTTLE_MS;

    if (!keepaliveDue && (display === null || display === this.lastSentText)) return;
    if (!keepaliveDue && !throttleDue) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.scheduleUpdate();
      }, TELEGRAM_STREAM_THROTTLE_MS - (now - this.lastUpdateAt));
      return;
    }

    if (this.pending) return;

    this.pending = this.flushUpdate(display ?? this.lastSentText)
      .finally(() => {
        this.pending = null;
        this.scheduleUpdate();
      });
  }

  async flushUpdate(display) {
    try {
      if (this.transport === "draft") {
        await callTelegramApi(this.config, "sendMessageDraft", {
          chat_id: this.config.chatId,
          draft_id: this.draftId,
          text: display,
          parse_mode: TELEGRAM_PROGRESS_PARSE_MODE,
        });
      } else if (this.messageId) {
        await callTelegramApi(this.config, "editMessageText", {
          chat_id: this.config.chatId,
          message_id: this.messageId,
          text: display,
          parse_mode: TELEGRAM_PROGRESS_PARSE_MODE,
        });
      }
      this.lastSentText = display;
      this.lastUpdateAt = Date.now();
    } catch (error) {
      console.warn(`Telegram progress update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async finish(text) {
    this.closed = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    if (this.pending) await this.pending.catch(() => {});

    const finalText = clampText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
    if (!finalText) return null;

    if (this.transport === "edit" && this.messageId) {
      try {
        await callTelegramApi(this.config, "editMessageText", {
          chat_id: this.config.chatId,
          message_id: this.messageId,
          text: finalText,
        });
        return { message_id: this.messageId };
      } catch {
        // Fall through to a fresh message if the placeholder was deleted.
      }
    }

    return sendTelegramMessage(this.config, finalText);
  }
}
