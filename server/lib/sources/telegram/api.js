import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../../constants.js";
import { clampText } from "../../util.js";

export async function callTelegramApi(config, method, payload, options = {}) {
  const response = await fetch(`${config.apiBaseUrl}/bot${config.botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const raw = await response.text();
  const parsed = raw.trim() ? JSON.parse(raw) : {};
  if (!response.ok || parsed.ok !== true) {
    throw new Error(parsed.description || `Telegram ${method} failed with HTTP ${response.status}`);
  }
  return parsed.result;
}

export async function sendTelegramMessage(config, text) {
  const message = clampText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  if (!message) return null;
  return callTelegramApi(config, "sendMessage", { chat_id: config.chatId, text: message });
}
