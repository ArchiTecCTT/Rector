// ============================================================
// Rector local chat UI — client logic
// Talks only to the real provider-free chat API. No fabricated
// data: the timeline, trace, and observability are built from
// actual run events returned by the backend.
// ============================================================

const API = "/api";

// Canonical run phases (mirror of src/protocol/phases.ts).
const RUN_PHASES = [
  "CHAT_RECEIVED",
  "TRIAGE",
  "CONTEXT_BUILDING",
  "PLANNING",
  "SKEPTIC_REVIEW",
  "CRUCIBLE",
  "DAG_COMPILATION",
  "EXECUTING",
  "VALIDATING",
  "HEALING",
  "SYNTHESIZING",
  "DONE",
];

// User-facing status labels per phase (mirror of RUN_PHASE_STATUS_LABELS).
const PHASE_STATUS_LABELS = {
  CHAT_RECEIVED: "Thinking",
  TRIAGE: "Thinking",
  CONTEXT_BUILDING: "Thinking",
  PLANNING: "Planning",
  SKEPTIC_REVIEW: "Planning",
  CRUCIBLE: "Planning",
  DAG_COMPILATION: "Planning",
  EXECUTING: "Executing",
  VALIDATING: "Validating",
  HEALING: "Repairing",
  SYNTHESIZING: "Thinking",
  DONE: "Done",
  NEEDS_DECISION: "Needs decision",
  FAILED: "Failed",
  ABORTED: "Failed",
};

// --- Client state ---
const state = {
  conversationId: null,
  conversations: [],
  lastResultByMessage: new Map(), // assistantMessageId -> result payload (for trace)
};

// --- DOM refs ---
const els = {};

function cacheEls() {
  const ids = [
    "conversation-list",
    "conversation-empty",
    "new-conversation",
    "health-indicator",
    "chat-title",
    "run-status",
    "toggle-trace",
    "close-trace",
    "messages",
    "empty-state",
    "suggestions",
    "composer",
    "composer-input",
    "composer-send",
    "trace-drawer",
    "trace-empty",
    "trace-body",
    "trace-status",
    "trace-route",
    "trace-complexity",
    "trace-id",
    "obs-spans",
    "obs-duration",
    "obs-calls",
    "obs-cost",
    "timeline",
    "decision-section",
    "decision-card",
    "events",
  ];
  for (const id of ids) {
    els[id] = document.getElementById(id);
  }
}

// --- API helper ---
async function api(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

// --- Utility ---
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function statusPillClass(phase, runStatus) {
  if (phase === "FAILED" || phase === "ABORTED" || runStatus === "failed" || runStatus === "aborted") {
    return "status-pill--failed";
  }
  if (phase === "NEEDS_DECISION" || runStatus === "needs_decision") {
    return "status-pill--decision";
  }
  if (phase === "DONE" || runStatus === "completed") {
    return "status-pill--done";
  }
  return "status-pill--running";
}

function setRunStatus(label, pillClass) {
  els["run-status"].textContent = label;
  els["run-status"].className = `status-pill ${pillClass}`;
}

// --- Health check ---
async function checkHealth() {
  try {
    await api("/setup");
    els["health-indicator"].textContent = "online";
    els["health-indicator"].classList.remove("muted");
  } catch {
    els["health-indicator"].textContent = "offline";
  }
}

// --- Conversations ---
async function loadConversations() {
  try {
    const data = await api("/chat/conversations?workspaceId=browser");
    state.conversations = data.conversations || [];
    renderConversationList();
  } catch (err) {
    console.error("Failed to load conversations", err);
  }
}

function renderConversationList() {
  const list = els["conversation-list"];
  list.innerHTML = "";
  if (!state.conversations.length) {
    const empty = document.createElement("p");
    empty.className = "conversation-list__empty";
    empty.textContent = "No conversations yet. Send a message to start one.";
    list.appendChild(empty);
    return;
  }
  for (const conv of state.conversations) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "conversation-item" + (conv.id === state.conversationId ? " active" : "");
    item.textContent = conv.title || "Untitled conversation";
    item.title = conv.title || conv.id;
    item.addEventListener("click", () => openConversation(conv.id));
    list.appendChild(item);
  }
}

