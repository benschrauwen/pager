# Composio trigger setup

This walks through creating a Composio trigger that Pager can listen to, end-to-end. It assumes the Composio CLI is installed and you are logged in (see [SKILL.md](../SKILL.md) prerequisites).

Authentication is owned by the Composio CLI session. Before configuring a
trigger, confirm it with:

```sh
composio login
composio whoami
```

For non-interactive use, authenticate with:

```sh
composio login --user-api-key "$COMPOSIO_USER_API_KEY" --org "$COMPOSIO_ORG"
```

## Concepts

Composio trigger setup has three independent layers. Keep them distinct.

- **Trigger instance** — persistent state in your Composio project (`ti_...`). Created by `composio dev triggers create ...` (or the upsert API). Poll-based triggers keep running in Composio even when no local listener is attached.
- **Listener process** — a local `composio dev listen ... --json` process that prints events while it runs. Pager starts and stops this per-handler.
- **Pager handler** — local config stored in `server/.pager-data/store.json`. It owns the prompt and the Composio listener filters.

Stopping a Pager handler does not stop the trigger instance. Deleting a Pager handler does not delete the trigger instance.

## 0. Initialise a dev project

Run once per Composio project directory:

```sh
cd /path/to/composio-project
composio dev init -y
```

Pager runs `composio dev listen` from this directory. The handler's `projectCwd` (or `PAGER_COMPOSIO_PROJECT_CWD`, or Pager's global Settings `cwd`) must point at a directory containing `.composio/project.json`.

## 1. Pick a trigger type

```sh
composio dev triggers list gmail
composio dev triggers info GMAIL_NEW_GMAIL_MESSAGE
```

`triggers info` prints the expected config schema. Use it instead of guessing fields.

### Gmail: prefer `query` over `labelIds`

For any Gmail trigger that the agent may reply to, use a Gmail search `query` so self-sent mail, agent replies, and test-account messages do not re-enter Pager as new work:

```json
{
  "userId": "me",
  "query": "in:inbox -from:CONNECTED_INBOX@example.com -from:AGENT_SENDER@example.com",
  "interval": 2
}
```

- `CONNECTED_INBOX@example.com` — the Gmail account linked through Composio.
- `AGENT_SENDER@example.com` — any account the agent uses to send replies, or test accounts to ignore.
- `interval` is in minutes.

`query` takes precedence over `labelIds`. Threaded replies often carry both `SENT` and `INBOX` labels, so `labelIds: INBOX` alone re-triggers on replies.

## 2. Create or reuse an auth config

```sh
composio dev auth-configs list --toolkits gmail --limit 10
```

Create one if needed:

```sh
composio dev auth-configs create --toolkit gmail pager-gmail
```

Save the returned `ac_...`.

## 3. Link a connected account

Find the project test user ID in `.composio/project.json`, then:

```sh
composio dev connected-accounts link gmail \
  --auth-config ac_... \
  --user-id pg-test-...
```

Open the returned Connect URL if printed. After authorisation, confirm:

```sh
composio dev connected-accounts list --toolkits gmail --status ACTIVE --limit 10
composio dev connected-accounts info ca_...
composio dev connected-accounts whoami ca_...
```

Save the returned `ca_...`.

## 4. Create the trigger instance

```sh
composio dev triggers create \
  --connected-account-id ca_... \
  --trigger-config '{"userId":"me","query":"in:inbox -from:CONNECTED_INBOX@example.com -from:AGENT_SENDER@example.com","interval":2}' \
  GMAIL_NEW_GMAIL_MESSAGE
```

Use the real connected inbox and real sender addresses; do not copy the placeholder values.

Confirm the trigger is active:

```sh
composio dev triggers status --toolkits gmail --limit 10
```

Save the returned `ti_...`.

## 5. Smoke-test the listener

```sh
composio dev listen --trigger-id ti_... --json --max-events 1
```

For Gmail, send a new message to the linked account. Delivery is poll-based, so it can take up to the configured `interval` minutes.

If the listener immediately reports `Invalid or revoked user API key` or
`HTTP_Unauthorized`, authenticate the CLI again with `composio login`, verify
with `composio whoami`, and rerun this smoke test before starting Pager.

## 6. Register the Pager handler

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

Pager now runs `composio dev listen --json --trigger-id ti_...` in the background and creates an agent session per event.

Set `"sessionMode": "single_thread"` when all events for this handler should continue one agent session instead of creating a fresh agent session for each event.

### `sourceConfig` fields

| Field | Required | Notes |
| ----- | -------- | ----- |
| `triggerId` | one of these three | Preferred. Targets exactly one trigger instance (`ti_...`). |
| `triggerSlug` | | Trigger type filter (e.g. `GMAIL_NEW_GMAIL_MESSAGE`). |
| `toolkits` | | Comma-separated toolkit filter (e.g. `gmail,slack`). |
| `connectedAccountId` | optional | Restrict to a single `ca_...`. |
| `userId` | optional | Restrict to a single Composio project user. |
| `command` | optional | Path to the `composio` CLI. Defaults to `PAGER_COMPOSIO_COMMAND`, then `COMPOSIO_COMMAND`, then `composio`. |
| `projectCwd` | optional | Directory containing `.composio/project.json`. Defaults to `PAGER_COMPOSIO_PROJECT_CWD`, then `COMPOSIO_PROJECT_CWD`, then global Settings `cwd`. |

At least one of `triggerId`, `triggerSlug`, or `toolkits` is required. Prefer `triggerId` so the listener cannot match the wrong stream.

## Event shape

Composio emits one JSON object per event. Pager exposes the full payload as `{{eventJson}}` and renders a compact summary as `{{eventText}}` using common fields (trigger slug, subject, sender, recipient, timestamp, message text/body) when present.

## Avoid trigger buildup

Before creating a new trigger, list existing ones and reuse a matching trigger:

```sh
composio dev triggers status --toolkits gmail --show-disabled --limit 50
```

Filter by known IDs when narrowing:

```sh
composio dev triggers status \
  --trigger-ids ti_... \
  --show-disabled \
  --limit 10
```

To temporarily stop listening, disable instead of deleting:

```sh
composio dev triggers disable ti_...
composio dev triggers enable ti_...
```

Delete only when the subscription is no longer needed. Deletion is permanent:

```sh
composio dev triggers delete ti_...
```

If the installed CLI does not expose a delete command, use the Composio dashboard or API. Removing a Pager handler does not clean up Composio state.

## Operational checklist

When adding or changing a Composio trigger handler:

1. Inspect existing trigger instances with `composio dev triggers status --show-disabled`.
2. Reuse an existing `ti_...` when it already matches the app, connected account, user, and trigger config.
3. Create a new trigger only when nothing matches.
4. Put the chosen `ti_...` into the Pager handler's `triggerId`.
5. Pause the Pager handler to stop local routing.
6. Disable the Composio trigger to stop remote polling.
7. Delete the Composio trigger when the project should no longer retain that subscription.
