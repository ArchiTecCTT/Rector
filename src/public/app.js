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

// Terminal run phases — a stream/poll stops once one of these is observed.
// Mirror of TERMINAL_RUN_PHASES in src/protocol/phases.ts (the server source of truth).
const TERMINAL_PHASES = new Set(["DONE", "NEEDS_DECISION", "FAILED", "ABORTED"]);

// Poll the fallback events endpoint every 2s (Requirement 2.8).
const POLL_INTERVAL_MS = 2000;

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

// --- Live run state (SSE stream with polling fallback, ORN-40) ---
// Holds the in-flight run's transport (EventSource or poll timer) and the events seen so far so the
// timeline can render incrementally. Only one run streams at a time; starting a new run or switching
// conversations tears the previous one down.
const liveRun = {
  runId: null,
  traceId: null,
  events: [],
  eventIds: new Set(),
  cost: null, // latest RunCostAggregate from a `cost` SSE frame (cumulative, replace-not-accumulate)
  source: null, // EventSource
  pollTimer: null,
  closed: true,
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
    "live-indicator",
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
    "cost-section",
    "cost-usd",
    "cost-total-tokens",
    "cost-input-tokens",
    "cost-output-tokens",
    "cost-model-calls",
    "cost-providers",
    "cost-models",
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Show/hide the live connection indicator. mode: "sse" (streaming), "polling" (fallback), or "off".
function setLiveIndicator(mode) {
  const el = els["live-indicator"];
  if (!el) return;
  if (mode === "off") {
    el.hidden = true;
    el.dataset.mode = "off";
    return;
  }
  el.hidden = false;
  el.dataset.mode = mode;
  const text = el.querySelector(".live-badge__text");
  if (text) text.textContent = mode === "polling" ? "POLLING" : "LIVE";
  el.title = mode === "polling" ? "Live updates via polling fallback" : "Live updates via streaming";
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

// --- Live run streaming (EventSource primary, polling fallback) — ORN-40 ---

// Reset live-run state for a freshly created run. Any prior stream must be torn down first.
function beginLiveRun({ runId, traceId }) {
  liveRun.runId = runId;
  liveRun.traceId = traceId || null;
  liveRun.events = [];
  liveRun.eventIds = new Set();
  liveRun.cost = null;
  liveRun.source = null;
  liveRun.pollTimer = null;
  liveRun.closed = false;
  resetCostPanel(); // a fresh run must never show the previous run's totals
}

// Close the EventSource and clear the poll timer so neither transport keeps running. Idempotent.
function teardownLiveRun() {
  if (liveRun.source) {
    try {
      liveRun.source.close();
    } catch {
      /* ignore */
    }
    liveRun.source = null;
  }
  if (liveRun.pollTimer) {
    clearInterval(liveRun.pollTimer);
    liveRun.pollTimer = null;
  }
  liveRun.closed = true;
  setLiveIndicator("off");
}

// Apply one persisted RunEvent to the live timeline, de-duplicating by event id (the catch-up
// replay and the polling fallback can both surface the same event).
function applyLiveEvent(event) {
  if (!event || !event.id || liveRun.closed) return;
  if (liveRun.eventIds.has(event.id)) return;
  liveRun.eventIds.add(event.id);
  liveRun.events.push(event);
  renderLiveTimeline();
}

// Render the timeline from the events seen so far, reusing the existing trace render helpers.
function renderLiveTimeline() {
  const events = liveRun.events;
  const lastPhase = events.length ? events[events.length - 1].phase : null;
  const run = { phase: lastPhase, traceId: liveRun.traceId };

  if (lastPhase) {
    setRunStatus(PHASE_STATUS_LABELS[lastPhase] || lastPhase, statusPillClass(lastPhase));
  }

  els["trace-empty"].hidden = true;
  els["trace-body"].hidden = false;
  els["trace-id"].textContent = liveRun.traceId || "—";
  renderTimeline(run, events);
  renderDecision(run, events);
  renderEvents(events);
}

// --- Live cost / token panel (ORN-41) ---

// Format a USD estimate. BYOK per-run costs are small, so keep 4 decimals for a stable readout.
function formatUsd(value) {
  const n = Number(value);
  return `$${(Number.isFinite(n) ? n : 0).toFixed(4)}`;
}

// Format an integer token/count with thousands separators; non-numeric inputs read as 0.
function formatCount(value) {
  const n = Number(value);
  return (Number.isFinite(n) ? n : 0).toLocaleString();
}

// Format a string list (providers/models) as a comma-separated readout, or an em dash when empty.
function formatList(values) {
  return Array.isArray(values) && values.length ? values.join(", ") : "—";
}

// Reset and hide the cost panel (new run begins or conversation switches) so no stale total shows.
function resetCostPanel() {
  if (els["cost-section"]) els["cost-section"].hidden = true;
  if (els["cost-usd"]) els["cost-usd"].textContent = "$0.0000";
  if (els["cost-total-tokens"]) els["cost-total-tokens"].textContent = "0";
  if (els["cost-input-tokens"]) els["cost-input-tokens"].textContent = "0";
  if (els["cost-output-tokens"]) els["cost-output-tokens"].textContent = "0";
  if (els["cost-model-calls"]) els["cost-model-calls"].textContent = "0";
  if (els["cost-providers"]) els["cost-providers"].textContent = "—";
  if (els["cost-models"]) els["cost-models"].textContent = "—";
}

// Render a RunCostAggregate into the cost panel. Each aggregate is the cumulative running total, so
// values are replaced, not accumulated. Defensive against missing fields.
function renderCostPanel(cost) {
  if (!cost || typeof cost !== "object") return;
  if (els["cost-section"]) els["cost-section"].hidden = false;
  if (els["cost-usd"]) els["cost-usd"].textContent = formatUsd(cost.estimatedUsd);
  if (els["cost-total-tokens"]) els["cost-total-tokens"].textContent = formatCount(cost.totalTokens);
  if (els["cost-input-tokens"]) els["cost-input-tokens"].textContent = formatCount(cost.inputTokens);
  if (els["cost-output-tokens"]) els["cost-output-tokens"].textContent = formatCount(cost.outputTokens);
  if (els["cost-model-calls"]) els["cost-model-calls"].textContent = formatCount(cost.modelCalls);
  if (els["cost-providers"]) els["cost-providers"].textContent = formatList(cost.providers);
  if (els["cost-models"]) els["cost-models"].textContent = formatList(cost.models);
}

// Apply a `cost` SSE frame's aggregate to the panel while the run is live.
function applyCostFrame(cost) {
  if (!cost || liveRun.closed) return;
  liveRun.cost = cost;
  renderCostPanel(cost);
}
// Stream a run to completion. Opens an EventSource and applies `run-event` frames to the timeline,
// closing on a `done`/`error` frame. If `EventSource` is unavailable or the stream errors, falls
// back to polling the events endpoint every 2s until a Terminal_Phase (Requirement 2.8). Resolves
// with the terminal phase (best-effort) once the run finishes.
function streamRun({ runId }) {
  return new Promise((resolve) => {
    let resolved = false;

    const finishTerminal = (phase) => {
      if (resolved) return;
      resolved = true;
      teardownLiveRun();
      resolve(phase);
    };

    const startPolling = () => {
      if (liveRun.pollTimer || resolved) return;
      setLiveIndicator("polling");
      const tick = async () => {
        if (liveRun.closed || resolved) return;
        try {
          const data = await api(`/runs/${runId}/events`);
          for (const ev of data.events || []) applyLiveEvent(ev);
          const phase = data.run?.phase;
          if (phase && TERMINAL_PHASES.has(phase)) finishTerminal(phase);
        } catch {
          // Transient poll failure (e.g. the run row not yet visible): keep polling.
        }
      };
      liveRun.pollTimer = setInterval(tick, POLL_INTERVAL_MS);
      void tick(); // poll immediately, don't wait the first interval
    };

    // No EventSource support -> polling fallback (Requirement 2.8).
    if (!window.EventSource) {
      startPolling();
      return;
    }

    let source;
    try {
      source = new EventSource(`${API}/runs/${runId}/stream`);
    } catch {
      startPolling();
      return;
    }
    liveRun.source = source;
    setLiveIndicator("sse");

    source.addEventListener("run-event", (e) => {
      try {
        const frame = JSON.parse(e.data); // { type, runId, event }
        if (frame && frame.event) applyLiveEvent(frame.event);
      } catch {
        /* ignore malformed frame */
      }
    });

    source.addEventListener("done", (e) => {
      let phase;
      try {
        phase = JSON.parse(e.data).phase; // { type, runId, phase }
      } catch {
        /* phase stays undefined */
      }
      finishTerminal(phase);
    });

    // `cost` frames carry the current cumulative RunCostAggregate; apply the latest to the panel.
    source.addEventListener("cost", (e) => {
      try {
        const frame = JSON.parse(e.data); // { type, runId, cost }
        if (frame && frame.cost) applyCostFrame(frame.cost);
      } catch {
        /* ignore malformed frame */
      }
    });

    // Any other unknown frame types are ignored gracefully without breaking the stream.

    // `onerror` fires both for transport failures and for the normal server close after `done`.
    // If the run already finished, ignore it; otherwise the stream errored mid-run, so per
    // Requirement 2.8 tear the stream down and fall back to polling.
    source.onerror = () => {
      if (resolved) return;
      try {
        source.close();
      } catch {
        /* ignore */
      }
      liveRun.source = null;
      startPolling();
    };
  });
}

// The assistant message is created by the background run just after the terminal event is persisted,
// so retry briefly until it appears for this runId.
async function findAssistantMessage(conversationId, runId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const data = await api(`/chat/conversations/${conversationId}`);
      const messages = data.messages || [];
      const found = [...messages].reverse().find((m) => m.role === "assistant" && m.runId === runId);
      if (found) return found;
    } catch {
      /* retry */
    }
    await delay(300);
  }
  return null;
}

