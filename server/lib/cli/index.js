import * as claude from "./claude.js";
import * as codex from "./codex.js";

export const cliProviders = { codex, claude };

export function getCliProvider(providerId) {
  const provider = cliProviders[providerId];
  if (!provider) throw new Error(`Unknown CLI provider: ${providerId}`);
  return provider;
}
