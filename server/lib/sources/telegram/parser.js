function normalizeChatId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function formatNameParts(firstName, lastName) {
  return [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
}

export function formatTelegramInbound(update, configuredChatId) {
  const message = update.message || update.channel_post;
  if (!message || message.from?.is_bot) return null;
  const chatId = normalizeChatId(message.chat?.id);
  if (!chatId || chatId !== configuredChatId) return null;
  const text = (message.text || message.caption || "").trim();
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
    telegram: {
      updateId: update.update_id,
      chatId,
      chatLabel,
      senderLabel,
      messageId: message.message_id || 0,
    },
  };
}
