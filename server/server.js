import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, ".pager-data");
const storePath = path.join(dataDir, "store.json");
const sessionsDir = path.join(dataDir, "sessions");
const port = Number(process.env.PORT || 4111);
const host = process.env.HOST || "127.0.0.1";
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TELEGRAM_STREAM_THROTTLE_MS = 800;
const TELEGRAM_DRAFT_KEEPALIVE_MS = 25_000;

const providers = {
  codex: { label: "Codex", command: process.env.CODEX_COMMAND || "codex" },
  claude: { label: "Claude", command: process.env.CLAUDE_COMMAND || "claude" },
};

const sourceLabels = {
  telegram: "Telegram",
  composio_trigger: "Composio trigger",
};

const defaultSettings = {
  provider: "codex",
  cwd: process.cwd(),
  model: "",
  bypassPermissions: true,
};

const defaultHandlerPrompt = [
  "Handle this incoming event from {{sourceLabel}}.",
  "Keep the response concise and useful.",
  "",
  "Event:",
  "{{eventText}}",
].join("\n");

const telegramRunners = new Map();
const composioRunners = new Map();
const handlerRunQueues = new Map();

const sessionModes = {
  per_event: "New session per event",
  single_thread: "Single agent session",
};

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clampText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

async function validateCwd(cwd) {
  const resolved = cwd && String(cwd).trim() ? path.resolve(String(cwd).trim()) : process.cwd();
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    const error = new Error(`Working directory not found: ${resolved}`);
    error.code = "cwd_not_found";
    throw error;
  }
  return resolved;
}

function normalizeHandler(input = {}) {
  const source = sourceLabels[input.source] ? input.source : "telegram";
  const sessionMode = sessionModes[input.sessionMode] ? input.sessionMode : "per_event";
  const createdAt = typeof input.createdAt === "string" ? input.createdAt : nowIso();
  return {
    id: typeof input.id === "string" ? input.id : randomUUID(),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : sourceLabels[source],
    source,
    enabled: input.enabled === true,
    sessionMode,
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : defaultHandlerPrompt,
    sourceConfig: input.sourceConfig && typeof input.sourceConfig === "object" ? input.sourceConfig : {},
    createdAt,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : createdAt,
    lastEventAt: typeof input.lastEventAt === "string" ? input.lastEventAt : null,
    lastError: typeof input.lastError === "string" ? input.lastError : null,
    running: false,
  };
}

function normalizeSessionIndex(entry = {}) {
  return {
    id: typeof entry.id === "string" ? entry.id : randomUUID(),
    handlerId: typeof entry.handlerId === "string" ? entry.handlerId : null,
    source: entry.source || "event",
    name: typeof entry.name === "string" ? entry.name : "Session",
    provider: providers[entry.provider] ? entry.provider : defaultSettings.provider,
    cwd: typeof entry.cwd === "string" ? entry.cwd : defaultSettings.cwd,
    model: typeof entry.model === "string" ? entry.model : "",
    sessionMode: sessionModes[entry.sessionMode] ? entry.sessionMode : "per_event",
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso(),
    messageCount: Number.isInteger(entry.messageCount) ? entry.messageCount : 0,
    latestPreview: typeof entry.latestPreview === "string" ? entry.latestPreview : "",
  };
}

function normalizeStore(parsed = {}) {
  return {
    settings: {
      ...defaultSettings,
      ...(parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {}),
    },
    handlers: Array.isArray(parsed.handlers) ? parsed.handlers.map(normalizeHandler) : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSessionIndex) : [],
  };
}

function sessionFilePath(sessionId) {
  return path.join(sessionsDir, `${sessionId}.json`);
}

let writeChain = Promise.resolve();

function enqueueWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

