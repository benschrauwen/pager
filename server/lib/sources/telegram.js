import { enqueueEventSession } from "../sessions.js";
import { updateStore } from "../store.js";
import { callTelegramApi } from "./telegram/api.js";
import { resolveTelegramConfig } from "./telegram/config.js";
import { formatTelegramInbound } from "./telegram/parser.js";
import { TelegramProgress } from "./telegram/progress.js";

export const label = "Telegram";

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readConfigString(input, previous, key, { secret = false } = {}) {
  if (!Object.hasOwn(input || {}, key)) return trimString(previous?.[key]);
  const value = trimString(input[key]);
  if (secret && !value) return trimString(previous?.[key]);
  return value;
}

export function normalizeConfig(input = {}, previous = {}) {
  const config = {
    botToken: readConfigString(input, previous, "botToken", { secret: true }),
    chatId: readConfigString(input, previous, "chatId"),
  };
  const apiBaseUrl = readConfigString(input, previous, "apiBaseUrl");
  const pollTimeoutSeconds = Object.hasOwn(input, "pollTimeoutSeconds")
    ? Number.parseInt(String(input.pollTimeoutSeconds || ""), 10)
    : previous.pollTimeoutSeconds;

  if (apiBaseUrl) config.apiBaseUrl = apiBaseUrl;
  if (Number.isInteger(pollTimeoutSeconds) && pollTimeoutSeconds > 0) {
    config.pollTimeoutSeconds = pollTimeoutSeconds;
  }
  return config;
}

export function normalizeState(input = {}, legacyConfig = {}) {
  const nextUpdateOffset = Number.isInteger(input.nextUpdateOffset)
    ? input.nextUpdateOffset
    : legacyConfig.nextUpdateOffset;
  return Number.isInteger(nextUpdateOffset) ? { nextUpdateOffset } : {};
}

export function publicConfig(config = {}) {
  return {
    ...config,
    botToken: "",
    hasBotToken: Boolean(config.botToken),
  };
}

async function persistNextUpdateOffset(handlerId, nextUpdateOffset) {
  await updateStore((store) => {
    const handler = store.handlers.find((entry) => entry.id === handlerId);
    if (!handler) return;
    handler.sourceState = { ...(handler.sourceState || {}), nextUpdateOffset };
  });
}

function highestUpdateOffset(updates, currentOffset) {
  let highestUpdateId = currentOffset ? currentOffset - 1 : null;
  for (const update of updates) {
    if (Number.isInteger(update.update_id)) {
      highestUpdateId = highestUpdateId === null ? update.update_id : Math.max(highestUpdateId, update.update_id);
    }
  }
  return highestUpdateId === null ? null : highestUpdateId + 1;
}

async function handleTelegramEvent(handler, config, event) {
  const progress = new TelegramProgress(config, { draftId: event.telegram.messageId });
  await progress.start();
  const { session } = await enqueueEventSession(handler, event, {
    onStream: (stream) => progress.update(stream),
  });
  await progress.finish(session.messages.at(-1)?.content || "");
}

export function createRunner(handler) {
  const config = resolveTelegramConfig(handler);
  if (!config) throw new Error("Telegram handler needs a bot token and chat id.");
  let stopped = false;
  let pollController = null;

  return {
    stop() {
      stopped = true;
      pollController?.abort();
    },
    async run() {
      let nextUpdateOffset = config.nextUpdateOffset || undefined;
      console.log(`Telegram handler "${handler.name}" listening for chat ${config.chatId}`);

      while (!stopped) {
        pollController = new AbortController();
        let updates;
        try {
          updates = await callTelegramApi(
            config,
            "getUpdates",
            {
              timeout: config.pollTimeoutSeconds,
              allowed_updates: ["message", "channel_post"],
              ...(nextUpdateOffset ? { offset: nextUpdateOffset } : {}),
            },
            { signal: pollController.signal },
          );
        } catch (error) {
          pollController = null;
          if (error?.name === "AbortError") return;
          throw error;
        }
        pollController = null;

        for (const update of updates) {
          const event = formatTelegramInbound(update, config.chatId);
          if (event) await handleTelegramEvent(handler, config, event);
        }

        const newOffset = highestUpdateOffset(updates, nextUpdateOffset);
        if (newOffset !== null) {
          nextUpdateOffset = newOffset;
          await persistNextUpdateOffset(handler.id, nextUpdateOffset);
        }
      }
    },
  };
}
