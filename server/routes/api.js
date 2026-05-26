import { randomUUID } from "node:crypto";
import { cliProviders } from "../lib/cli/index.js";
import { defaultHandlerPrompt } from "../lib/constants.js";
import { json, notFound } from "../lib/http.js";
import { publicHandler, syncHandlerRuntimes } from "../lib/runtime.js";
import { enqueueEventSession } from "../lib/sessions.js";
import { sourceLabels } from "../lib/sources/index.js";
import {
  loadSession,
  loadStore,
  normalizeHandler,
  toPublicSession,
  updateStore,
} from "../lib/store.js";
import { nowIso, readJsonBody, validateCwd } from "../lib/util.js";

function publicProviders() {
  return Object.fromEntries(
    Object.entries(cliProviders).map(([id, p]) => [id, { label: p.label, command: p.command }]),
  );
}

export async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/state") {
    const store = await loadStore();
    json(res, 200, {
      settings: store.settings,
      handlers: store.handlers.map(publicHandler),
      sessions: store.sessions
        .filter((session) => session.handlerId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      providers: publicProviders(),
      sourceLabels: sourceLabels(),
      defaultPrompt: defaultHandlerPrompt,
    });
    return;
  }

  if (req.method === "PUT" && pathname === "/api/settings") {
    const body = await readJsonBody(req);
    let updatedStore;
    await updateStore(async (store) => {
      const provider = cliProviders[body.provider] ? body.provider : store.settings.provider;
      store.settings = {
        provider,
        cwd: await validateCwd(body.cwd || store.settings.cwd),
        model: typeof body.model === "string" ? body.model.trim() : store.settings.model,
        bypassPermissions: body.bypassPermissions !== false,
      };
      updatedStore = store;
    });
    syncHandlerRuntimes(updatedStore);
    json(res, 200, { settings: updatedStore.settings });
    return;
  }

  if (req.method === "POST" && pathname === "/api/handlers") {
    const body = await readJsonBody(req);
    let createdHandler;
    let updatedStore;
    await updateStore((store) => {
      createdHandler = normalizeHandler({
        name: body.name,
        source: body.source,
        enabled: body.enabled,
        sessionMode: body.sessionMode,
        prompt: body.prompt,
        sourceConfig: body.sourceConfig,
      });
      store.handlers.push(createdHandler);
      updatedStore = store;
    });
    syncHandlerRuntimes(updatedStore);
    json(res, 201, { handler: publicHandler(createdHandler) });
    return;
  }

  const handlerMatch = pathname.match(/^\/api\/handlers\/([^/]+)$/);
  if (handlerMatch && req.method === "PUT") {
    const body = await readJsonBody(req);
    let updatedHandler = null;
    let updatedStore;
    await updateStore((store) => {
      const handler = store.handlers.find((entry) => entry.id === handlerMatch[1]);
      if (!handler) return;
      updatedHandler = normalizeHandler({
        ...handler,
        name: body.name,
        source: body.source,
        enabled: body.enabled,
        sessionMode: body.sessionMode,
        prompt: body.prompt,
        sourceConfig: body.sourceConfig,
        updatedAt: nowIso(),
      }, handler);
      Object.assign(handler, updatedHandler);
      updatedStore = store;
    });
    if (!updatedHandler) return notFound(res);
    syncHandlerRuntimes(updatedStore);
    json(res, 200, { handler: publicHandler(updatedHandler) });
    return;
  }

  if (handlerMatch && req.method === "DELETE") {
    let deleted = false;
    let updatedStore;
    await updateStore((store) => {
      const index = store.handlers.findIndex((entry) => entry.id === handlerMatch[1]);
      if (index === -1) return;
      store.handlers.splice(index, 1);
      deleted = true;
      updatedStore = store;
    });
    if (!deleted) return notFound(res);
    syncHandlerRuntimes(updatedStore);
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
    json(res, 202, { session: toPublicSession(session) });
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessionMatch && req.method === "GET") {
    const session = await loadSession(sessionMatch[1]);
    if (!session) return notFound(res);
    json(res, 200, { session: toPublicSession(session), messages: session.messages || [] });
    return;
  }

  notFound(res);
}