async function ensureConversation() {
  if (state.conversationId) return state.conversationId;
  const conv = await api("/chat/conversations", {
    method: "POST",
    body: JSON.stringify({ title: "New conversation", workspaceId: "browser" }),
  });
  state.conversationId = conv.id;
  state.conversations.unshift(conv);
  renderConversationList();
  return conv.id;
}

function startNewConversation() {
  state.conversationId = null;
  els["chat-title"].textContent = "New conversation";
  setRunStatus("Idle", "status-pill--idle");
  clearMessages(true);
  resetTrace();
  renderConversationList();
  els["composer-input"].focus();
}

async function openConversation(id) {
  if (!id) return;
  state.conversationId = id;
  renderConversationList();
  resetTrace();
  try {
    const data = await api(`/chat/conversations/${id}`);
    els["chat-title"].textContent = data.conversation?.title || "Conversation";
    clearMessages(false);
    const messages = data.messages || [];
    for (const message of messages) {
      renderMessage(message.role, message.content, { messageId: message.id });
    }
    // We don't have stored run events for historical messages here; trace is
    // available for messages sent in this session.
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    if (lastAssistant) {
      setRunStatus("Done", "status-pill--done");
    }
  } catch (err) {
    console.error("Failed to open conversation", err);
  }
}

// --- Messages ---
function clearMessages(showEmpty) {
  els["messages"].innerHTML = "";
  if (showEmpty && els["empty-state"]) {
    // Rebuild the empty state by reloading the suggestions block.
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `
      <div class="empty-state__mark" aria-hidden="true"></div>
      <h2>Chat with Rector</h2>
      <p>Every message runs the full local pipeline on deterministic fake adapters. No providers are called.</p>`;
    els["messages"].appendChild(empty);
  }
}

function removeEmptyState() {
  const empty = els["messages"].querySelector(".empty-state");
  if (empty) empty.remove();
}

function renderMessage(role, content, opts = {}) {
  removeEmptyState();
  const wrap = document.createElement("div");
  wrap.className = `msg msg--${role}`;
  if (opts.messageId) wrap.dataset.messageId = opts.messageId;

  const roleEl = document.createElement("div");
  roleEl.className = "msg__role";
  roleEl.textContent = role === "user" ? "You" : "Rector";

  const bubble = document.createElement("div");
  bubble.className = "msg__bubble";
  if (opts.pending) bubble.classList.add("is-pending");
  bubble.textContent = content;

  wrap.appendChild(roleEl);
  wrap.appendChild(bubble);

  if (role === "assistant" && opts.withTraceLink) {
    const footer = document.createElement("div");
    footer.className = "msg__footer";
    const link = document.createElement("button");
    link.type = "button";
    link.className = "msg__trace-link";
    link.textContent = "View trace";
    link.addEventListener("click", () => {
      if (opts.messageId) renderTraceForMessage(opts.messageId);
      openTrace();
    });
    footer.appendChild(link);
    wrap.appendChild(footer);
  }

  els["messages"].appendChild(wrap);
  els["messages"].scrollTop = els["messages"].scrollHeight;
  return wrap;
}