// After a streamed run reaches a Terminal_Phase, render the authoritative final result: replace the
// pending bubble with the assistant message and render the final trace from the persisted run/events.
async function finalizeRun({ conversationId, runId, pending, phase }) {
  let run = null;
  let events = [];
  try {
    const data = await api(`/runs/${runId}/events`);
    run = data.run || null;
    events = data.events || [];
  } catch {
    // Fall back to whatever the live stream collected.
    events = liveRun.events;
  }

  const assistant = await findAssistantMessage(conversationId, runId);
  pending.remove();

  // Fetch the authoritative final cost aggregate so the panel shows the correct final total even if
  // the last live `cost` frame was missed (e.g. on the polling fallback). Defensive: a missing
  // endpoint or payload must not break finalize — we keep whatever the last live frame rendered.
  try {
    const cost = await api(`/runs/${runId}/cost`);
    if (cost && typeof cost === "object") renderCostPanel(cost);
  } catch {
    if (liveRun.cost) renderCostPanel(liveRun.cost);
  }

  // Observability/cost panel population is handled by tasks 11.2 / 12.1; the events endpoint does
  // not carry the in-process observability summary, so the cost stats stay at their defaults here.
  const result = { run: run || { phase, traceId: liveRun.traceId }, events };

  if (assistant) {
    state.lastResultByMessage.set(assistant.id, result);
    renderMessage("assistant", assistant.content, { messageId: assistant.id, withTraceLink: true });
  } else {
    renderMessage("assistant", "Run finished, but its response could not be loaded.", {});
  }

  const finalPhase = (run && run.phase) || phase;
  setRunStatus(
    PHASE_STATUS_LABELS[finalPhase] || finalPhase || "Done",
    statusPillClass(finalPhase, run?.status)
  );
  renderTrace(result);
}

