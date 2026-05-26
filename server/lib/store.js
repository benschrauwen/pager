import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { cliProviders } from "./cli/index.js";
import {
  coerceSessionMode,
  defaultHandlerPrompt,
  defaultSettings,
} from "./constants.js";
import { sessionFilePath, sessionsDir, storePath } from "./paths.js";
import {
  isKnownSource,
  normalizeSourceConfig,
  normalizeSourceState,
  sourceLabel,
} from "./sources/index.js";
import { nowIso } from "./util.js";

let writeChain = Promise.resolve();

function enqueueWrite(task) {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => {});
  return run;
}

async function writeJsonAtomic(filePath, value) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await fs.writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.rename(tmpPath, filePath);
}

function isValidProvider(id) {
  return Object.hasOwn(cliProviders, id);
}

export function normalizeHandler(input = {}, previous = {}) {
  const source = isKnownSource(input.source) ? input.source : previous.source || "telegram";
  const sessionMode = coerceSessionMode(input.sessionMode);
  const createdAt = typeof input.createdAt === "string" ? input.createdAt : nowIso();
  const previousConfig = previous.source === source ? previous.sourceConfig : {};
  const previousState = previous.source === source ? previous.sourceState : {};
  return {
    id: typeof input.id === "string" ? input.id : randomUUID(),
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : sourceLabel(source),
    source,
    enabled: input.enabled === true,
    sessionMode,
    prompt: typeof input.prompt === "string" && input.prompt.trim() ? input.prompt : defaultHandlerPrompt,
    sourceConfig: normalizeSourceConfig(
      source,
      input.sourceConfig && typeof input.sourceConfig === "object" ? input.sourceConfig : {},
      previousConfig,
    ),
    sourceState: normalizeSourceState(
      source,
      input.sourceState && typeof input.sourceState === "object" ? input.sourceState : previousState,
      input.sourceConfig && typeof input.sourceConfig === "object" ? input.sourceConfig : {},
    ),
    createdAt,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : createdAt,
    lastEventAt: typeof input.lastEventAt === "string" ? input.lastEventAt : null,
    lastError: typeof input.lastError === "string" ? input.lastError : null,
  };
}

function normalizeSessionIndex(entry = {}) {
  return {
    id: typeof entry.id === "string" ? entry.id : randomUUID(),
    handlerId: typeof entry.handlerId === "string" ? entry.handlerId : null,
    source: entry.source || "event",
    name: typeof entry.name === "string" ? entry.name : "Session",
    provider: isValidProvider(entry.provider) ? entry.provider : defaultSettings.provider,
    cwd: typeof entry.cwd === "string" ? entry.cwd : defaultSettings.cwd,
    model: typeof entry.model === "string" ? entry.model : "",
    sessionMode: coerceSessionMode(entry.sessionMode),
    createdAt: typeof entry.createdAt === "string" ? entry.createdAt : nowIso(),
    updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : nowIso(),
    messageCount: Number.isInteger(entry.messageCount) ? entry.messageCount : 0,
    latestPreview: typeof entry.latestPreview === "string" ? entry.latestPreview : "",
  };
}

function normalizeStoreOnRead(parsed = {}) {
  return {
    settings: {
      ...defaultSettings,
      ...(parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {}),
    },
    handlers: Array.isArray(parsed.handlers) ? parsed.handlers.map((entry) => normalizeHandler(entry)) : [],
    sessions: Array.isArray(parsed.sessions) ? parsed.sessions.map(normalizeSessionIndex) : [],
  };
}

async function readStoreFromDisk() {
  await fs.mkdir(sessionsDir, { recursive: true });
  try {
    return normalizeStoreOnRead(JSON.parse(await fs.readFile(storePath, "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return normalizeStoreOnRead({});
    throw error;
  }
}

export async function loadStore() {
  return readStoreFromDisk();
}

export function updateStore(mutator) {
  return enqueueWrite(async () => {
    const store = await readStoreFromDisk();
    const result = await mutator(store);
    await writeJsonAtomic(storePath, store);
    return result;
  });
}

export function normalizeSessionRecord(session = {}) {
  return {
    id: typeof session.id === "string" ? session.id : randomUUID(),
    handlerId: typeof session.handlerId === "string" ? session.handlerId : null,
    source: session.source || "event",
    name: typeof session.name === "string" ? session.name : "Session",
    provider: isValidProvider(session.provider) ? session.provider : defaultSettings.provider,
    cwd: typeof session.cwd === "string" ? session.cwd : defaultSettings.cwd,
    model: typeof session.model === "string" ? session.model : "",
    sessionMode: coerceSessionMode(session.sessionMode),
    bypassPermissions: session.bypassPermissions !== false,
    cliSessionId: typeof session.cliSessionId === "string" ? session.cliSessionId : null,
    createdAt: typeof session.createdAt === "string" ? session.createdAt : nowIso(),
    updatedAt: typeof session.updatedAt === "string" ? session.updatedAt : nowIso(),
    event: session.event && typeof session.event === "object" ? session.event : null,
    messages: Array.isArray(session.messages) ? session.messages : [],
  };
}

export async function loadSession(sessionId) {
  try {
    const parsed = JSON.parse(await fs.readFile(sessionFilePath(sessionId), "utf8"));
    return normalizeSessionRecord(parsed);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export function toPublicSession(session) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const latest = messages.at(-1);
  return {
    id: session.id,
    handlerId: session.handlerId || null,
    source: session.source || "event",
    name: session.name,
    provider: session.provider,
    cwd: session.cwd,
    model: session.model || "",
    sessionMode: coerceSessionMode(session.sessionMode),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: messages.length,
    latestPreview: latest?.content?.slice(0, 140) || "",
  };
}

function upsertSessionIndex(store, record) {
  const entry = toPublicSession(record);
  const index = store.sessions.findIndex((item) => item.id === entry.id);
  if (index === -1) store.sessions.push(entry);
  else store.sessions[index] = entry;
}

export function saveSessionTurn({ session, handlerId, handlerPatch }) {
  const record = normalizeSessionRecord(session);
  return enqueueWrite(async () => {
    await writeJsonAtomic(sessionFilePath(record.id), record);
    const store = await readStoreFromDisk();
    upsertSessionIndex(store, record);
    if (handlerId && handlerPatch) {
      const handler = store.handlers.find((entry) => entry.id === handlerId);
      if (handler) Object.assign(handler, handlerPatch);
    }
    await writeJsonAtomic(storePath, store);
  });
}
