import { randomUUID } from "node:crypto";
import { runCli } from "./cli/run.js";
import { coerceSessionMode, defaultHandlerPrompt } from "./constants.js";
import { sourceLabel } from "./sources/index.js";
import { loadSession, loadStore, saveSessionTurn } from "./store.js";
import { nowIso, validateCwd } from "./util.js";

const handlerRunQueues = new Map();

export function renderPrompt(template, event, handler) {
  const label = sourceLabel(handler.source);
  const eventJson = JSON.stringify(event, null, 2);
  const rendered = String(template || defaultHandlerPrompt)
    .replaceAll("{{source}}", handler.source)
    .replaceAll("{{sourceLabel}}", label)
    .replaceAll("{{handlerName}}", handler.name)
    .replaceAll("{{eventText}}", event.text || eventJson)
    .replaceAll("{{eventJson}}", eventJson);
  const attachmentLines = (event.attachments || []).map((attachment) => {
    if (attachment.localPath) return `- ${attachment.kind}: ${attachment.localPath}`;
    return `- ${attachment.kind}: unavailable (${attachment.error || "download failed"})`;
  });
  return attachmentLines.length
    ? `${rendered}\n\nLocal attachments available to inspect:\n${attachmentLines.join("\n")}`
    : rendered;
}

async function findExistingSingleThreadSession(handler, store) {
  const candidates = store.sessions
    .filter((entry) => entry.handlerId === handler.id)
    .sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
  for (const entry of candidates) {
    const loaded = await loadSession(entry.id);
    if (loaded?.sessionMode === "single_thread") return loaded;
  }
  return null;
}

function freshSession(handler, settings, event, startedAt, cwd) {
  const singleThread = handler.sessionMode === "single_thread";
  return {
    id: randomUUID(),
    handlerId: handler.id,
    source: handler.source,
    sessionMode: coerceSessionMode(handler.sessionMode),
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
}

function applyCurrentSettings(session, settings, cwd, event) {
  if (session.provider !== settings.provider) session.cliSessionId = null;
  session.provider = settings.provider;
  session.cwd = cwd;
  session.model = settings.model || "";
  session.bypassPermissions = settings.bypassPermissions !== false;
  session.event = event;
}

async function resolveSession(handler, settings, event, startedAt, cwd) {
  const singleThread = handler.sessionMode === "single_thread";
  if (singleThread) {
    const store = await loadStore();
    const existing = await findExistingSingleThreadSession(handler, store);
    if (existing) {
      applyCurrentSettings(existing, settings, cwd, event);
      return existing;
    }
  }
  return freshSession(handler, settings, event, startedAt, cwd);
}

export async function createEventSession(handler, event, options = {}) {
  const store = await loadStore();
  const stored = store.handlers.find((entry) => entry.id === handler.id);
  if (!stored) throw new Error(`Handler ${handler.id} no longer exists`);

  const settings = store.settings;
  const cwd = await validateCwd(settings.cwd);
  const startedAt = nowIso();
  const session = await resolveSession(stored, settings, event, startedAt, cwd);

  const prompt = renderPrompt(stored.prompt, event, stored);
  session.messages.push({
    id: randomUUID(),
    role: "event",
    content: prompt,
    createdAt: startedAt,
    meta: { event, handlerId: stored.id, source: stored.source },
  });

  const result = await runCli(session, prompt, {
    resumeCliSessionId: stored.sessionMode === "single_thread" ? session.cliSessionId : null,
    attachments: event.attachments || [],
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

  await saveSessionTurn({
    session,
    handlerId: stored.id,
    handlerPatch: {
      lastEventAt: finishedAt,
      lastError: result.ok ? null : result.error || "CLI run failed",
      updatedAt: finishedAt,
    },
  });
  return { session, result };
}

export function enqueueEventSession(handler, event, options = {}) {
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