async function loadStore() {
  await fs.mkdir(sessionsDir, { recursive: true });
  try {
    return normalizeStore(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeStore({});
    throw error;
  }
}

async function saveStore(store) {
  await enqueueWrite(() => writeJsonAtomic(storePath, normalizeStore(store)));
}

function normalizeSessionRecord(session = {}) {
  const index = normalizeSessionIndex(session);
  return {
    ...index,
    bypassPermissions: session.bypassPermissions !== false,
    cliSessionId: typeof session.cliSessionId === "string" ? session.cliSessionId : null,
    event: session.event && typeof session.event === "object" ? session.event : null,
    messages: Array.isArray(session.messages) ? session.messages : [],
  };
}

async function loadSession(sessionId) {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionFilePath(sessionId), "utf8"));
    return normalizeSessionRecord(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function sessionIndexEntry(session) {
  return normalizeSessionIndex(publicSession(session));
}

function upsertSessionIndex(store, session) {
  const entry = sessionIndexEntry(session);
  const index = store.sessions.findIndex((item) => item.id === entry.id);
  if (index === -1) store.sessions.push(entry);
  else store.sessions[index] = entry;
}

async function saveSession(session) {
  const record = normalizeSessionRecord(session);
  await enqueueWrite(async () => {
    await writeJsonAtomic(sessionFilePath(record.id), record);
    const store = await loadStore();
    upsertSessionIndex(store, record);
    await writeJsonAtomic(storePath, normalizeStore(store));
  });
}

function publicSession(session) {
  const latest = session.messages?.at(-1);
  return {
    id: session.id,
    handlerId: session.handlerId || null,
    source: session.source || "event",
    name: session.name,
    provider: session.provider,
    cwd: session.cwd,
    model: session.model || "",
    sessionMode: sessionModes[session.sessionMode] ? session.sessionMode : "per_event",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages)
      ? session.messages.length
      : (Number.isInteger(session.messageCount) ? session.messageCount : 0),
    latestPreview: latest?.content?.slice(0, 140) || session.latestPreview || "",
  };
}

function publicHandler(handler) {
  return {
    ...handler,
    sessionModeLabel: sessionModes[handler.sessionMode] || sessionModes.per_event,
    sourceLabel: sourceLabels[handler.source] || handler.source,
    running: Boolean(
      (handler.source === "telegram" && telegramRunners.has(handler.id)) ||
      (handler.source === "composio_trigger" && composioRunners.has(handler.id)),
    ),
  };
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { error: "not_found" });
}

function buildCodexArgs(session, options = {}) {
  const args = ["exec"];
  if (options.resumeCliSessionId) args.push("resume");
  args.push("--json");
  if (session.model) args.push("--model", session.model);
  if (session.bypassPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
  if (options.resumeCliSessionId) args.push(options.resumeCliSessionId);
  args.push("-");
  return args;
}

function buildClaudeArgs(session, options = {}) {
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (options.resumeCliSessionId) args.push("--resume", options.resumeCliSessionId);
  if (session.bypassPermissions) args.push("--dangerously-skip-permissions");
  if (session.model) args.push("--model", session.model);
  return args;
}

function parseCodex(stdout) {
  let cliSessionId = null;
  let assistant = "";
  let error = "";
  const usage = {};

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "thread.started" && event.thread_id) cliSessionId = event.thread_id;
    if (event.type === "item.completed" && event.item?.type === "agent_message") assistant = event.item.text || assistant;
    if (event.type === "turn.completed" && event.usage) {
      usage.inputTokens = event.usage.input_tokens;
      usage.cachedInputTokens = event.usage.cached_input_tokens;
      usage.outputTokens = event.usage.output_tokens;
    }
    if (event.type === "error" && event.message) error = event.message;
  }

  return { cliSessionId, assistant: assistant.trim(), error, usage };
}

function parseClaude(stdout) {
  let cliSessionId = null;
  let model = "";
  let result = "";
  const assistantParts = [];
  let usage = {};
  let costUsd = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.session_id) cliSessionId = event.session_id;
    if (event.model) model = event.model;
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block?.type === "text" && block.text) assistantParts.push(block.text);
      }
    }
    if (event.type === "result") {
      result = event.result || "";
      if (event.usage) {
        usage = {
          inputTokens: event.usage.input_tokens,
          cachedInputTokens: event.usage.cache_read_input_tokens,
          outputTokens: event.usage.output_tokens,
        };
      }
      if (typeof event.total_cost_usd === "number") costUsd = event.total_cost_usd;
    }
  }

  return { cliSessionId, model, assistant: (result || assistantParts.join("\n\n")).trim(), usage, costUsd };
}

function createCliStreamState(provider) {
  return { provider, lineBuffer: "", assistantText: "", phase: "thinking", toolLabel: null };
}

function codexItemType(item) {
  return item?.type || item?.item_type || "";
}

function summarizeCodexCommand(command) {
  const value = String(command || "").trim();
  if (!value) return null;
  const match = value.match(/^(?:bash\s+-lc\s+)?(\S+)/);
  return match?.[1] || value.slice(0, 32);
}

