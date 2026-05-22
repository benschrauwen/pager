---
name: pager
description: Set up and operate Pager, a local Node.js server with browser UI that pages a local agent CLI (codex or claude) in response to Composio trigger events and Telegram messages, and stores each run as an inspectable session. Use when the user wants to wire Composio triggers (Gmail, Slack, GitHub, etc.) or a Telegram bot to a Claude or Codex agent, install or start the Pager server, add or edit event handlers, set up Composio auth configs and trigger instances, or review agent sessions produced from incoming events.
---

# Pager

Pager pages a local agent CLI when something happens elsewhere:

- Listens for events from configured sources (Composio triggers, Telegram).
- Renders each event through a per-handler prompt template.
- Runs `codex` or `claude` with that prompt and stores the resulting session.
- Serves a browser UI at `http://127.0.0.1:4111` for review.

Pager is not an agent framework. It only schedules events into an already-installed agent CLI.

The runnable code lives in [server/](server/). Humans use the browser UI; agents drive Pager through its REST API.

## Prerequisites

1. **Node.js 18+**.

2. **At least one agent CLI**, installed and authenticated:

   ```sh
   npm install -g @openai/codex
   npm install -g @anthropic-ai/claude-code
   ```

   Override the command with `CODEX_COMMAND` or `CLAUDE_COMMAND` if it is not on `PATH`.

3. **A Composio account** (only for Composio triggers).

   Sign up at https://app.composio.dev/, then install and log in to the CLI:

   ```sh
   curl -fsSL https://composio.dev/install | bash
   export PATH="$HOME/.composio:$PATH"
   composio login
   composio whoami
   ```

   For non-interactive setup with provided credentials:

   ```sh
   composio login --user-api-key "$COMPOSIO_USER_API_KEY" --org "$COMPOSIO_ORG"
   ```

   If `composio` is not on `PATH`, set `PAGER_COMPOSIO_COMMAND="$HOME/.composio/composio"` before starting the server.

## Start the server

```sh
cd server
npm start
```

Open `http://127.0.0.1:4111` in a browser, or drive the server through its REST API (see [reference/api.md](reference/api.md)).

State is persisted to `server/.pager-data/store.json`.

## Configure once

Pick the agent CLI Pager should run, the model, and the working directory used for every agent run.

Via UI: edit the Settings panel in the sidebar.

Via API:

```sh
curl -X PUT http://127.0.0.1:4111/api/settings \
  -H 'content-type: application/json' \
  -d '{
    "provider": "codex",
    "model": "",
    "cwd": "/path/to/project",
    "bypassPermissions": true
  }'
```

`provider` is `codex` or `claude`. `cwd` must be an existing directory. `model` may be empty to use the CLI default.

## Add a Composio trigger handler

Follow [reference/composio-trigger-setup.md](reference/composio-trigger-setup.md) end-to-end the first time. It walks through:

1. Initialise a Composio dev project (`composio dev init -y`).
2. Inspect trigger types and pick one.
3. Create or reuse an auth config and a connected account.
4. Create the trigger instance (a `ti_...` ID).
5. Smoke-test the listener with `composio dev listen --trigger-id ti_... --json --max-events 1`.
6. Register a Pager handler with that `ti_...`.

Once the `ti_...` exists, create the handler:

```sh
curl -X POST http://127.0.0.1:4111/api/handlers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Incoming Gmail",
    "source": "composio_trigger",
    "enabled": true,
    "sessionMode": "per_event",
    "prompt": "Handle this Composio event: {{eventText}}\n\nFull event:\n{{eventJson}}",
    "sourceConfig": {
      "triggerId": "ti_...",
      "projectCwd": "/path/to/composio-project"
    }
  }'
```

Pager starts `composio dev listen --json --trigger-id ti_...` in the background, parses each emitted event, and runs the configured agent CLI per event.

`sessionMode` may be:

- `per_event` — create a new Pager session and agent session for every event.
- `single_thread` — keep all events for this handler in one Pager session and resume the same agent session for each event when the selected provider supports session resume.

## Add a Telegram handler (optional)

See [reference/telegram-setup.md](reference/telegram-setup.md). Short version:

```sh
curl -X POST http://127.0.0.1:4111/api/handlers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Telegram triage",
    "source": "telegram",
    "enabled": true,
    "sessionMode": "single_thread",
    "prompt": "Handle this Telegram message: {{eventText}}",
    "sourceConfig": { "botToken": "123:abc", "chatId": "123456789" }
  }'
```

## Test a handler

```sh
curl -X POST http://127.0.0.1:4111/api/handlers/<HANDLER_ID>/test \
  -H 'content-type: application/json' \
  -d '{ "text": "Manual test event" }'
```

This runs the handler prompt against the supplied text, creates a fresh session, and returns its ID.

## Inspect handlers and sessions

- UI: pick a handler in the sidebar to see its sessions and full message transcripts.
- API: `GET /api/state` for handler status and recent sessions; `GET /api/sessions/<id>` for a single transcript.

Full API reference: [reference/api.md](reference/api.md).

## Prompt template variables

Handler prompts may reference:

- `{{source}}` — internal source ID (`telegram`, `composio_trigger`).
- `{{sourceLabel}}` — display label.
- `{{handlerName}}` — the handler's name.
- `{{eventText}}` — concise text rendering of the event.
- `{{eventJson}}` — full event payload as JSON.

## Trigger lifecycle (important)

A Pager handler is local-only state. A Composio trigger instance (`ti_...`) lives in Composio and can keep polling even when Pager is stopped or the handler is deleted. To fully stop a trigger, disable or delete it in Composio:

```sh
composio dev triggers disable ti_...
composio dev triggers delete ti_...
```

Always inspect existing triggers before creating a new one:

```sh
composio dev triggers status --toolkits gmail --show-disabled --limit 50
```

## Troubleshooting

- `composio: command not found` — add `$HOME/.composio` to `PATH`, or set `PAGER_COMPOSIO_COMMAND`.
- `No developer project configured` — run `composio dev init -y` inside the handler's `projectCwd`.
- No trigger events — confirm the trigger is `ACTIVE` (`composio dev triggers status`) and try the listener manually with `composio dev listen --trigger-id ti_... --json --max-events 1`. Gmail triggers poll on a configured interval (minutes); delivery is not instant.
- Handler stays in `lastError` — read `handler.lastError` in `GET /api/state` and inspect the Pager server logs.

## Where things live

| Path | Purpose |
| ---- | ------- |
| `server/server.js` | HTTP server, REST API, handler runtime. |
| `server/public/` | Browser UI (vanilla JS, no build step). |
| `server/.pager-data/store.json` | Persisted settings, handlers, sessions. |
| `reference/composio-trigger-setup.md` | Full Composio trigger creation walkthrough. |
| `reference/telegram-setup.md` | Telegram bot handler fields and env fallback. |
| `reference/api.md` | Full REST API reference. |