// --- Send flow ---
async function sendMessage(content) {
  const trimmed = content.trim();
  if (!trimmed) return;

  teardownLiveRun(); // clean up any previous in-flight stream
  resetCostPanel(); // a new send starts with no cost shown until frames/finalize arrive
  els["composer-send"].disabled = true;
  renderMessage("user", trimmed);
  const pending = renderMessage("assistant", "Running local pipeline…", { pending: true });
  setRunStatus("Thinking", "status-pill--running");

  try {
    const conversationId = await ensureConversation();

    // Primary path: stream the run. The streaming branch creates the run and returns
    // { runId, traceId } with 202 before any Terminal_Phase, then runs the pipeline in the
    // background while events are published to the SSE broker.
    const response = await api(`/chat/conversations/${conversationId}/messages?stream=1`, {
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

    if (response && response.runId) {
      // Streaming/polling path.
      beginLiveRun({ runId: response.runId, traceId: response.traceId });
      const phase = await streamRun({ runId: response.runId });
      await finalizeRun({ conversationId, runId: response.runId, pending, phase });
    } else if (response && response.assistantMessage) {
      // Synchronous fallback: the server returned the full result (no streaming branch). Render it
      // directly, preserving the original behavior.
      pending.remove();
      const assistantId = response.assistantMessage.id;
      if (assistantId) state.lastResultByMessage.set(assistantId, response);
      renderMessage("assistant", response.assistantMessage.content, {
        messageId: assistantId,
        withTraceLink: true,
      });
      const phase = response.run?.phase;
      setRunStatus(PHASE_STATUS_LABELS[phase] || phase || "Done", statusPillClass(phase, response.run?.status));
      renderTrace(response);
    } else {
      throw new Error("Unexpected response from server");
    }
  } catch (err) {
    teardownLiveRun();
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
  teardownLiveRun(); // stop any in-flight stream/poll when switching away
  resetCostPanel(); // clear any prior run's cost totals so a new/empty trace shows none
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
