import path from "node:path";

export const command = process.env.CLAUDE_COMMAND || "claude";
export const label = "Claude";

export function buildArgs(session, options = {}) {
  const args = ["--print", "-", "--output-format", "stream-json", "--verbose"];
  if (options.resumeCliSessionId) args.push("--resume", options.resumeCliSessionId);
  if (session.bypassPermissions) args.push("--dangerously-skip-permissions");
  if (session.model) args.push("--model", session.model);
  const attachmentDirs = new Set(
    (options.attachments || []).filter((attachment) => attachment.localPath).map((attachment) => path.dirname(attachment.localPath)),
  );
  for (const directory of attachmentDirs) args.push("--add-dir", directory);
  return args;
}

export function createState() {
  return {
    cliSessionId: null,
    model: "",
    assistantText: "",
    finalAssistant: null,
    phase: "thinking",
    toolLabel: null,
    error: "",
    usage: {},
    costUsd: null,
  };
}

export function processEvent(state, event) {
  if (event.session_id) state.cliSessionId = event.session_id;
  if (event.model) state.model = event.model;

  if (event.type === "tool_use") {
    state.phase = "tools";
    state.toolLabel = event.name || "tool";
    return;
  }

  if (event.type === "stream_event") {
    const inner = event.event;
    if (inner?.type === "content_block_start") {
      const blockType = inner.content_block?.type;
      if (blockType === "tool_use") {
        state.phase = "tools";
        state.toolLabel = inner.content_block?.name || "tool";
        return;
      }
      if (blockType === "text") {
        state.phase = "thinking";
      }
    }
    if (inner?.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
      state.assistantText += inner.delta.text;
      state.phase = "text";
      state.toolLabel = null;
    }
    return;
  }

  if (event.type === "assistant") {
    const parts = [];
    let toolName = null;
    let hasTool = false;
    for (const block of event.message?.content || []) {
      if (block?.type === "text" && block.text) parts.push(block.text);
      if (block?.type === "tool_use") {
        hasTool = true;
        toolName = block.name || toolName;
      }
    }
    if (hasTool) {
      state.phase = "tools";
      state.toolLabel = toolName || "tool";
    } else if (parts.length) {
      state.assistantText = parts.join("\n\n");
      state.phase = "text";
      state.toolLabel = null;
    }
    return;
  }

  if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
    state.assistantText += event.delta.text;
    state.phase = "text";
    state.toolLabel = null;
    return;
  }

  if (event.type === "result") {
    if (event.result) state.finalAssistant = event.result;
    if (event.usage) {
      state.usage = {
        inputTokens: event.usage.input_tokens,
        cachedInputTokens: event.usage.cache_read_input_tokens,
        outputTokens: event.usage.output_tokens,
      };
    }
    if (typeof event.total_cost_usd === "number") state.costUsd = event.total_cost_usd;
  }
}

export function streamView(state) {
  return { text: state.assistantText, phase: state.phase, toolLabel: state.toolLabel };
}

export function finalize(state) {
  return {
    cliSessionId: state.cliSessionId,
    model: state.model,
    assistant: (state.finalAssistant ?? state.assistantText).trim(),
    error: state.error,
    usage: state.usage,
    costUsd: state.costUsd,
  };
}
