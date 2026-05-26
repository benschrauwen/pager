# Pager

<p align="center">
  <img src="assets/pager-hero.png" alt="Pixel-art Claude mascot proudly holding up a 90s pager that reads INCOMING!" width="640">
</p>

Page your local agent when something happens elsewhere.

Pager is a skill that includes a small Node.js server that listens for external events — Composio triggers (Gmail, Slack, GitHub, Linear, …) and Telegram messages — renders each event through a prompt template, and runs your local `codex` or `claude` CLI against it. Every run is stored as an inspectable session you can browse from a built-in web UI or query through a REST API.

It is packaged as an agent skill ([SKILL.md](SKILL.md)), so an agent like Claude or Codex can install, configure, and operate Pager on your behalf.

## Why

You already have a capable coding agent installed locally. Pager gives it a doorbell.

Some things people wire up:

- Triage incoming Gmail or GitHub issues into a long-running agent session.
- Forward Telegram messages to an agent that can act on your repo.
- Run a small action whenever a Linear ticket changes state.
- Keep a single "assistant" thread alive across many small events.

Pager is intentionally not an agent framework. It only schedules events into an already-installed agent CLI and keeps the resulting transcripts.

## How it works

```
event source ──▶ handler ──▶ prompt template ──▶ codex / claude ──▶ session
(Composio,        (per-event   ({{eventText}},     (your local CLI,    (stored,
 Telegram)         or single    {{eventJson}}, …)   your model,         browsable)
                   thread)                          your cwd)
```

- **Sources.** Composio dev triggers and Telegram bots, today. Each source has its own listener inside the server. Telegram handlers are two-way: the agent's reply is posted back into the same chat.
- **Handlers.** Local configuration: which source, which prompt, `per_event` or `single_thread` session mode.
- **Provider.** You choose `codex` or `claude`, the model, and the working directory each run uses.
- **Sessions.** Handler config and a session index live in `server/.pager-data/store.json`; each run’s full transcript is in `server/.pager-data/sessions/<id>.json`.

## Quick start

Requirements: Node.js 18+, and at least one agent CLI installed and authenticated (`@openai/codex` or `@anthropic-ai/claude-code`). For Composio triggers you also need a [Composio](https://app.composio.dev/) account and the `composio` CLI authenticated through `composio login`.

Pager runs the authenticated `composio` CLI for trigger listeners. Authenticate
or refresh that CLI session with `composio login` and verify it with
`composio whoami`.

Start the server:

```sh
cd server
npm start
```

Open `http://127.0.0.1:4111` to use the UI, or talk to it directly:

```sh
# Pick a provider, model, and working directory for agent runs.
curl -X PUT http://127.0.0.1:4111/api/settings \
  -H 'content-type: application/json' \
  -d '{ "provider": "codex", "cwd": "/path/to/project", "bypassPermissions": true }'

# Wire up a handler — here, a Composio trigger you already created.
curl -X POST http://127.0.0.1:4111/api/handlers \
  -H 'content-type: application/json' \
  -d '{
    "name": "Incoming Gmail",
    "source": "composio_trigger",
    "enabled": true,
    "sessionMode": "per_event",
    "prompt": "Handle this event: {{eventText}}\n\nFull event:\n{{eventJson}}",
    "sourceConfig": { "triggerId": "ti_...", "projectCwd": "/path/to/composio-project" }
  }'
```

Each event Pager observes from that source will now spawn (or resume) an agent session in the directory you configured.

## Session modes

- `per_event` — fresh Pager session and fresh agent session for every event. Good for independent tickets, messages, or alerts.
- `single_thread` — one long-running Pager session per handler that resumes the same agent session across events. Good for chat-style relationships with a source.

## Use it as an agent skill

The repository's [SKILL.md](SKILL.md) is written for agents. If you point Claude or Codex at this folder, an agent can:

- Install dependencies and start the server.
- Walk through Composio trigger creation end-to-end.
- Add, edit, test, and inspect handlers.
- Open sessions and read their transcripts.

The same REST API powers the UI and the skill, so anything you can do in the browser an agent can do over HTTP.

## Layout

| Path | Purpose |
| ---- | ------- |
| [`SKILL.md`](SKILL.md) | Agent-facing instructions. |
| [`server/`](server/) | HTTP server, REST API, and browser UI. |
| [`reference/api.md`](reference/api.md) | Full REST API reference. |
| [`reference/composio-trigger-setup.md`](reference/composio-trigger-setup.md) | Composio trigger creation walkthrough. |
| [`reference/telegram-setup.md`](reference/telegram-setup.md) | Telegram bot handler configuration. |

## Status

Pager is small, opinionated, and built around a single workflow: get an event in, get an agent run out, keep the receipt. It is happily used in personal setups; if you try it for something more ambitious, expect rough edges and feel free to open an issue.
