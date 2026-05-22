# Pager

Pager is an agent skill. It sets up a tiny local server (in [`server/`](server/)) that pages a local agent CLI (`codex` or `claude`) in response to Composio trigger events and Telegram messages, and exposes a browser UI for reviewing the resulting sessions.

The full agent-facing instructions live in [SKILL.md](SKILL.md). Reference docs:

- [reference/composio-trigger-setup.md](reference/composio-trigger-setup.md) — end-to-end Composio trigger creation.
- [reference/telegram-setup.md](reference/telegram-setup.md) — Telegram bot handler config.
- [reference/api.md](reference/api.md) — REST API for agents.

To run the server yourself:

```sh
cd server
npm start
```

Then open `http://127.0.0.1:4111`.

Handlers can either create a new agent session for every event or keep all events in one agent session by setting `sessionMode` to `per_event` or `single_thread`.