function updateCodexStreamState(state, event) {
  const item = event.item;
  const itemType = codexItemType(item);
  const activeItemTypes = new Set(["command_execution", "mcp_tool_call", "web_search", "file_change"]);

  if (event.type === "turn.started") {
    state.phase = "thinking";
    state.toolLabel = null;
    return;
  }

  if (itemType === "reasoning") {
    state.phase = "thinking";
    return;
  }

  const toolInProgress =
    (event.type === "item.started" || event.type === "item.updated") &&
    activeItemTypes.has(itemType) &&
    item.status !== "completed" &&
    item.status !== "failed";

  if (toolInProgress) {
    state.phase = "tools";
    if (itemType === "command_execution") state.toolLabel = summarizeCodexCommand(item.command) || "command";
    else if (itemType === "mcp_tool_call") state.toolLabel = item.tool || item.name || "tool";
    else if (itemType === "web_search") state.toolLabel = "web search";
    else state.toolLabel = itemType.replaceAll("_", " ");
    return;
  }

  if (itemType === "agent_message" || itemType === "assistant_message") {
    if (item.text) {
      state.assistantText = item.text;
      state.phase = "text";
      state.toolLabel = null;
    }
  }
}

function updateClaudeStreamState(state, event) {
  if (event.type === "tool_use") {
    state.phase = "tools";
    state.toolLabel = event.name || "tool";
    return;
  }

  if (event.type === "stream_event") {
    const inner = event.event;
    if (inner?.type === "content_block_start") {
      const blockType = inner.content_block?.type;
      if (blockType === "tool_use") {
        state.phase = "tools";
        state.toolLabel = inner.content_block?.name || "tool";
        return;
      }
      if (blockType === "text") {
        state.phase = "thinking";
      }
    }
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
      state.assistantText += inner.delta.text;
      state.phase = "text";
      state.toolLabel = null;
    }
    return;
  }

  if (event.type === "assistant") {
    const parts = [];
    let hasTool = false;
    let toolName = null;
    for (const block of event.message?.content || []) {
      if (block?.type === "text" && block.text) parts.push(block.text);
      if (block?.type === "tool_use") {
        hasTool = true;
        toolName = block.name || toolName;
      }
    }
    if (hasTool) {
      state.phase = "tools";
      state.toolLabel = toolName || "tool";
      return;
    }
    if (parts.length) {
      state.assistantText = parts.join("\n\n");
      state.phase = "text";
      state.toolLabel = null;
    }
  }

  if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
    state.assistantText += event.delta.text;
    state.phase = "text";
    state.toolLabel = null;
  }
}

function consumeCliStreamChunk(state, chunk, onStream) {
  state.lineBuffer += chunk;
  const lines = state.lineBuffer.split(/\r?\n/);
  state.lineBuffer = lines.pop() || "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (state.provider === "claude") updateClaudeStreamState(state, event);
    else updateCodexStreamState(state, event);
    onStream?.({
      text: state.assistantText,
      phase: state.phase,
      toolLabel: state.toolLabel,
    });
  }
}

function runCli(session, prompt, options = {}) {
  const provider = providers[session.provider];
  const args = session.provider === "claude" ? buildClaudeArgs(session, options) : buildCodexArgs(session, options);
  const onStream = typeof options.onStream === "function" ? options.onStream : null;
  const streamState = onStream ? createCliStreamState(session.provider) : null;

  return new Promise((resolve) => {
    const child = spawn(provider.command, args, {
      cwd: session.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      if (streamState) consumeCliStreamChunk(streamState, text, onStream);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      resolve({ ok: false, exitCode: null, stdout, stderr, error: error.message, parsed: {} });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      const parsed = session.provider === "claude" ? parseClaude(stdout) : parseCodex(stdout);
      const error = parsed.error || (code === 0 ? "" : stderr.trim());
      resolve({ ok: code === 0 && !error, exitCode: code, signal, stdout, stderr, error, parsed });
    });
    child.stdin.end(prompt);
  });
}

function renderPrompt(template, event, handler) {
  const sourceLabel = sourceLabels[handler.source] || handler.source;
  const eventJson = JSON.stringify(event, null, 2);
  return String(template || defaultHandlerPrompt)
    .replaceAll("{{source}}", handler.source)
    .replaceAll("{{sourceLabel}}", sourceLabel)
    .replaceAll("{{handlerName}}", handler.name)
    .replaceAll("{{eventText}}", event.text || eventJson)
    .replaceAll("{{eventJson}}", eventJson);
}

