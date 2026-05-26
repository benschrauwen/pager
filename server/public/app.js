const state = {
  settings: null,
  handlers: [],
  sessions: [],
  selectedHandlerId: null,
  selectedSessionId: null,
  sourceLabels: {},
};

const settingsStatus = document.querySelector("#settingsStatus");
const settingsForm = document.querySelector("#settingsForm");
const settingsProvider = document.querySelector("#settingsProvider");
const settingsModel = document.querySelector("#settingsModel");
const settingsCwd = document.querySelector("#settingsCwd");
const settingsBypass = document.querySelector("#settingsBypass");
const handlersEl = document.querySelector("#handlers");
const handlerCount = document.querySelector("#handlerCount");
const emptyState = document.querySelector("#emptyState");
const detail = document.querySelector("#detail");
const detailTitle = document.querySelector("#detailTitle");
const detailMeta = document.querySelector("#detailMeta");
const detailStatus = document.querySelector("#detailStatus");
const emptyStateNew = document.querySelector("#emptyStateNew");
const sessionsEl = document.querySelector("#sessions");
const messagesEl = document.querySelector("#messages");
const refreshButton = document.querySelector("#refreshButton");
const testHandlerButton = document.querySelector("#testHandlerButton");
const editHandlerButton = document.querySelector("#editHandlerButton");
const duplicateHandlerButton = document.querySelector("#duplicateHandlerButton");
const handlerDialog = document.querySelector("#handlerDialog");
const handlerForm = document.querySelector("#handlerForm");
const handlerDialogTitle = document.querySelector("#handlerDialogTitle");
const handlerId = document.querySelector("#handlerId");
const handlerName = document.querySelector("#handlerName");
const handlerSource = document.querySelector("#handlerSource");
const handlerSessionMode = document.querySelector("#handlerSessionMode");
const handlerPrompt = document.querySelector("#handlerPrompt");
const handlerEnabled = document.querySelector("#handlerEnabled");
const telegramFields = document.querySelector("#telegramFields");
const telegramBotToken = document.querySelector("#telegramBotToken");
const telegramChatId = document.querySelector("#telegramChatId");
const composioFields = document.querySelector("#composioFields");
const composioCommand = document.querySelector("#composioCommand");
const composioProjectCwd = document.querySelector("#composioProjectCwd");
const composioTriggerId = document.querySelector("#composioTriggerId");
const composioTriggerSlug = document.querySelector("#composioTriggerSlug");
const composioToolkits = document.querySelector("#composioToolkits");
const composioConnectedAccountId = document.querySelector("#composioConnectedAccountId");
const composioUserId = document.querySelector("#composioUserId");
const deleteHandlerButton = document.querySelector("#deleteHandlerButton");

const defaultPrompt = [
  "Handle this incoming event from {{sourceLabel}}.",
  "Keep the response concise and useful.",
  "",
  "Event:",
  "{{eventText}}",
].join("\n");

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString() : "never";
}

function shortDateTime(value) {
  if (!value) return "—";
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusOf(handler) {
  if (handler.running) return { tone: "running", label: "Listening" };
  if (handler.lastError) return { tone: "error", label: "Error" };
  if (!handler.enabled) return { tone: "paused", label: "Paused" };
  return { tone: "idle", label: "Idle" };
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.detail || data.error || "Request failed");
  }
  return data;
}

async function loadState({ full = false } = {}) {
  const data = await api("/api/state");
  const prevSessionUpdatedAt = state.sessions.find(
    (session) => session.id === state.selectedSessionId,
  )?.updatedAt;
  state.settings = data.settings;
  state.handlers = data.handlers;
  state.sessions = data.sessions;
  state.sourceLabels = data.sourceLabels;
  if (!state.selectedHandlerId && state.handlers.length > 0) {
    state.selectedHandlerId = state.handlers[0].id;
  }
  if (full) {
    render();
    return;
  }
  refreshUI(prevSessionUpdatedAt);
}

