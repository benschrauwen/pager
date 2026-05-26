export const defaultSettings = {
  provider: "codex",
  cwd: process.cwd(),
  model: "",
  bypassPermissions: true,
};

export const defaultHandlerPrompt = [
  "Handle this incoming event from {{sourceLabel}}.",
  "Keep the response concise and useful.",
  "",
  "Event:",
  "{{eventText}}",
].join("\n");

export const sessionModes = {
  per_event: "New session per event",
  single_thread: "Single agent session",
};

export function coerceSessionMode(value) {
  return sessionModes[value] ? value : "per_event";
}

export const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
export const TELEGRAM_STREAM_THROTTLE_MS = 800;
export const TELEGRAM_DRAFT_KEEPALIVE_MS = 25_000;
