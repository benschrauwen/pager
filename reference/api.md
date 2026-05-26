# Pager REST API

The browser UI uses this API. Agents should use it too. Default base URL:

```text
http://127.0.0.1:4111
```

All bodies are JSON.

## Read current state

```sh
curl http://127.0.0.1:4111/api/state
```

Response fields:

- `settings` — global framework, model, directory, and permission settings.
- `handlers` — configured event handlers, each augmented with `sourceLabel` and `running`.
- `sessions` — sessions created by handlers, newest first.
- `providers` — available CLI providers (`codex`, `claude`).
- `sourceLabels` — available event source IDs and display labels.

`GET /api/state` is the simplest way to check whether handlers are listening, whether they have errors, and whether new sessions arrived. Poll it during setup.

## Configure the agent CLI

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

- `provider` must be `codex` or `claude`.
- `cwd` must be an existing directory.
- `model` may be `""` to use the CLI default.
- `bypassPermissions` controls non-interactive permission flags on the CLI.

## Create a handler

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
      "triggerId": "ti_..."
    }
  }'
```

`source` is `composio_trigger` or `telegram`. See [composio-trigger-setup.md](composio-trigger-setup.md) and [telegram-setup.md](telegram-setup.md) for `sourceConfig` fields.

`sessionMode` controls how events are grouped:

| Value | Behavior |
| ----- | -------- |
| `per_event` | Default. Every event creates a new Pager session and a fresh agent session. |
| `single_thread` | All events for this handler append to one Pager session and resume the same agent session. Works with both `codex` and `claude`. |

## Update or disable a handler

```sh
curl -X PUT http://127.0.0.1:4111/api/handlers/HANDLER_ID \
  -H 'content-type: application/json' \
  -d '{
    "name": "Incoming Gmail",
    "source": "composio_trigger",
    "enabled": false,
    "sessionMode": "per_event",
    "prompt": "Handle this Composio event: {{eventText}}",
    "sourceConfig": { "triggerId": "ti_..." }
  }'
```

PUT replaces the handler's editable fields. Include the current `source`, `prompt`, and `sourceConfig` even when changing only one setting.

## Delete a handler

```sh
curl -X DELETE http://127.0.0.1:4111/api/handlers/HANDLER_ID
```

This stops the handler's runtime. Existing sessions stay in the store but disappear from `/api/state` because their owning handler is gone. It does not touch Composio trigger instances.

## Test a handler

```sh
curl -X POST http://127.0.0.1:4111/api/handlers/HANDLER_ID/test \
  -H 'content-type: application/json' \
  -d '{ "text": "Test event" }'
```

Creates a fresh session and runs the agent CLI with the handler's prompt rendered against the supplied text.

## Read a session transcript

```sh
curl http://127.0.0.1:4111/api/sessions/SESSION_ID
```

Response includes the session summary plus `messages`: the rendered event prompt and the assistant response, each with metadata (model, usage, cost, exit code, stderr).

## Agent workflow

1. `GET /api/state` — inspect `settings`, `handlers`, `sourceLabels`.
2. `PUT /api/settings` if provider, model, or `cwd` is wrong.
3. Set up the Composio trigger (`composio dev ...`) and test it with `composio dev listen --json --max-events 1`.
4. `POST /api/handlers` to add the handler, or `PUT /api/handlers/:id` to change it.
5. `POST /api/handlers/:id/test` to confirm the handler creates a session.
6. Poll `GET /api/state` to watch `handlers[].running`, `handlers[].lastError`, `handlers[].lastEventAt`, and new `sessions`.
7. Fetch interesting transcripts with `GET /api/sessions/:id`.
