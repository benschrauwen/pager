import fs from "node:fs/promises";
import path from "node:path";

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function clampText(value, maxLength) {
  const text = String(value || "").trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}...`;
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text.trim() ? JSON.parse(text) : {};
}

export async function validateCwd(cwd) {
  const resolved = cwd && String(cwd).trim() ? path.resolve(String(cwd).trim()) : process.cwd();
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat?.isDirectory()) {
    const error = new Error(`Working directory not found: ${resolved}`);
    error.code = "cwd_not_found";
    throw error;
  }
  return resolved;
}

export function appendLineBuffer(buffer, chunk) {
  const combined = buffer + chunk;
  const lines = combined.split(/\r?\n/);
  return { lines: lines.slice(0, -1), remainder: lines.at(-1) || "" };
}

export function parseJsonLines(lines, onEvent) {
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      onEvent(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
}