// --- Send flow ---
async function sendMessage(content) {
  const trimmed = content.trim();
  if (!trimmed) return;

  els["composer-send"].disabled = true;
  renderMessage("user", trimmed);
  const pending = renderMessage("assistant", "Running local pipeline…", { pending: true });
  setRunStatus("Thinking", "status-pill--running");

  try {
    const conversationId = await ensureConversation();
    const result = await api(`/chat/conversations/${conversationId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: trimmed }),
    });

    // Title the conversation from the first message if still default.
    const conv = state.conversations.find((c) => c.id === conversationId);
    if (conv && conv.title === "New conversation") {
      conv.title = trimmed.slice(0, 48);
      els["chat-title"].textContent = conv.title;
      renderConversationList();
    }

    // Replace pending bubble with the real assistant message.
    pending.remove();
    const assistantId = result.assistantMessage?.id;
    if (assistantId) {
      state.lastResultByMessage.set(assistantId, result);
    }
    renderMessage("assistant", result.assistantMessage.content, {
      messageId: assistantId,
      withTraceLink: true,
    });

    const phase = result.run?.phase;
    const runStatus = result.run?.status;
    setRunStatus(PHASE_STATUS_LABELS[phase] || phase || "Done", statusPillClass(phase, runStatus));

    renderTrace(result);
  } catch (err) {
    pending.remove();
    renderMessage("assistant", `Error: ${err.message}`, {});
    setRunStatus("Failed", "status-pill--failed");
  } finally {
    els["composer-send"].disabled = false;
    els["composer-input"].focus();
  }
}

// --- Trace drawer ---
function openTrace() {
  document.querySelector(".app").classList.add("trace-open");
  els["toggle-trace"].setAttribute("aria-pressed", "true");
}

function closeTrace() {
  document.querySelector(".app").classList.remove("trace-open");
  els["toggle-trace"].setAttribute("aria-pressed", "false");
}

function toggleTrace() {
  const isOpen = document.querySelector(".app").classList.contains("trace-open");
  if (isOpen) closeTrace();
  else openTrace();
}

function resetTrace() {
  els["trace-empty"].hidden = false;
  els["trace-body"].hidden = true;
}

function renderTraceForMessage(messageId) {
  const result = state.lastResultByMessage.get(messageId);
  if (result) renderTrace(result);
}

function findEventPayload(events, predicate) {
  const event = events.find(predicate);
  return event ? event.payload || {} : null;
}

function renderTrace(result) {
  const run = result.run || {};
  const events = result.events || [];
  const obs = result.observability || {};

  els["trace-empty"].hidden = true;
  els["trace-body"].hidden = false;

  // Summary
  els["trace-status"].textContent = run.status ? run.status.toUpperCase() : "—";
  els["trace-route"].textContent = run.route || "—";
  els["trace-complexity"].textContent = run.complexity || "—";
  els["trace-id"].textContent = run.traceId || "—";

  // Observability
  els["obs-spans"].textContent = obs.spanCount ?? 0;
  els["obs-duration"].textContent = `${obs.durationMs ?? 0}ms`;
  els["obs-calls"].textContent = obs.modelCallCount ?? 0;
  els["obs-cost"].textContent = `$${obs.estimatedCostUsd ?? 0}`;

  renderTimeline(run, events);
  renderDecision(run, events);
  renderEvents(events);
}

function renderTimeline(run, events) {
  const reachedPhases = new Set(events.map((e) => e.phase));
  const finalPhase = run.phase;
  const isTerminalBad = finalPhase === "FAILED" || finalPhase === "ABORTED" || finalPhase === "NEEDS_DECISION";

  // Map phase -> short evidence pulled from real event payloads.
  const evidence = buildPhaseEvidence(events);

  const timeline = els["timeline"];
  timeline.innerHTML = "";

  for (const phase of RUN_PHASES) {
    const reached = reachedPhases.has(phase);
    // Skip phases never reached, except always show DONE outcome at the end.
    if (!reached && phase !== "DONE") continue;

    const li = document.createElement("li");
    li.className = "timeline__item";
    if (phase === finalPhase) {
      li.classList.add("timeline__item--active");
    } else if (reached) {
      li.classList.add("timeline__item--done");
    }

    const dot = document.createElement("span");
    dot.className = "timeline__dot";

    const label = document.createElement("span");
    label.className = "timeline__phase";
    label.textContent = phase;

    const meta = document.createElement("span");
    meta.className = "timeline__meta";
    meta.textContent = evidence[phase] || "";

    li.appendChild(dot);
    li.appendChild(label);
    li.appendChild(meta);
    timeline.appendChild(li);
  }

  // If the run ended in a non-DONE terminal phase, append it explicitly.
  if (isTerminalBad) {
    const li = document.createElement("li");
    li.className =
      "timeline__item " +
      (finalPhase === "NEEDS_DECISION" ? "timeline__item--decision" : "timeline__item--failed");
    const dot = document.createElement("span");
    dot.className = "timeline__dot";
    const label = document.createElement("span");
    label.className = "timeline__phase";
    label.textContent = finalPhase;
    li.appendChild(dot);
    li.appendChild(label);
    timeline.appendChild(li);
  }
}

function buildPhaseEvidence(events) {
  const evidence = {};
  for (const event of events) {
    const p = event.payload || {};
    if (event.phase === "TRIAGE" && p.triage) {
      evidence.TRIAGE = `${p.triage.route}/${p.triage.complexity}`;
    }
    if (event.phase === "SKEPTIC_REVIEW" && p.skepticReview) {
      const f = p.skepticReview.findings ? p.skepticReview.findings.length : 0;
      evidence.SKEPTIC_REVIEW = `${p.skepticReview.verdict} (${f})`;
    }
    if (event.phase === "CRUCIBLE" && p.crucibleDecision) {
      evidence.CRUCIBLE = p.crucibleDecision.verdict;
    }
    if (event.phase === "DAG_COMPILATION" && p.compiledDag) {
      const n = p.compiledDag.nodes ? p.compiledDag.nodes.length : 0;
      evidence.DAG_COMPILATION = `${n} nodes`;
    }
    if (event.phase === "EXECUTING" && p.executionResult) {
      evidence.EXECUTING = p.executionResult.status;
    }
    if (event.phase === "VALIDATING" && p.validationHealingResult) {
      evidence.VALIDATING = p.validationHealingResult.status;
    }
    if (event.phase === "PLANNING" && p.plannerOutput) {
      const t = p.plannerOutput.tasks ? p.plannerOutput.tasks.length : 0;
      evidence.PLANNING = `${t} tasks`;
    }
  }
  return evidence;
}

function renderDecision(run, events) {
  const section = els["decision-section"];
  const decisionEvent = findEventPayload(events, (e) => e.type === "DECISION_REQUESTED");
  const hasDecision = run.phase === "NEEDS_DECISION" || run.decisionRequest || decisionEvent;

  if (!hasDecision) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  const detail = run.decisionRequest || decisionEvent || {};
  els["decision-card"].textContent =
    typeof detail === "object" && Object.keys(detail).length
      ? JSON.stringify(detail, null, 2)
      : "This run paused for a human decision. No additional detail was provided by the local pipeline.";
}

function renderEvents(events) {
  const container = els["events"];
  container.innerHTML = "";
  for (const event of events) {
    const row = document.createElement("div");
    row.className = "event";
    const type = document.createElement("span");
    type.className = "event__type";
    type.textContent = event.type;
    const phase = document.createElement("span");
    phase.className = "event__phase";
    phase.textContent = event.phase;
    row.appendChild(type);
    row.appendChild(phase);
    container.appendChild(row);
  }
}

// --- Composer behavior ---
function autoGrow(textarea) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
}

function bindComposer() {
  const form = els["composer"];
  const input = els["composer-input"];

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const content = input.value;
    input.value = "";
    autoGrow(input);
    sendMessage(content);
  });

  input.addEventListener("input", () => autoGrow(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

function bindSuggestions() {
  els["messages"].addEventListener("click", (event) => {
    const btn = event.target.closest(".suggestion");
    if (!btn) return;
    const prompt = btn.dataset.prompt || btn.textContent.trim();
    els["composer-input"].value = prompt;
    els["composer"].requestSubmit();
  });
}

// --- Init ---
function init() {
  cacheEls();
  bindComposer();
  bindSuggestions();

  els["new-conversation"].addEventListener("click", startNewConversation);
  els["toggle-trace"].addEventListener("click", toggleTrace);
  els["close-trace"].addEventListener("click", closeTrace);

  checkHealth();
  loadConversations();
  els["composer-input"].focus();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
