import { coerceSessionMode, sessionModes } from "./constants.js";
import { createSourceRunner, publicSourceConfig, sourceLabel } from "./sources/index.js";
import { updateStore } from "./store.js";
import { nowIso, sleep } from "./util.js";

const handlerRuntimes = new Map();
const RETRY_DELAY_MS = 5_000;

export function isHandlerRunning(handlerId) {
  return handlerRuntimes.has(handlerId);
}

function listenerSignature(handler, settings = {}) {
  return JSON.stringify({
    source: handler.source,
    sourceConfig: handler.sourceConfig,
    settingsCwd: settings.cwd || "",
  });
}

export function publicHandler(handler) {
  const { sourceState: _ignored, ...safeHandler } = handler;
  return {
    ...safeHandler,
    sourceConfig: publicSourceConfig(handler.source, handler.sourceConfig),
    sessionModeLabel: sessionModes[coerceSessionMode(handler.sessionMode)],
    sourceLabel: sourceLabel(handler.source),
    running: isHandlerRunning(handler.id),
  };
}

async function setHandlerError(handlerId, error) {
  const message = error instanceof Error ? error.message : String(error);
  await updateStore((store) => {
    const handler = store.handlers.find((entry) => entry.id === handlerId);
    if (!handler) return;
    handler.lastError = message;
    handler.updatedAt = nowIso();
  });
}

class HandlerRuntime {
  constructor(handler, settings) {
    this.handler = handler;
    this.settings = settings;
    this.signature = listenerSignature(handler, settings);
    this.stopped = false;
    this.activeRunner = null;
    this.donePromise = null;
  }

  start() {
    this.donePromise = this.supervise();
  }

  stop() {
    this.stopped = true;
    this.activeRunner?.stop();
  }

  async supervise() {
    try {
      while (!this.stopped) {
        let runner;
        try {
          runner = createSourceRunner(this.handler, this.settings);
        } catch (error) {
          await setHandlerError(this.handler.id, error);
          console.error(`Handler "${this.handler.name}" config invalid:`, error instanceof Error ? error.message : error);
          return;
        }
        if (!runner) return;

        this.activeRunner = runner;
        try {
          await runner.run();
        } catch (error) {
          if (this.stopped) return;
          await setHandlerError(this.handler.id, error);
          console.error(`Handler "${this.handler.name}" failed:`, error instanceof Error ? error.message : error);
        } finally {
          this.activeRunner = null;
        }
        if (this.stopped) return;
        await sleep(RETRY_DELAY_MS);
      }
    } finally {
      if (handlerRuntimes.get(this.handler.id) === this) {
        handlerRuntimes.delete(this.handler.id);
      }
    }
  }
}

function startHandlerRuntime(handler, settings) {
  stopHandlerRuntime(handler.id);
  if (!handler.enabled) return;
  const runtime = new HandlerRuntime(handler, settings);
  handlerRuntimes.set(handler.id, runtime);
  runtime.start();
}

export function stopHandlerRuntime(handlerId) {
  const runtime = handlerRuntimes.get(handlerId);
  if (!runtime) return;
  runtime.stop();
  handlerRuntimes.delete(handlerId);
}

export function syncHandlerRuntimes(store) {
  const activeIds = new Set(store.handlers.filter((entry) => entry.enabled).map((entry) => entry.id));
  for (const id of [...handlerRuntimes.keys()]) {
    if (!activeIds.has(id)) stopHandlerRuntime(id);
  }
  for (const handler of store.handlers) {
    if (!handler.enabled) continue;
    const current = handlerRuntimes.get(handler.id);
    const signature = listenerSignature(handler, store.settings);
    if (!current || current.signature !== signature) startHandlerRuntime(handler, store.settings);
  }
}

export function stopAllHandlerRuntimes() {
  for (const id of [...handlerRuntimes.keys()]) {
    stopHandlerRuntime(id);
  }
}