async function createEventSession(handler, event, options = {}) {
  const store = await loadStore();
  const settings = store.settings;
  const cwd = await validateCwd(settings.cwd);
  const startedAt = nowIso();
  const singleThread = handler.sessionMode === "single_thread";
  let session = null;
  if (singleThread) {
    const handlerSessions = store.sessions
      .filter((entry) => entry.handlerId === handler.id)
      .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
    for (const entry of handlerSessions) {
      const loaded = await loadSession(entry.id);
      if (loaded?.sessionMode === "single_thread") {
        session = loaded;
        break;
      }
    }
  }
  if (!session) {
    session = {
      id: randomUUID(),
      handlerId: handler.id,
      source: handler.source,
      sessionMode: handler.sessionMode || "per_event",
      provider: settings.provider,
      name: singleThread ? `${handler.name} · ongoing` : `${handler.name} · ${new Date().toLocaleString()}`,
      cwd,
      model: settings.model || "",
      bypassPermissions: settings.bypassPermissions !== false,
      cliSessionId: null,
      createdAt: startedAt,
      updatedAt: startedAt,
      event,
      messages: [],
    };
  } else {
    if (session.provider !== settings.provider) {
      // Provider changed since the last run; the stored cliSessionId belongs
      // to a different CLI and cannot be resumed against the new one.
      session.cliSessionId = null;
    }
    session.provider = settings.provider;
    session.cwd = cwd;
    session.model = settings.model || "";
    session.bypassPermissions = settings.bypassPermissions !== false;
    session.event = event;
  }

  const prompt = renderPrompt(handler.prompt, event, handler);
  session.messages.push({
    id: randomUUID(),
    role: "event",
    content: prompt,
    createdAt: startedAt,
    meta: { event, handlerId: handler.id, source: handler.source },
  });

  const result = await runCli(session, prompt, {
    resumeCliSessionId: singleThread ? session.cliSessionId : null,
    onStream: options.onStream,
  });
  const finishedAt = nowIso();
  if (result.parsed.cliSessionId) session.cliSessionId = result.parsed.cliSessionId;
  const assistantContent =
    result.parsed.assistant ||
    (result.error ? `Command failed: ${result.error}` : result.stdout.trim()) ||
    "(No output)";
  session.messages.push({
    id: randomUUID(),
    role: "assistant",
    content: assistantContent,
    createdAt: finishedAt,
    meta: {
      ok: result.ok,
      exitCode: result.exitCode,
      signal: result.signal,
      cliSessionId: session.cliSessionId,
      model: result.parsed.model || session.model || null,
      usage: result.parsed.usage || null,
      costUsd: result.parsed.costUsd ?? null,
      stderr: result.stderr.trim() || null,
    },
  });
  session.updatedAt = finishedAt;

  await saveSession(session);
  const latestStore = await loadStore();
  const latestHandler = latestStore.handlers.find((entry) => entry.id === handler.id);
  if (latestHandler) {
    latestHandler.lastEventAt = finishedAt;
    latestHandler.lastError = result.ok ? null : result.error || "CLI run failed";
    latestHandler.updatedAt = finishedAt;
  }
  await saveStore(latestStore);
  return { session, result };
}

function enqueueEventSession(handler, event, options = {}) {
  const current = handlerRunQueues.get(handler.id) || Promise.resolve();
  const next = current
    .catch(() => {})
    .then(() => createEventSession(handler, event, options));
  const queued = next.finally(() => {
    if (handlerRunQueues.get(handler.id) === queued) handlerRunQueues.delete(handler.id);
  });
  handlerRunQueues.set(handler.id, queued);
  return next;
}

function resolveTelegramConfig(handler) {
  const config = handler.sourceConfig || {};
  const botToken = String(config.botToken || "").trim() || readEnv("PAGER_TELEGRAM_BOT_TOKEN", "HERMIT_TELEGRAM_BOT_TOKEN", "TELEGRAM_BOT_TOKEN");
  const chatId = String(config.chatId || "").trim() || readEnv("PAGER_TELEGRAM_CHAT_ID", "HERMIT_TELEGRAM_CHAT_ID", "TELEGRAM_CHAT_ID");
  if (!botToken || !chatId) return null;
  return {
    botToken,
    chatId,
    apiBaseUrl: String(config.apiBaseUrl || "").trim() || readEnv("PAGER_TELEGRAM_API_BASE_URL", "HERMIT_TELEGRAM_API_BASE_URL") || "https://api.telegram.org",
    pollTimeoutSeconds: parsePositiveInteger(config.pollTimeoutSeconds || readEnv("PAGER_TELEGRAM_POLL_TIMEOUT_SECONDS", "HERMIT_TELEGRAM_POLL_TIMEOUT_SECONDS"), 20),
    nextUpdateOffset: Number.isInteger(config.nextUpdateOffset) ? config.nextUpdateOffset : null,
  };
}