function render() {
  renderSettings();
  renderHandlers();
  renderDetail();
}

function refreshUI(prevSessionUpdatedAt) {
  refreshHandlers();
  refreshDetail(prevSessionUpdatedAt);
}

function renderSettings() {
  settingsProvider.value = state.settings?.provider || "codex";
  settingsModel.value = state.settings?.model || "";
  settingsCwd.value = state.settings?.cwd || "";
  settingsBypass.checked = state.settings?.bypassPermissions !== false;
  const saved = Boolean(state.settings?.cwd);
  settingsStatus.dataset.status = saved ? "running" : "idle";
  settingsStatus.innerHTML = `<span class="dot"></span>${saved ? "Saved" : "Required"}`;
}

function sessionsForHandler(handlerId) {
  return state.sessions.filter((session) => session.handlerId === handlerId);
}

function cloneSourceConfig(sourceConfig = {}) {
  const cloned = JSON.parse(JSON.stringify(sourceConfig || {}));
  delete cloned.nextUpdateOffset;
  return cloned;
}

function duplicateName(name) {
  const base = `${name || "Event handler"} copy`;
  if (!state.handlers.some((handler) => handler.name === base)) return base;
  let index = 2;
  while (state.handlers.some((handler) => handler.name === `${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

function renderHandlers() {
  handlerCount.textContent = String(state.handlers.length);
  handlersEl.innerHTML = "";
  if (state.handlers.length === 0) {
    const empty = document.createElement("div");
    empty.className = "emptyInline";
    empty.textContent = "No handlers yet.";
    handlersEl.append(empty);
    return;
  }
  for (const handler of state.handlers) {
    const sessions = sessionsForHandler(handler.id);
    const status = statusOf(handler);
    const detailLine = status.tone === "error"
      ? handler.lastError
      : `${status.label}${handler.lastEventAt ? ` · ${shortDateTime(handler.lastEventAt)}` : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `listItem${handler.id === state.selectedHandlerId ? " active" : ""}`;
    button.dataset.handlerId = handler.id;
    button.innerHTML = `
      <span class="dot" data-status="${status.tone}"></span>
      <span class="meta">
        <span class="name">${escapeHtml(handler.name)}</span>
        <span class="sub">${escapeHtml(handler.sourceLabel)} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}</span>
        <span class="sub">${escapeHtml(detailLine)}</span>
      </span>
    `;
    button.addEventListener("click", () => {
      state.selectedHandlerId = handler.id;
      state.selectedSessionId = sessions[0]?.id || null;
      render();
    });
    button.addEventListener("dblclick", () => openHandlerDialog(handler));
    handlersEl.append(button);
  }
}

function refreshHandlers() {
  handlerCount.textContent = String(state.handlers.length);
  if (state.handlers.length === 0) {
    if (handlersEl.querySelector(".emptyInline")) return;
    renderHandlers();
    return;
  }

  const buttons = [...handlersEl.querySelectorAll("button.listItem")];
  const currentIds = buttons.map((button) => button.dataset.handlerId);
  const expectedIds = state.handlers.map((handler) => handler.id);
  if (
    buttons.length !== expectedIds.length
    || currentIds.some((id, index) => id !== expectedIds[index])
  ) {
    renderHandlers();
    return;
  }

  for (const handler of state.handlers) {
    const button = handlersEl.querySelector(`button.listItem[data-handler-id="${handler.id}"]`);
    const sessions = sessionsForHandler(handler.id);
    const status = statusOf(handler);
    const detailLine = status.tone === "error"
      ? handler.lastError
      : `${status.label}${handler.lastEventAt ? ` · ${shortDateTime(handler.lastEventAt)}` : ""}`;
    button.classList.toggle("active", handler.id === state.selectedHandlerId);
    button.querySelector(".dot").dataset.status = status.tone;
    button.querySelector(".name").textContent = handler.name;
    const subs = button.querySelectorAll(".sub");
    subs[0].textContent = `${handler.sourceLabel} · ${sessions.length} session${sessions.length === 1 ? "" : "s"}`;
    subs[1].textContent = detailLine;
  }
}

function renderDetail() {
  const handler = state.handlers.find((entry) => entry.id === state.selectedHandlerId);
  if (!handler) {
    detail.classList.add("hidden");
    emptyState.classList.remove("hidden");
    return;
  }

  detail.classList.remove("hidden");
  emptyState.classList.add("hidden");
  const sessions = sessionsForHandler(handler.id);
  if (!state.selectedSessionId || !sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = sessions[0]?.id || null;
  }

  const status = statusOf(handler);
  detailTitle.textContent = handler.name;
  detailStatus.dataset.status = status.tone;
  detailStatus.innerHTML = `<span class="dot"></span>${status.label}`;
  detailMeta.textContent = `${handler.sourceLabel} · ${handler.sessionModeLabel || "New session per event"} · ${sessions.length} session${sessions.length === 1 ? "" : "s"} · last event ${formatDate(handler.lastEventAt)}`;
  renderSessionCards(sessions);
  renderMessages();
}

function refreshDetail(prevSessionUpdatedAt) {
  const handler = state.handlers.find((entry) => entry.id === state.selectedHandlerId);
  if (!handler) {
    detail.classList.add("hidden");
    emptyState.classList.remove("hidden");
    return;
  }

  detail.classList.remove("hidden");
  emptyState.classList.add("hidden");
  const sessions = sessionsForHandler(handler.id);
  if (!state.selectedSessionId || !sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = sessions[0]?.id || null;
  }

  const status = statusOf(handler);
  detailTitle.textContent = handler.name;
  detailStatus.dataset.status = status.tone;
  detailStatus.innerHTML = `<span class="dot"></span>${status.label}`;
  detailMeta.textContent = `${handler.sourceLabel} · ${handler.sessionModeLabel || "New session per event"} · ${sessions.length} session${sessions.length === 1 ? "" : "s"} · last event ${formatDate(handler.lastEventAt)}`;
  refreshSessionCards(sessions);

  const session = sessions.find((entry) => entry.id === state.selectedSessionId);
  if (session?.updatedAt && session.updatedAt !== prevSessionUpdatedAt) {
    renderMessages({ preserveScroll: true });
  }
}

function renderSessionCards(sessions) {
  sessionsEl.innerHTML = "";
  if (sessions.length === 0) {
    sessionsEl.innerHTML = `<div class="emptyInline">No sessions yet. Use “Test event” to create one.</div>`;
    return;
  }
  for (const session of sessions) {
    const [primaryName, ...rest] = session.name.split(" · ");
    const sessionLabel = rest.length ? rest.join(" · ") : primaryName;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sessionCard${session.id === state.selectedSessionId ? " active" : ""}`;
    button.dataset.sessionId = session.id;
    button.innerHTML = `
      <span class="row">
        <span class="name">${escapeHtml(sessionLabel)}</span>
        <span class="when">${escapeHtml(shortDateTime(session.updatedAt))}</span>
      </span>
      <span class="preview">${escapeHtml(session.latestPreview || "No output yet")}</span>
    `;
    button.addEventListener("click", async () => {
      state.selectedSessionId = session.id;
      await renderMessages();
      renderSessionCards(sessions);
    });
    sessionsEl.append(button);
  }
}

function refreshSessionCards(sessions) {
  if (sessions.length === 0) {
    if (sessionsEl.querySelector(".emptyInline")) return;
    renderSessionCards(sessions);
    return;
  }

  const cards = [...sessionsEl.querySelectorAll("button.sessionCard")];
  const currentIds = cards.map((card) => card.dataset.sessionId);
  const expectedIds = sessions.map((session) => session.id);
  if (
    cards.length !== expectedIds.length
    || currentIds.some((id, index) => id !== expectedIds[index])
  ) {
    renderSessionCards(sessions);
    return;
  }

  for (const session of sessions) {
    const button = sessionsEl.querySelector(`button.sessionCard[data-session-id="${session.id}"]`);
    const [primaryName, ...rest] = session.name.split(" · ");
    const sessionLabel = rest.length ? rest.join(" · ") : primaryName;
    button.classList.toggle("active", session.id === state.selectedSessionId);
    button.querySelector(".name").textContent = sessionLabel;
    button.querySelector(".when").textContent = shortDateTime(session.updatedAt);
    button.querySelector(".preview").textContent = session.latestPreview || "No output yet";
  }
}

function messageMeta(message) {
  if (!message.meta) return "";
  const parts = [];
  if (message.meta.model) parts.push(message.meta.model);
  if (message.meta.cliSessionId) parts.push(`session ${String(message.meta.cliSessionId).slice(0, 12)}`);
  if (message.meta.usage?.inputTokens || message.meta.usage?.outputTokens) {
    parts.push(`${message.meta.usage.inputTokens || 0} in / ${message.meta.usage.outputTokens || 0} out`);
  }
  if (message.meta.costUsd != null) parts.push(`$${message.meta.costUsd.toFixed(4)}`);
  if (message.meta.ok === false) parts.push("failed");
  return parts.join(" · ");
}

let messagesRequestId = 0;

async function renderMessages({ preserveScroll = false } = {}) {
  const requestId = ++messagesRequestId;
  const sessionId = state.selectedSessionId;
  if (!sessionId) {
    messagesEl.innerHTML = "";
    return;
  }

  const wasNearBottom = preserveScroll
    ? messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 48
    : false;
  const scrollTop = messagesEl.scrollTop;

  const data = await api(`/api/sessions/${sessionId}`);
  if (requestId !== messagesRequestId || sessionId !== state.selectedSessionId) return;

  messagesEl.innerHTML = "";
  for (const message of data.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    article.textContent = message.content;
    const meta = messageMeta(message);
    if (meta) {
      const footer = document.createElement("div");
      footer.className = "metaLine";
      footer.textContent = meta;
      article.append(footer);
    }
    messagesEl.append(article);
  }

  if (preserveScroll) {
    messagesEl.scrollTop = wasNearBottom ? messagesEl.scrollHeight : scrollTop;
  }
}

function openHandlerDialog(handler = null) {
  handlerDialogTitle.textContent = handler ? "Edit handler" : "New handler";
  handlerId.value = handler?.id || "";
  handlerName.value = handler?.name || "";
  handlerSource.value = handler?.source || "telegram";
  handlerSessionMode.value = handler?.sessionMode || "per_event";
  handlerPrompt.value = handler?.prompt || defaultPrompt;
  handlerEnabled.checked = handler?.enabled === true;
  deleteHandlerButton.classList.toggle("hidden", !handler);
  telegramBotToken.value = handler?.sourceConfig?.botToken || "";
  telegramChatId.value = handler?.sourceConfig?.chatId || "";
  composioCommand.value = handler?.sourceConfig?.command || "";
  composioProjectCwd.value = handler?.sourceConfig?.projectCwd || "";
  composioTriggerId.value = handler?.sourceConfig?.triggerId || "";
  composioTriggerSlug.value = handler?.sourceConfig?.triggerSlug || "";
  composioToolkits.value = handler?.sourceConfig?.toolkits || "";
  composioConnectedAccountId.value = handler?.sourceConfig?.connectedAccountId || "";
  composioUserId.value = handler?.sourceConfig?.userId || "";
  toggleSourceFields();
  handlerDialog.showModal();
}

function toggleSourceFields() {
  const source = handlerSource.value;
  telegramFields.classList.toggle("hidden", source !== "telegram");
  composioFields.classList.toggle("hidden", source !== "composio_trigger");
}

function handlerPayload() {
  const source = handlerSource.value;
  let sourceConfig = {};
  if (source === "telegram") {
    sourceConfig = {
      botToken: telegramBotToken.value.trim(),
      chatId: telegramChatId.value.trim(),
    };
  }
  if (source === "composio_trigger") {
    sourceConfig = {
      command: composioCommand.value.trim(),
      projectCwd: composioProjectCwd.value.trim(),
      triggerId: composioTriggerId.value.trim(),
      triggerSlug: composioTriggerSlug.value.trim(),
      toolkits: composioToolkits.value.trim(),
      connectedAccountId: composioConnectedAccountId.value.trim(),
      userId: composioUserId.value.trim(),
    };
  }
  return {
    name: handlerName.value.trim() || state.sourceLabels[source] || "Event handler",
    source,
    enabled: handlerEnabled.checked,
    sessionMode: handlerSessionMode.value,
    prompt: handlerPrompt.value.trim() || defaultPrompt,
    sourceConfig,
  };
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const data = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify({
        provider: settingsProvider.value,
        cwd: settingsCwd.value,
        model: settingsModel.value,
        bypassPermissions: settingsBypass.checked,
      }),
    });
    state.settings = data.settings;
    renderSettings();
  } catch (error) {
    alert(error.message);
  }
});

document.querySelector("#newHandlerButton").addEventListener("click", () => openHandlerDialog());
emptyStateNew.addEventListener("click", () => openHandlerDialog());
document.querySelector("#cancelHandlerButton").addEventListener("click", () => handlerDialog.close());
handlerSource.addEventListener("change", toggleSourceFields);
editHandlerButton.addEventListener("click", () => {
  const handler = state.handlers.find((entry) => entry.id === state.selectedHandlerId);
  if (handler) openHandlerDialog(handler);
});

duplicateHandlerButton.addEventListener("click", async () => {
  const handler = state.handlers.find((entry) => entry.id === state.selectedHandlerId);
  if (!handler) return;
  duplicateHandlerButton.disabled = true;
  try {
    const data = await api("/api/handlers", {
      method: "POST",
      body: JSON.stringify({
        name: duplicateName(handler.name),
        source: handler.source,
        enabled: false,
        sessionMode: handler.sessionMode || "per_event",
        prompt: handler.prompt,
        sourceConfig: cloneSourceConfig(handler.sourceConfig),
      }),
    });
    state.selectedHandlerId = data.handler.id;
    state.selectedSessionId = null;
    await loadState({ full: true });
  } catch (error) {
    alert(error.message);
  } finally {
    duplicateHandlerButton.disabled = false;
  }
});

deleteHandlerButton.addEventListener("click", async () => {
  const id = handlerId.value;
  if (!id) return;
  try {
    await api(`/api/handlers/${id}`, { method: "DELETE" });
    handlerDialog.close();
    state.selectedHandlerId = null;
    state.selectedSessionId = null;
    await loadState({ full: true });
  } catch (error) {
    alert(error.message);
  }
});

handlerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const id = handlerId.value;
  const path = id ? `/api/handlers/${id}` : "/api/handlers";
  const method = id ? "PUT" : "POST";
  try {
    const data = await api(path, {
      method,
      body: JSON.stringify(handlerPayload()),
    });
    state.selectedHandlerId = data.handler.id;
    handlerDialog.close();
    await loadState({ full: true });
  } catch (error) {
    alert(error.message);
  }
});

refreshButton.addEventListener("click", () => loadState());

testHandlerButton.addEventListener("click", async () => {
  const handler = state.handlers.find((entry) => entry.id === state.selectedHandlerId);
  if (!handler) return;
  testHandlerButton.disabled = true;
  try {
    const data = await api(`/api/handlers/${handler.id}/test`, {
      method: "POST",
      body: JSON.stringify({ text: "Manual test event from the Pager UI." }),
    });
    state.selectedSessionId = data.session.id;
    await loadState({ full: true });
  } catch (error) {
    alert(error.message);
  } finally {
    testHandlerButton.disabled = false;
  }
});

await loadState({ full: true });
setInterval(() => {
  loadState().catch(() => {});
}, 5000);
