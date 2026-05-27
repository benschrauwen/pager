function normalizeChatId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function formatNameParts(firstName, lastName) {
  return [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
}

function mediaAttachment(message) {
  const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
  if (photo?.file_id) {
    return {
      kind: "image",
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || null,
      mimeType: "image/jpeg",
      fileName: null,
    };
  }
  const document = message.document;
  if (document?.file_id && String(document.mime_type || "").startsWith("image/")) {
    return {
      kind: "image",
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id || null,
      mimeType: document.mime_type,
      fileName: document.file_name || null,
    };
  }
  const voice = message.voice;
  if (voice?.file_id) {
    return {
      kind: "audio",
      fileId: voice.file_id,
      fileUniqueId: voice.file_unique_id || null,
      mimeType: voice.mime_type || "audio/ogg",
      fileName: null,
    };
  }
  return null;
}

export function formatTelegramInbound(update, configuredChatId) {
  const message = update.message || update.channel_post;
  if (!message || message.from?.is_bot) return null;
  const chatId = normalizeChatId(message.chat?.id);
  if (!chatId || chatId !== configuredChatId) return null;
  const attachment = mediaAttachment(message);
  const defaultText = attachment?.kind === "audio" ? "User sent a voice note." : "User sent an image.";
  const text = (message.text || message.caption || (attachment ? defaultText : "")).trim();
  if (!text) return null;
  const chatLabel =
    message.chat?.title?.trim() ||
    (message.chat?.username ? `@${message.chat.username.trim()}` : "") ||
    formatNameParts(message.chat?.first_name, message.chat?.last_name) ||
    `chat ${chatId}`;
  const senderName = formatNameParts(message.from?.first_name, message.from?.last_name);
  const senderLabel = senderName && message.from?.username
    ? `${senderName} (@${message.from.username})`
    : senderName || (message.from?.username ? `@${message.from.username}` : chatLabel);
  return {
    id: String(update.update_id),
    text,
    raw: update,
    attachments: attachment ? [attachment] : [],
    telegram: {
      updateId: update.update_id,
      chatId,
      chatLabel,
      senderLabel,
      messageId: message.message_id || 0,
    },
  };
}
