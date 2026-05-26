import { spawn } from "node:child_process";
import { appendLineBuffer, parseJsonLines } from "../util.js";
import { getCliProvider } from "./index.js";

export function runCli(session, prompt, options = {}) {
  const provider = getCliProvider(session.provider);
  const args = provider.buildArgs(session, options);
  const onStream = typeof options.onStream === "function" ? options.onStream : null;
  const state = provider.createState();
  let lineBuffer = "";

  function consume(text) {
    const { lines, remainder } = appendLineBuffer(lineBuffer, text);
    lineBuffer = remainder;
    parseJsonLines(lines, (event) => {
      provider.processEvent(state, event);
      if (onStream) onStream(provider.streamView(state));
    });
  }

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
      consume(text);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      settled = true;
      resolve({ ok: false, exitCode: null, stdout, stderr, error: error.message, parsed: provider.finalize(state) });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (lineBuffer.trim()) {
        consume("\n");
      }
      const parsed = provider.finalize(state);
      const error = parsed.error || (code === 0 ? "" : stderr.trim());
      resolve({ ok: code === 0 && !error, exitCode: code, signal, stdout, stderr, error, parsed });
    });
    child.stdin.end(prompt);
  });
}
