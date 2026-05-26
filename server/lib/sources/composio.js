import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { enqueueEventSession } from "../sessions.js";
import { appendLineBuffer, readEnv, validateCwd } from "../util.js";

export const label = "Composio trigger";

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readConfigString(input, previous, key) {
  if (!Object.hasOwn(input || {}, key)) return trimString(previous?.[key]);
  return trimString(input[key]);
}

export function normalizeConfig(input = {}, previous = {}) {
  return {
    command: readConfigString(input, previous, "command"),
    projectCwd: readConfigString(input, previous, "projectCwd"),
    triggerId: readConfigString(input, previous, "triggerId"),
    triggerSlug: readConfigString(input, previous, "triggerSlug"),
    toolkits: readConfigString(input, previous, "toolkits"),
    connectedAccountId: readConfigString(input, previous, "connectedAccountId"),
    userId: readConfigString(input, previous, "userId"),
  };
}

export function normalizeState() {
  return {};
}

export function publicConfig(config = {}) {
  return { ...config };
}

function resolveComposioConfig(handler, settings) {
  const config = handler.sourceConfig || {};
  const triggerId = trimString(config.triggerId);
  const triggerSlug = trimString(config.triggerSlug);
  const toolkits = trimString(config.toolkits);
  const connectedAccountId = trimString(config.connectedAccountId);
  const userId = trimString(config.userId);
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
      trimString(config.command) ||
      readEnv("PAGER_COMPOSIO_COMMAND", "COMPOSIO_COMMAND") ||
      "composio",
    args,
    cwd:
      trimString(config.projectCwd) ||
      readEnv("PAGER_COMPOSIO_PROJECT_CWD", "COMPOSIO_PROJECT_CWD") ||
      settings.cwd,
  };
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

export function createRunner(handler, settings) {
  const config = resolveComposioConfig(handler, settings);
  let child = null;
  let stopped = false;

  return {
    stop() {
      stopped = true;
      child?.kill("SIGTERM");
    },
    async run() {
      const cwd = await validateCwd(config.cwd);
      let buffer = "";
      const stderrTail = [];

      child = spawn(config.command, config.args, { cwd, env: process.env });

      child.stdout.on("data", (chunk) => {
        const { lines, remainder } = appendLineBuffer(buffer, chunk.toString("utf8"));
        buffer = remainder;
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const event = parseComposioLine(trimmed);
          if (!event) continue;
          void enqueueEventSession(handler, event).catch((error) => {
            console.error(`Composio handler "${handler.name}" event failed:`, error.message);
          });
        }
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line) continue;
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
          console.warn(`composio[${handler.name}]: ${line}`);
        }
      });

      const { code, error } = await new Promise((resolve) => {
        child.once("error", (err) => resolve({ code: null, error: err }));
        child.once("close", (exitCode) => resolve({ code: exitCode, error: null }));
      });

      if (stopped) return;
      if (error) throw error;
      if (code !== 0) {
        const tail = stderrTail.slice(-3).join(" / ");
        throw new Error(`Composio listener exited with code ${code}${tail ? ` (${tail})` : ""}`);
      }
    },
  };
}
