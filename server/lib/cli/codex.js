const ACTIVE_TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "mcp_tool_call",
  "web_search",
  "file_change",
]);

function codexItemType(item) {
  return item?.type || item?.item_type || "";
}

function summarizeCodexCommand(command) {
  const value = String(command || "").trim();
  if (!value) return null;
  const match = value.match(/^(?:bash\s+-lc\s+)?(\S+)/);
  return match?.[1] || value.slice(0, 32);
}

function codexToolLabel(itemType, item) {
  if (itemType === "command_execution") return summarizeCodexCommand(item.command) || "command";
  if (itemType === "mcp_tool_call") return item.tool || item.name || "tool";
  if (itemType === "web_search") return "web search";
  return itemType.replaceAll("_", " ");
}

export const command = process.env.CODEX_COMMAND || "codex";
export const label = "Codex";

export function buildArgs(session, options = {}) {
  const args = ["exec"];
  if (options.resumeCliSessionId) args.push("resume");
  args.push("--json");
  if (session.model) args.push("--model", session.model);
  if (session.bypassPermissions) args.push("--dangerously-bypass-approvals-and-sandbox");
  for (const attachment of options.attachments || []) {
    if (attachment.kind === "image" && attachment.localPath) args.push("--image", attachment.localPath);
  }
  if (options.resumeCliSessionId) args.push(options.resumeCliSessionId);
  args.push("-");
  return args;
}

export function createState() {
  return {
    cliSessionId: null,
    model: "",
    assistantText: "",
    phase: "thinking",
    toolLabel: null,
    error: "",
    usage: {},
    costUsd: null,
  };
}

export function processEvent(state, event) {
  if (event.type === "thread.started" && event.thread_id) {
    state.cliSessionId = event.thread_id;
  }
  if (event.type === "turn.started") {
    state.phase = "thinking";
    state.toolLabel = null;
  }
  if (event.type === "turn.completed" && event.usage) {
    state.usage = {
      inputTokens: event.usage.input_tokens,
      cachedInputTokens: event.usage.cached_input_tokens,
      outputTokens: event.usage.output_tokens,
    };
  }
  if (event.type === "error" && event.message) {
    state.error = event.message;
  }

  const item = event.item;
  if (!item) return;
  const itemType = codexItemType(item);

  if (itemType === "reasoning") {
    state.phase = "thinking";
    return;
  }

  const toolInProgress =
    (event.type === "item.started" || event.type === "item.updated") &&
    ACTIVE_TOOL_ITEM_TYPES.has(itemType) &&
    item.status !== "completed" &&
    item.status !== "failed";

  if (toolInProgress) {
    state.phase = "tools";
    state.toolLabel = codexToolLabel(itemType, item);
    return;
  }

  if ((itemType === "agent_message" || itemType === "assistant_message") && item.text) {
    state.assistantText = item.text;
    state.phase = "text";
    state.toolLabel = null;
  }
}

export function streamView(state) {
  return { text: state.assistantText, phase: state.phase, toolLabel: state.toolLabel };
}

export function finalize(state) {
  return {
    cliSessionId: state.cliSessionId,
    model: state.model,
    assistant: state.assistantText.trim(),
    error: state.error,
    usage: state.usage,
    costUsd: state.costUsd,
  };
}
