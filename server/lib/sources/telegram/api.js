import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { TELEGRAM_MAX_MESSAGE_LENGTH } from "../../constants.js";
import { mediaDir } from "../../paths.js";
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

function attachmentExtension(filePath, mimeType) {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (/^\.(?:png|jpe?g|gif|webp|ogg|oga|mp3|m4a|wav)$/.test(extension)) return extension;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "audio/mpeg") return ".mp3";
  if (mimeType === "audio/mp4") return ".m4a";
  if (mimeType === "audio/wav") return ".wav";
  if (mimeType?.startsWith("audio/")) return ".ogg";
  return ".jpg";
}

export async function downloadTelegramAttachment(config, attachment) {
  const file = await callTelegramApi(config, "getFile", { file_id: attachment.fileId });
  if (!file?.file_path) throw new Error("Telegram attachment did not include a downloadable file path.");

  const response = await fetch(`${config.apiBaseUrl}/file/bot${config.botToken}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram attachment download failed with HTTP ${response.status}`);

  await fs.mkdir(mediaDir, { recursive: true });
  const localPath = path.join(mediaDir, `${randomUUID()}${attachmentExtension(file.file_path, attachment.mimeType)}`);
  await fs.writeFile(localPath, Buffer.from(await response.arrayBuffer()));
  return { ...attachment, localPath };
}
