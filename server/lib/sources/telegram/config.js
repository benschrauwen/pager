import { readEnv, parsePositiveInteger } from "../../util.js";

export function resolveTelegramConfig(handler) {
  const config = handler.sourceConfig || {};
  const state = handler.sourceState || {};
  const botToken = String(config.botToken || "").trim() || readEnv("PAGER_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN");
  const chatId = String(config.chatId || "").trim() || readEnv("PAGER_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return null;
  return {
    botToken,
    chatId,
    apiBaseUrl: String(config.apiBaseUrl || "").trim() || readEnv("PAGER_TELEGRAM_API_BASE_URL") || "https://api.telegram.org",
    pollTimeoutSeconds: parsePositiveInteger(config.pollTimeoutSeconds || readEnv("PAGER_TELEGRAM_POLL_TIMEOUT_SECONDS"), 20),
    nextUpdateOffset: Number.isInteger(state.nextUpdateOffset) ? state.nextUpdateOffset : null,
  };
}