async function callTelegramApi(config, method, payload, options = {}) {
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

function formatTelegramProgressText({ text, phase, toolLabel }) {
  if (phase === "tools") {
    const label = String(toolLabel || "").trim();
    return label ? `Running ${label}…` : "Running tools…";
  }
  if (phase === "thinking") return "Thinking…";
  if (text?.trim()) return clampText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  return "Thinking…";
}

class TelegramProgress {
  constructor(config, { draftId } = {}) {
    this.config = config;
    this.draftId = Number.isInteger(draftId) && draftId > 0 ? draftId : Math.floor(Math.random() * 2_147_483_647) + 1;
    this.transport = null;
    this.messageId = null;
    this.lastSentText = null;
    this.lastUpdateAt = 0;
    this.pending = null;
    this.closed = false;
    this.latestStream = { text: "", phase: "thinking", toolLabel: null };
    this.throttleTimer = null;
  }

  async start() {
    try {
      await callTelegramApi(this.config, "sendMessageDraft", {
        chat_id: this.config.chatId,
        draft_id: this.draftId,
        text: "Thinking…",
      });
      this.transport = "draft";
      this.lastSentText = "Thinking…";
      this.lastUpdateAt = Date.now();
      return;
    } catch {
      // Groups and older API servers fall back to a placeholder message + edits.
    }

    const message = await callTelegramApi(this.config, "sendMessage", {
      chat_id: this.config.chatId,
      text: "Thinking…",
    });
    this.transport = "edit";
    this.messageId = message?.message_id || null;
    this.lastSentText = "Thinking…";
    this.lastUpdateAt = Date.now();
  }

  update(stream) {
    if (this.closed || !this.transport) return;
    this.latestStream = stream;
    this.scheduleUpdate();
  }

  scheduleUpdate() {
    if (this.closed || !this.transport) return;
    if (this.throttleTimer) return;

    const display = formatTelegramProgressText(this.latestStream);
    const now = Date.now();
    const keepaliveDue = this.transport === "draft" && now - this.lastUpdateAt >= TELEGRAM_DRAFT_KEEPALIVE_MS;
    const throttleDue = now - this.lastUpdateAt >= TELEGRAM_STREAM_THROTTLE_MS;

    if (!keepaliveDue && display === this.lastSentText) return;
    if (!keepaliveDue && !throttleDue) {
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null;
        this.scheduleUpdate();
      }, TELEGRAM_STREAM_THROTTLE_MS - (now - this.lastUpdateAt));
      return;
    }

    if (this.pending) return;

    this.pending = this.flushUpdate(display)
      .finally(() => {
        this.pending = null;
        this.scheduleUpdate();
      });
  }

  async flushUpdate(display) {
    try {
      if (this.transport === "draft") {
        await callTelegramApi(this.config, "sendMessageDraft", {
          chat_id: this.config.chatId,
          draft_id: this.draftId,
          text: display,
        });
      } else if (this.messageId) {
        await callTelegramApi(this.config, "editMessageText", {
          chat_id: this.config.chatId,
          message_id: this.messageId,
          text: display,
        });
      }
      this.lastSentText = display;
      this.lastUpdateAt = Date.now();
    } catch (error) {
      console.warn(`Telegram progress update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async finish(text) {
    this.closed = true;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
    if (this.pending) await this.pending.catch(() => {});

    const finalText = clampText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
    if (!finalText) return null;

    if (this.transport === "edit" && this.messageId) {
      try {
        await callTelegramApi(this.config, "editMessageText", {
          chat_id: this.config.chatId,
          message_id: this.messageId,
          text: finalText,
        });
        return { message_id: this.messageId };
      } catch {
        // Fall through to a fresh message if the placeholder was deleted.
      }
    }

    return sendTelegramMessage(this.config, finalText);
  }
}

function normalizeChatId(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return "";
}

function formatNameParts(firstName, lastName) {
  return [firstName?.trim(), lastName?.trim()].filter(Boolean).join(" ");
}

function formatTelegramInbound(update, configuredChatId) {
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

async function sendTelegramMessage(config, text) {
  const message = clampText(text, TELEGRAM_MAX_MESSAGE_LENGTH);
  if (!message) return null;
  return callTelegramApi(config, "sendMessage", { chat_id: config.chatId, text: message });
}

class TelegramRunner {
  constructor(handler) {
    this.handler = handler;
    this.config = resolveTelegramConfig(handler);
    this.stopped = false;
    this.controller = null;
  }

  stop() {
    this.stopped = true;
    this.controller?.abort();
  }

  async run() {
    if (!this.config) throw new Error("Telegram handler needs a bot token and chat id.");
    let nextUpdateOffset = this.config.nextUpdateOffset || undefined;
    console.log(`Telegram handler "${this.handler.name}" listening for chat ${this.config.chatId}`);

    while (!this.stopped) {
      try {
        const controller = new AbortController();
        this.controller = controller;
        const updates = await callTelegramApi(
          this.config,
          "getUpdates",
          {
            timeout: this.config.pollTimeoutSeconds,
            allowed_updates: ["message", "channel_post"],
            ...(nextUpdateOffset ? { offset: nextUpdateOffset } : {}),
          },
          { signal: controller.signal },
        );
        this.controller = null;

        let highestUpdateId = nextUpdateOffset ? nextUpdateOffset - 1 : null;
        for (const update of updates) {
          if (Number.isInteger(update.update_id)) {
            highestUpdateId = highestUpdateId === null ? update.update_id : Math.max(highestUpdateId, update.update_id);
          }
          const event = formatTelegramInbound(update, this.config.chatId);
          if (!event) continue;
          const progress = new TelegramProgress(this.config, { draftId: event.telegram.messageId });
          await progress.start();
          const { session } = await enqueueEventSession(this.handler, event, {
            onStream: (stream) => progress.update(stream),
          });
          await progress.finish(session.messages.at(-1)?.content || "");
        }

        if (highestUpdateId !== null) {
          nextUpdateOffset = highestUpdateId + 1;
          const store = await loadStore();
          const handler = store.handlers.find((entry) => entry.id === this.handler.id);
          if (handler) {
            handler.sourceConfig = { ...(handler.sourceConfig || {}), nextUpdateOffset };
            await saveStore(store);
          }
        }
      } catch (error) {
        this.controller = null;
        if (this.stopped && error?.name === "AbortError") return;
        if (error?.name !== "AbortError") {
          await setHandlerError(this.handler.id, error);
          console.error(`Telegram handler failed: ${error instanceof Error ? error.message : String(error)}`);
          await sleep(5000);
        }
      }
    }
  }
}

function trimConfigValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function resolveComposioConfig(handler, settings) {
  const config = handler.sourceConfig || {};
  const triggerId = trimConfigValue(config.triggerId);
  const triggerSlug = trimConfigValue(config.triggerSlug);
  const toolkits = trimConfigValue(config.toolkits);
  const connectedAccountId = trimConfigValue(config.connectedAccountId);
  const userId = trimConfigValue(config.userId);
  if (!triggerId && !triggerSlug && !toolkits) {
    throw new Error("Composio trigger handler needs a trigger ID, trigger slug, or toolkit filter.");
  }

  const args = ["dev", "listen", "--json"];
  if (triggerId) args.push("--trigger-id", triggerId);
  if (triggerSlug) args.push("--trigger-slug", triggerSlug);
  if (toolkits) args.push("--toolkits", toolkits);
  if (connectedAccountId) args.push("--connected-account-id", connectedAccountId);
  if (userId) args.push("--user-id", userId);

  return {
    command:
      trimConfigValue(config.command) ||
      readEnv("PAGER_COMPOSIO_COMMAND", "COMPOSIO_COMMAND") ||
      "composio",
    args,
    cwd:
      trimConfigValue(config.projectCwd) ||
      readEnv("PAGER_COMPOSIO_PROJECT_CWD", "COMPOSIO_PROJECT_CWD") ||
      settings.cwd,
  };
}

class ComposioTriggerRunner {
  constructor(handler) {
    this.handler = handler;
    this.child = null;
    this.buffer = "";
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    this.child?.kill("SIGTERM");
  }

  async run() {
    const store = await loadStore();
    const config = resolveComposioConfig(this.handler, store.settings);
    const cwd = await validateCwd(config.cwd);
    this.child = spawn(config.command, config.args, { cwd, env: process.env });
    this.child.stdout.on("data", (chunk) => this.consume(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8").trim();
      if (text && !isIgnorableComposioStderr(text)) void setHandlerError(this.handler.id, new Error(text));
    });
    this.child.on("error", (error) => {
      composioRunners.delete(this.handler.id);
      void setHandlerError(this.handler.id, error);
    });
    this.child.on("close", (code) => {
      composioRunners.delete(this.handler.id);
      if (!this.stopped) {
        const message = code === 0 ? "Composio listener exited." : `Composio listener exited with code ${code}`;
        void setHandlerError(this.handler.id, new Error(message));
      }
    });
  }

  consume(text) {
    this.buffer += text;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const event = parseComposioLine(trimmed);
      if (!event) continue;
      void enqueueEventSession(this.handler, event).catch((error) => setHandlerError(this.handler.id, error));
    }
  }
}

function compactLines(lines) {
  return lines.filter((line) => line && String(line).trim()).map((line) => String(line).trim());
}

function formatComposioText(parsed) {
  const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
  const data = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
  const preview = data.preview && typeof data.preview === "object" ? data.preview : {};
  const lines = compactLines([
    metadata.trigger_slug ? `Trigger: ${metadata.trigger_slug}` : "",
    data.subject ? `Subject: ${data.subject}` : "",
    data.sender ? `From: ${data.sender}` : "",
    data.to ? `To: ${data.to}` : "",
    data.message_timestamp ? `Timestamp: ${data.message_timestamp}` : parsed.timestamp ? `Timestamp: ${parsed.timestamp}` : "",
    data.message_text || preview.body || data.text || preview.subject || "",
  ]);
  return lines.length ? lines.join("\n") : JSON.stringify(parsed, null, 2);
}

function parseComposioLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const data = parsed.data && typeof parsed.data === "object" ? parsed.data : {};
    const metadata = parsed.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
    return {
      id: String(parsed.id || data.id || data.message_id || randomUUID()),
      text: formatComposioText(parsed),
      raw: parsed,
      composio: {
        triggerId: metadata.trigger_id || null,
        triggerSlug: metadata.trigger_slug || null,
        connectedAccountId: metadata.connected_account_id || null,
        userId: metadata.user_id || null,
      },
    };
  } catch {
    return null;
  }
}

function stripAnsi(text) {
  return String(text || "").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

function isIgnorableComposioStderr(text) {
  const lines = stripAnsi(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return true;
  return lines.every((line) => (
    line.startsWith("Update available:") ||
    line.startsWith("Run composio upgrade") ||
    line === "◯" ||
    line === "╰─ composio-cli"
  ));
}

async function setHandlerError(handlerId, error) {
  const store = await loadStore();
  const handler = store.handlers.find((entry) => entry.id === handlerId);
  if (handler) {
    handler.lastError = error instanceof Error ? error.message : String(error);
    handler.updatedAt = nowIso();
    await saveStore(store);
  }
}

function stopHandlerRuntime(handlerId) {
  const telegram = telegramRunners.get(handlerId);
  if (telegram) {
    telegram.stop();
    telegramRunners.delete(handlerId);
  }
  const composio = composioRunners.get(handlerId);
  if (composio) {
    composio.stop();
    composioRunners.delete(handlerId);
  }
}

function startHandlerRuntime(handler) {
  stopHandlerRuntime(handler.id);
  if (!handler.enabled) return;

  try {
    if (handler.source === "telegram") {
      const runner = new TelegramRunner(handler);
      telegramRunners.set(handler.id, runner);
      void runner
        .run()
        .catch((error) => setHandlerError(handler.id, error))
        .finally(() => telegramRunners.delete(handler.id));
      return;
    }
    if (handler.source === "composio_trigger") {
      const runner = new ComposioTriggerRunner(handler);
      composioRunners.set(handler.id, runner);
      void runner
        .run()
        .catch((error) => {
          composioRunners.delete(handler.id);
          return setHandlerError(handler.id, error);
        });
    }
  } catch (error) {
    void setHandlerError(handler.id, error);
  }
}

function syncHandlerRuntimes(store) {
  const activeIds = new Set(store.handlers.filter((handler) => handler.enabled).map((handler) => handler.id));
  for (const id of [...telegramRunners.keys(), ...composioRunners.keys()]) {
    if (!activeIds.has(id)) stopHandlerRuntime(id);
  }
  for (const handler of store.handlers) {
    const running = telegramRunners.has(handler.id) || composioRunners.has(handler.id);
    if (handler.enabled && !running) startHandlerRuntime(handler);
  }
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    const store = await loadStore();
    json(res, 200, {
      settings: store.settings,
      handlers: store.handlers.map(publicHandler),
      sessions: store.sessions
        .filter((session) => session.handlerId)
        .map(publicSession)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      providers,
      sourceLabels,
    });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const store = await loadStore();
    const provider = providers[body.provider] ? body.provider : store.settings.provider;
    store.settings = {
      provider,
      cwd: await validateCwd(body.cwd || store.settings.cwd),
      model: typeof body.model === "string" ? body.model.trim() : store.settings.model,
      bypassPermissions: body.bypassPermissions !== false,
    };
    await saveStore(store);
    syncHandlerRuntimes(store);
    json(res, 200, { settings: store.settings });
    return;
  }

  if (req.method === "POST" && pathname === "/api/handlers") {
    const body = await readJsonBody(req);
    const store = await loadStore();
    const handler = normalizeHandler({
      name: body.name,
      source: body.source,
      enabled: body.enabled,
      sessionMode: body.sessionMode,
      prompt: body.prompt,
      sourceConfig: body.sourceConfig,
    });
    store.handlers.push(handler);
    await saveStore(store);
    startHandlerRuntime(handler);
    json(res, 201, { handler: publicHandler(handler) });
    return;
  }

  const handlerMatch = pathname.match(/^\/api\/handlers\/([^/]+)$/);
  if (handlerMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    const store = await loadStore();
    const handler = store.handlers.find((entry) => entry.id === handlerMatch[1]);
    if (!handler) return notFound(res);
    Object.assign(handler, normalizeHandler({
      ...handler,
      name: body.name,
      source: body.source,
      enabled: body.enabled,
      sessionMode: body.sessionMode,
      prompt: body.prompt,
      sourceConfig: body.sourceConfig,
      updatedAt: nowIso(),
    }));
    await saveStore(store);
    startHandlerRuntime(handler);
    json(res, 200, { handler: publicHandler(handler) });
    return;
  }

  if (handlerMatch && req.method === "DELETE") {
    const store = await loadStore();
    const index = store.handlers.findIndex((entry) => entry.id === handlerMatch[1]);
    if (index === -1) return notFound(res);
    stopHandlerRuntime(handlerMatch[1]);
    store.handlers.splice(index, 1);
    await saveStore(store);
    json(res, 200, { ok: true });
    return;
  }

  const testMatch = pathname.match(/^\/api\/handlers\/([^/]+)\/test$/);
  if (testMatch && req.method === "POST") {
    const body = await readJsonBody(req);
    const store = await loadStore();
    const handler = store.handlers.find((entry) => entry.id === testMatch[1]);
    if (!handler) return notFound(res);
    const { session } = await enqueueEventSession(handler, {
      id: randomUUID(),
      text: typeof body.text === "string" && body.text.trim() ? body.text.trim() : "Test event",
      raw: { manual: true },
    });
    json(res, 202, { session: publicSession(session) });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    const session = await loadSession(sessionMatch[1]);
    if (!session) return notFound(res);
    json(res, 200, { session: publicSession(session), messages: session.messages || [] });
    return;
  }

  notFound(res);
}

async function serveStatic(req, res, pathname) {
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const safePath = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) return notFound(res);

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    const contentType = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    res.end(body);
  } catch (error) {
    if (error?.code === "ENOENT") return notFound(res);
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url.pathname);
      return;
    }
    await serveStatic(req, res, url.pathname);
  } catch (error) {
    console.error(error);
    const status = error?.code === "cwd_not_found" ? 400 : 500;
    json(res, status, {
      error: status === 400 ? "bad_request" : "internal_error",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
});

server.listen(port, host, async () => {
  const store = await loadStore();
  syncHandlerRuntimes(store);
  console.log(`Pager is running at http://${host}:${port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}, stopping handlers...`);
  for (const id of [...telegramRunners.keys(), ...composioRunners.keys()]) {
    stopHandlerRuntime(id);
  }
  // Give in-flight subprocesses a moment to exit, then hard-exit if the
  // HTTP server is still keeping the event loop alive.
  const forceExit = setTimeout(() => process.exit(0), 3000);
  forceExit.unref();
  server.close(() => process.exit(0));
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
