import * as composio_trigger from "./composio.js";
import * as telegram from "./telegram.js";

export const sources = { telegram, composio_trigger };

export function isKnownSource(source) {
  return Object.hasOwn(sources, source);
}

export function sourceLabel(source) {
  return sources[source]?.label || source;
}

export function sourceLabels() {
  return Object.fromEntries(Object.entries(sources).map(([id, src]) => [id, src.label]));
}

export function normalizeSourceConfig(source, input, previous) {
  return sources[source]?.normalizeConfig(input, previous) || {};
}

export function normalizeSourceState(source, input, legacyConfig) {
  return sources[source]?.normalizeState(input, legacyConfig) || {};
}

export function publicSourceConfig(source, config) {
  return sources[source]?.publicConfig(config) || {};
}

export function createSourceRunner(handler, settings) {
  return sources[handler.source]?.createRunner(handler, settings) || null;
}
