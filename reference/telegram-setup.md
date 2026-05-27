# Telegram handler

Pager polls Telegram's `getUpdates` API and runs the agent CLI for each text message, image, or voice note sent to a configured chat.

## Required setup

1. Create a bot with BotFather and copy its token.
2. Send a message to the bot from the chat you want to monitor.
3. Find the chat ID. The easiest path is hitting:

   ```sh
   curl "https://api.telegram.org/bot<BOT_TOKEN>/getUpdates"
   ```

   and reading `result[].message.chat.id`.

## Create the handler

```sh
curl -X POST http://127.0.0.1:4111/api/handlers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Telegram triage",
    "source": "telegram",
    "enabled": true,
    "sessionMode": "single_thread",
    "prompt": "Handle this Telegram message: {{eventText}}",
    "sourceConfig": {
      "botToken": "123:abc",
      "chatId": "123456789"
    }
  }'
```

After each agent run, Pager sends the assistant response back to the chat. While the agent is working, Pager streams progress with Telegram's `sendMessageDraft` API (Bot API 9.5+) when available — showing a native "Thinking..." placeholder, then partial text as tokens arrive, and "Running tools..." during tool use. In group chats or on older API servers it falls back to a placeholder message updated via `editMessageText`. The final reply is sent with `sendMessage` (truncated to 4096 chars).

Image messages, image documents, and voice notes are downloaded under `server/.pager-data/media/`. Codex receives images through its native `--image` attachment option; audio is supplied as a local file path in the prompt so the agent can choose an available tool or workflow. Claude receives local attachment paths in the rendered prompt and Pager grants access to the media directory with `--add-dir`, allowing Claude to inspect or process the file with its tools.

Voice notes are not natively attached to the model because the supported Codex and Claude CLI entry points do not expose a direct audio attachment option. The receiving agent must choose how to process the downloaded audio file; successful understanding depends on tools available in its environment.

Use `"sessionMode": "per_event"` when each Telegram message should start a fresh agent session. Use `"single_thread"` when the chat should keep one running agent session across messages.

## `sourceConfig` fields

| Field | Notes |
| ----- | ----- |
| `botToken` | Bot token from BotFather. Falls back to `PAGER_TELEGRAM_BOT_TOKEN`, then `TELEGRAM_BOT_TOKEN`. |
| `chatId` | Chat to monitor. Falls back to `PAGER_TELEGRAM_CHAT_ID`, then `TELEGRAM_CHAT_ID`. |
| `apiBaseUrl` | Override the Telegram API base URL. Defaults to `https://api.telegram.org`. |
| `pollTimeoutSeconds` | Long-poll timeout. Defaults to `20`. |

Updates are filtered to messages and channel posts sent by humans (not bots) whose `chat.id` matches `chatId`. Messages without text, captions, a supported image attachment, or a voice note, and messages from other chats, are ignored.

Pager persists `nextUpdateOffset` as handler source state so it does not re-process the same update after a restart. This operational state is separate from editable `sourceConfig`.
