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

// --- Provider connection test (Provider_Test_Panel, Requirement 2) ---

// Client-side timeout for a connection test (Requirement 2.7). After this elapses the in-flight
// request is aborted, the loading indicator is cleared, and a redaction-safe timeout message shows.
const PROVIDER_TEST_TIMEOUT_MS = 30_000;

// The configured providers the panel can test. Ids mirror `SUPPORTED_PROVIDER_IDS` in
// src/api/server.ts (the server rejects any id outside this set before building a provider). Labels
// are static, non-secret display names.
const PROVIDERS = [
  { id: "together", label: "Together AI" },
  { id: "cloudflare", label: "Cloudflare Workers AI" },
  { id: "azure-openai", label: "Azure OpenAI" },
];

const PROVIDER_LABELS = new Map(PROVIDERS.map((p) => [p.id, p.label]));

// --- Setup Wizard (Setup_Wizard, Requirement 1) ---

// Client-side timeout for the setup-status fetch (Requirement 1.9). After this elapses the in-flight
// request is aborted and the wizard shows an error state while chat/trace stay accessible.
const SETUP_STATUS_TIMEOUT_MS = 10_000;

// Static, non-secret display labels for the four configuration categories (Requirement 1.2).
const SETUP_CATEGORY_LABELS = {
  provider: "Provider",
  persistence: "Persistence",
  workspace: "Workspace",
  budget: "Budget",
};

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

// --- Phase_Cards (Trace_Drawer supervision surface, Req 7.1–7.3, 7.6) ---
//
// The nine canonical pipeline phases rendered as collapsible cards, in order
// (Req 7.1). Each card maps to one or more real RUN_PHASES; a card's status,
// duration, and evidence are derived ONLY from the actual persisted run events
// (Req 7.5 / Property 9) — never fabricated. Validation and healing are a single
// "Validation & healing" card because healing is a conditional follow-on phase.
const PHASE_CARDS = [
  { id: "triage", label: "Triage", phases: ["TRIAGE"] },
  { id: "context", label: "Context building", phases: ["CONTEXT_BUILDING"] },
  { id: "planning", label: "Planning", phases: ["PLANNING"] },
  { id: "skeptic", label: "Skeptic review", phases: ["SKEPTIC_REVIEW"] },
  { id: "crucible", label: "Crucible arbitration", phases: ["CRUCIBLE"] },
  { id: "dag", label: "DAG compilation", phases: ["DAG_COMPILATION"] },
  { id: "execution", label: "Execution", phases: ["EXECUTING"] },
  { id: "validation", label: "Validation & healing", phases: ["VALIDATING", "HEALING"] },
  { id: "synthesis", label: "Synthesis", phases: ["SYNTHESIZING"] },
];

// Closed set of Phase_Card statuses with their accessible label + glyph. Status is
// never conveyed by color alone — the label text and an icon accompany it (Req 9.4).
const PHASE_CARD_STATUS_META = {
  pending: { label: "Pending", icon: "○" },
  active: { label: "Active", icon: "◐" },
  done: { label: "Done", icon: "●" },
  failed: { label: "Failed", icon: "✕" },
  decision: { label: "Needs decision", icon: "!" },
};

// Expansion state for the Phase_Cards, preserved across live re-renders within a
// run so a user's expand/collapse choice is not lost as new events stream in.
// `phaseCardsAutoExpanded` guards the one-time auto-expand of the current phase.
let phaseCardExpanded = new Set();
let phaseCardsAutoExpanded = false;

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
    "phase-cards",
    "decision-section",
    "decision-card",
    "events",
    "open-provider-test",
    "close-provider-test",
    "provider-test-modal",
    "provider-test-backdrop",
    "provider-list",
    "provider-test-result",
    "provider-test-loading",
    "run-provider-test",
    "open-provider-config",
    "close-provider-config",
    "provider-config-modal",
    "provider-config-backdrop",
    "provider-config-loading",
    "provider-config-error",
    "provider-config-cards",
    "provider-config-adv-cards",
    "provider-config-adv-form",
    "provider-config-adv-label",
    "provider-config-adv-baseurl",
    "provider-config-adv-model",
    "provider-config-adv-key",
    "provider-config-adv-key-toggle",
    "provider-config-adv-add",
    "provider-config-adv-result",
    "open-setup-wizard",
    "close-setup-wizard",
    "setup-wizard-modal",
    "setup-wizard-backdrop",
    "setup-wizard-body",
    "setup-wizard-mode",
    "setup-wizard-categories",
    "setup-wizard-loading",
    "setup-wizard-error",
    "open-workspace-safety",
    "close-workspace-safety",
    "workspace-safety-modal",
    "workspace-safety-backdrop",
    "workspace-safety-loading",
    "workspace-safety-unavailable",
    "workspace-safety-detail",
    "safety-workspace-root",
    "safety-destructive",
    "safety-allowlist",
    "safety-approval",
    "open-approval",
    "approval-badge",
    "close-approval",
    "approval-modal",
    "approval-backdrop",
    "approval-empty",
    "approval-detail",
    "approval-run-id",
    "approval-operation-id",
    "approval-target-path",
    "approval-command-block",
    "approval-command",
    "approval-risky",
    "approval-diff",
    "approval-decided-by",
    "approval-result",
    "approval-foot",
    "approval-loading",
    "approval-deny",
    "approval-approve",
    "open-appearance",
    "close-appearance",
    "appearance-modal",
    "appearance-backdrop",
    "appearance-theme-list",
    "appearance-accent-list",
    "appearance-accent-warning",
    "appearance-density",
    "appearance-fontscale",
    "appearance-reduced-motion",
    "appearance-reset",
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
  // Assistant messages render Markdown as formatted content (Req 6.3); the
  // renderer escapes/sanitizes all input, so the HTML string is XSS-safe.
  // User messages (and transient pending bubbles) stay plain text.
  if (role === "assistant" && !opts.pending && window.RectorMarkdown) {
    bubble.innerHTML = window.RectorMarkdown.render(content);
  } else {
    bubble.textContent = content;
  }

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
  resetPhaseCards(); // a fresh run starts with no expand state seeded
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
  // A run that pauses for an approval decision emits a DECISION_REQUESTED event carrying the
  // redacted approval request; surface it in the Approval_Flow panel (Req 9.1, 9.2).
  maybePresentApprovalFromEvent(event);
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
  resetPhaseCards(); // clear any prior run's phase-card expand state
  els["trace-empty"].hidden = false;
  els["trace-body"].hidden = true;
}

// Clear the Phase_Cards expand state and the one-time auto-expand guard so a new
// or switched-to run starts clean.
function resetPhaseCards() {
  phaseCardExpanded = new Set();
  phaseCardsAutoExpanded = false;
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
  renderPhaseCards(run, events);
}

// Format a phase duration derived from real event timestamps. Never invents a
// value: callers pass `null` when no real duration can be computed.
function formatPhaseDuration(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function phaseRunIndex(phase) {
  return RUN_PHASES.indexOf(phase);
}

// Build the shared derivation context for all Phase_Cards from real run data
// (the persisted events + the run's terminal phase/status). No fabrication.
function buildPhaseCardContext(run, events) {
  const reachedPhases = new Set(events.map((e) => e.phase));
  const realReachedIdx = events
    .map((e) => phaseRunIndex(e.phase))
    .filter((i) => i >= 0);
  const maxReachedIdx = realReachedIdx.length ? Math.max(...realReachedIdx) : -1;
  const finalPhase = run.phase;
  const completed =
    reachedPhases.has("DONE") || finalPhase === "DONE" || run.status === "completed";
  const terminalBad =
    finalPhase === "FAILED" ||
    finalPhase === "ABORTED" ||
    finalPhase === "NEEDS_DECISION" ||
    run.status === "failed" ||
    run.status === "aborted" ||
    run.status === "needs_decision";
  const terminalKind =
    finalPhase === "NEEDS_DECISION" || run.status === "needs_decision" ? "decision" : "failed";
  return { reachedPhases, maxReachedIdx, completed, terminalBad, terminalKind };
}

// Derive a single Phase_Card's status from the real-event context. Distinguishes
// pending / active / done / failed / decision (Req 7.2).
function derivePhaseCardStatus(card, ctx) {
  const reached = card.phases.some((p) => ctx.reachedPhases.has(p));
  if (!reached) return "pending";
  const cardIdx = Math.max(...card.phases.map(phaseRunIndex));
  // The furthest-reached real phase is where a bad terminal outcome landed.
  if (ctx.terminalBad && cardIdx === ctx.maxReachedIdx) return ctx.terminalKind;
  if (ctx.completed || cardIdx < ctx.maxReachedIdx) return "done";
  return "active";
}

// Compute a phase's elapsed time strictly from real event timestamps: the span
// from the card's first event to the first event of any later phase. Returns null
// when no real duration is derivable (so the UI shows nothing, not a fake value).
function phaseCardDurationMs(card, events) {
  const ts = (e) => Date.parse(e.createdAt);
  const cardIdx = Math.max(...card.phases.map(phaseRunIndex));
  const cardStamps = events
    .filter((e) => card.phases.includes(e.phase))
    .map(ts)
    .filter((n) => Number.isFinite(n));
  if (!cardStamps.length) return null;
  const start = Math.min(...cardStamps);
  const laterStamps = events
    .filter((e) => phaseRunIndex(e.phase) > cardIdx)
    .map(ts)
    .filter((n) => Number.isFinite(n) && n >= start);
  if (!laterStamps.length) return null;
  const duration = Math.min(...laterStamps) - start;
  return duration >= 0 ? duration : null;
}

// Toggle a Phase_Card's expand/collapse state, keeping aria-expanded and the
// body's hidden attribute in sync (accessible button semantics, Req 7.3).
function setPhaseCardExpanded(cardId, header, body, expanded) {
  header.setAttribute("aria-expanded", expanded ? "true" : "false");
  body.hidden = !expanded;
  if (expanded) phaseCardExpanded.add(cardId);
  else phaseCardExpanded.delete(cardId);
}

// Render the Phase_Card list from real run events. Reuses the existing
// reachedPhases/finalPhase derivation and buildPhaseEvidence; every rendered
// value (status, duration, evidence, events) comes from real data (Req 7.1–7.6).
function renderPhaseCards(run, events) {
  const container = els["phase-cards"];
  if (!container) return;
  container.innerHTML = "";

  const ctx = buildPhaseCardContext(run, events);
  const evidence = buildPhaseEvidence(events);

  // One-time auto-expand of the current/terminal phase so the most relevant
  // card is open by default; subsequent user toggles are preserved.
  if (!phaseCardsAutoExpanded) {
    for (const card of PHASE_CARDS) {
      const status = derivePhaseCardStatus(card, ctx);
      if (status === "active" || status === "failed" || status === "decision") {
        phaseCardExpanded.add(card.id);
        phaseCardsAutoExpanded = true;
        break;
      }
    }
  }

  for (const card of PHASE_CARDS) {
    const status = derivePhaseCardStatus(card, ctx);
    const meta = PHASE_CARD_STATUS_META[status];
    const bodyId = `phase-body-${card.id}`;
    const expanded = phaseCardExpanded.has(card.id);

    const cardEl = document.createElement("div");
    cardEl.className = `phase-card phase-card--${status}`;
    cardEl.dataset.phase = card.id;
    cardEl.dataset.status = status;
    cardEl.setAttribute("role", "listitem");

    // Header is a real <button> for accessible expand/collapse semantics.
    const header = document.createElement("button");
    header.type = "button";
    header.className = "phase-card__header";
    header.setAttribute("aria-expanded", expanded ? "true" : "false");
    header.setAttribute("aria-controls", bodyId);

    const icon = document.createElement("span");
    icon.className = "phase-card__icon";
    icon.dataset.status = status;
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = meta.icon;

    const name = document.createElement("span");
    name.className = "phase-card__name";
    name.textContent = card.label;

    // Status as text (never color alone, Req 9.4).
    const statusEl = document.createElement("span");
    statusEl.className = "phase-card__status";
    statusEl.textContent = meta.label;

    const durationMs = phaseCardDurationMs(card, events);
    const durationText = formatPhaseDuration(durationMs);
    const duration = document.createElement("span");
    duration.className = "phase-card__duration";
    duration.textContent = durationText; // empty string when no real duration

    header.appendChild(icon);
    header.appendChild(name);
    header.appendChild(statusEl);
    header.appendChild(duration);

    const body = document.createElement("div");
    body.className = "phase-card__body";
    body.id = bodyId;
    body.hidden = !expanded;

    // Evidence built from real event payloads (may be empty for pending phases).
    const evidenceText = card.phases.map((p) => evidence[p]).filter(Boolean).join(" · ");
    if (evidenceText) {
      const ev = document.createElement("p");
      ev.className = "phase-card__evidence";
      ev.textContent = evidenceText;
      body.appendChild(ev);
    }

    // Real events recorded for this card's phase(s).
    const phaseEvents = events.filter((e) => card.phases.includes(e.phase));
    if (phaseEvents.length) {
      const list = document.createElement("ul");
      list.className = "phase-card__events";
      for (const event of phaseEvents) {
        const item = document.createElement("li");
        item.className = "phase-card__event";
        item.textContent = event.type;
        list.appendChild(item);
      }
      body.appendChild(list);
    } else if (!evidenceText) {
      const none = document.createElement("p");
      none.className = "phase-card__empty";
      none.textContent =
        status === "pending"
          ? "No events recorded for this phase yet."
          : "No additional detail recorded for this phase.";
      body.appendChild(none);
    }

    header.addEventListener("click", () => {
      const next = header.getAttribute("aria-expanded") !== "true";
      setPhaseCardExpanded(card.id, header, body, next);
    });

    cardEl.appendChild(header);
    cardEl.appendChild(body);
    container.appendChild(cardEl);
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

// --- Provider connection test panel (Provider_Test_Panel) ---

// Panel state. `selected` is the set of currently-checked provider ids; `inFlight` guards against
// concurrent tests; `abort` aborts the in-flight request on timeout/close; `timer` is the 30s
// client-side timeout handle.
const providerTest = {
  selected: new Set(),
  inFlight: false,
  abort: null,
  timer: null,
};

// Pure enablement rule (Requirement 2.1 / Property 5): the connection-test action is enabled if and
// only if exactly one provider is selected. Kept side-effect free so it is trivially testable.
function connectionTestEnabled(selectedIds) {
  const count = Array.isArray(selectedIds) ? selectedIds.length : selectedIds.size;
  return count === 1;
}

// Reflect the current selection onto the run button's disabled state. While a test is in flight the
// action stays disabled regardless of selection (Requirement 2.6).
function refreshProviderTestAction() {
  const btn = els["run-provider-test"];
  if (!btn) return;
  const enabled = !providerTest.inFlight && connectionTestEnabled(providerTest.selected);
  btn.disabled = !enabled;
}

// Build the selectable provider list once. Uses checkboxes so the selection can be empty, one, or
// many — the action is gated to exactly one by `connectionTestEnabled` (Requirement 2.1).
function renderProviderList() {
  const list = els["provider-list"];
  if (!list || list.dataset.ready === "1") return;
  list.innerHTML = "";
  for (const provider of PROVIDERS) {
    const option = document.createElement("label");
    option.className = "provider-option";

    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = provider.id;
    input.name = "provider-test";
    input.addEventListener("change", () => {
      if (input.checked) providerTest.selected.add(provider.id);
      else providerTest.selected.delete(provider.id);
      refreshProviderTestAction();
    });

    const labelWrap = document.createElement("span");
    labelWrap.className = "provider-option__label";
    const name = document.createElement("span");
    name.className = "provider-option__name";
    name.textContent = provider.label;
    const id = document.createElement("span");
    id.className = "provider-option__id";
    id.textContent = provider.id;
    labelWrap.appendChild(name);
    labelWrap.appendChild(id);

    option.appendChild(input);
    option.appendChild(labelWrap);
    list.appendChild(option);
  }
  list.dataset.ready = "1";
}

// Enable/disable every provider checkbox (locked while a test is in flight, Requirement 2.6).
function setProviderInputsDisabled(disabled) {
  const inputs = els["provider-list"]?.querySelectorAll("input[type=checkbox]") ?? [];
  for (const input of inputs) input.disabled = disabled;
}

// Render a result message. Server responses are already redacted at the boundary (runConnectionTest
// passes every message through redactString); client-built strings carry only static text plus the
// non-secret provider label/model id, so no API key material can appear (Requirements 2.3–2.5).
function showProviderResult(kind, message) {
  const box = els["provider-test-result"];
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
  box.className = `provider-result provider-result--${kind === "ok" ? "ok" : "err"}`;
}

function clearProviderResult() {
  const box = els["provider-test-result"];
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
  box.className = "provider-result";
}

function setProviderLoading(loading) {
  const indicator = els["provider-test-loading"];
  if (indicator) indicator.hidden = !loading;
}

// Compose the human-language success message. The model id (when present) is a non-secret label.
function providerSuccessMessage(providerId, model) {
  const label = PROVIDER_LABELS.get(providerId) || providerId;
  return model
    ? `${label} is ready. Connected successfully (model: ${model}).`
    : `${label} is ready. Connection succeeded.`;
}

// Compose the human-language failure message from the redacted server response.
function providerFailureMessage(providerId, body) {
  const label = PROVIDER_LABELS.get(providerId) || providerId;
  const reason = (body && (body.error || body.code)) || "the provider rejected the request";
  return `${label} connection failed: ${reason}`;
}

function providerTimeoutMessage(providerId) {
  const label = PROVIDER_LABELS.get(providerId) || providerId;
  return `${label} connection test timed out after 30 seconds. No result was received.`;
}

// Run the connection test for the single selected provider against the existing Connection_Test_API
// (`POST /api/setup/test-connection`). Shows a loading indicator and disables the action while in
// flight (2.6); applies a 30s aborting client timeout (2.7); renders a redacted success/failure
// message and retains the selection on failure (2.3–2.5).
async function runProviderTest() {
  if (providerTest.inFlight) return;
  const selectedIds = [...providerTest.selected];
  if (!connectionTestEnabled(selectedIds)) return;
  const providerId = selectedIds[0];

  providerTest.inFlight = true;
  clearProviderResult();
  setProviderLoading(true);
  setProviderInputsDisabled(true);
  refreshProviderTestAction();

  const controller = new AbortController();
  providerTest.abort = controller;
  let timedOut = false;
  providerTest.timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROVIDER_TEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API}/setup/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
      signal: controller.signal,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};

    if (res.ok && body.ok) {
      showProviderResult("ok", providerSuccessMessage(providerId, body.model));
    } else {
      // Failure path: keep the user's selection so they can retry (Requirement 2.4).
      showProviderResult("err", providerFailureMessage(providerId, body));
    }
  } catch (err) {
    if (timedOut || (err && err.name === "AbortError")) {
      showProviderResult("err", providerTimeoutMessage(providerId));
    } else {
      showProviderResult("err", providerFailureMessage(providerId, { error: "could not reach the server" }));
    }
  } finally {
    clearTimeout(providerTest.timer);
    providerTest.timer = null;
    providerTest.abort = null;
    providerTest.inFlight = false;
    setProviderLoading(false);
    setProviderInputsDisabled(false);
    refreshProviderTestAction();
  }
}

function openProviderTest() {
  renderProviderList();
  const modal = els["provider-test-modal"];
  if (!modal) return;
  modal.hidden = false;
  refreshProviderTestAction();
}

function closeProviderTest() {
  // Abort any in-flight test so a background request never resolves against a closed panel.
  if (providerTest.abort) {
    try {
      providerTest.abort.abort();
    } catch {
      /* ignore */
    }
  }
  if (providerTest.timer) {
    clearTimeout(providerTest.timer);
    providerTest.timer = null;
  }
  providerTest.inFlight = false;
  setProviderLoading(false);
  setProviderInputsDisabled(false);
  const modal = els["provider-test-modal"];
  if (modal) modal.hidden = true;
}

function bindProviderTest() {
  els["open-provider-test"]?.addEventListener("click", openProviderTest);
  els["close-provider-test"]?.addEventListener("click", closeProviderTest);
  els["provider-test-backdrop"]?.addEventListener("click", closeProviderTest);
  els["run-provider-test"]?.addEventListener("click", runProviderTest);
}

// --- Provider configuration panel (Provider_Config_UI, Req 10/11/14.5/15) ---
//
// A two-tier BYOK configuration surface rendered as a modal overlay so the chat + trace UI stay
// mounted and accessible at all times (Req 10.7). It talks only to the real Provider_Config_API:
//   GET  /api/providers                 -> { providers: [{...record, secretPresent}], activeRoutes }
//   POST /api/providers                 -> upsert (apiKey sent ONLY when entered; write-once UX)
//   DELETE /api/providers/:id           -> remove record + secret
//   POST /api/providers/active          -> { role, providerId|null } active-route selection
//   POST /api/setup/test-connection     -> { providerId } (resolved from persisted config+secret)
//
// Secrets only ever travel browser -> server; the API exposes a `secretPresent` PRESENCE boolean
// only and never returns a key (Req 11.2). The panel writes no secret to browser storage (Req 11.5)
// and clears the key input after a save so no key lingers in the DOM.

// The preset providers (Basic tier, Req 10.1/10.2). Each preset has a stable record id (its kind),
// the adapter `kind`, a display `label`, and the non-secret fields it requires. Field `name`s use a
// dotted path for nested record fields (e.g. "azure.endpoint", "cloudflare.accountId").
const PROVIDER_CONFIG_PRESETS = [
  {
    id: "together",
    kind: "together",
    label: "Together AI",
    fields: [
      { name: "model", label: "Model id", placeholder: "meta-llama/Llama-3-70b" },
      { name: "baseUrl", label: "Base URL (optional)", placeholder: "https://api.together.xyz/v1", optional: true },
    ],
  },
  {
    id: "cloudflare",
    kind: "cloudflare",
    label: "Cloudflare Workers AI",
    fields: [
      { name: "cloudflare.accountId", label: "Account ID", placeholder: "account id" },
      { name: "model", label: "Model id", placeholder: "@cf/meta/llama-3-8b-instruct" },
    ],
  },
  {
    id: "azure-openai",
    kind: "azure-openai",
    label: "Azure OpenAI",
    fields: [
      { name: "azure.endpoint", label: "Endpoint", placeholder: "https://my-resource.openai.azure.com" },
      { name: "azure.deployment", label: "Deployment", placeholder: "deployment name" },
      { name: "azure.apiVersion", label: "API version", placeholder: "2024-02-01" },
      { name: "model", label: "Model id (optional)", placeholder: "model id", optional: true },
    ],
  },
];

// The two addressable model roles (Active_Route_Map, Req 14.5). `slm` is the small/fast tier.
const PROVIDER_CONFIG_ROLES = [
  { id: "flagship", label: "Flagship" },
  { id: "slm", label: "Small / fast" },
];

// Closed set of per-provider configuration statuses with an accessible label + glyph. Status is
// never conveyed by color alone — the label text and an icon accompany it (Req 9.4 / 10.4).
const PROVIDER_CONFIG_STATUS_META = {
  "not-configured": { label: "Not configured", icon: "○" },
  configured: { label: "Configured", icon: "●" },
  active: { label: "Active", icon: "★" },
};

// Latest snapshot from GET /api/providers. `providers` carries each record + its `secretPresent`
// boolean; `activeRoutes` maps role -> provider id. No secret value is ever held here (Req 11.2).
const providerConfigState = {
  providers: [],
  activeRoutes: {},
};

// Shared connection-test guard for the config panel (one test at a time). `abort`/`timer` let the
// 30s client timeout (Req 15.5) and panel-close cancel an in-flight request.
const providerConfigTest = {
  inFlight: false,
  abort: null,
  timer: null,
};

// Derive a provider's configuration status from real API state (Req 10.4): "active" when it is the
// designated provider for any role, "configured" when a record exists, otherwise "not-configured".
// Pure and side-effect free so the status rule is trivially testable.
function providerConfigStatus(providerId, hasRecord, activeRoutes) {
  const routes = activeRoutes && typeof activeRoutes === "object" ? activeRoutes : {};
  const isActive = Object.values(routes).includes(providerId);
  if (hasRecord && isActive) return "active";
  if (hasRecord) return "configured";
  return "not-configured";
}

// Read a (possibly nested, dotted) field value from a record as a string, or "" when absent.
function providerConfigFieldValue(record, path) {
  if (!record) return "";
  let cursor = record;
  for (const part of String(path).split(".")) {
    if (cursor == null || typeof cursor !== "object") return "";
    cursor = cursor[part];
  }
  return cursor == null ? "" : String(cursor);
}

// Assign a (possibly nested, dotted) field value onto a plain object, creating intermediate objects.
function setNestedField(target, path, value) {
  const parts = String(path).split(".");
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cursor[parts[i]] == null || typeof cursor[parts[i]] !== "object") cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

// Build the POST /api/providers upsert body from a spec, the entered field values, and the entered
// API key. WRITE-ONCE (Req 11.3): `apiKey` is included ONLY when a non-empty key was entered, so
// saving other fields without re-entering a key never clears the stored secret. Pure/testable.
function buildProviderUpsertBody(spec, fieldValues, apiKey) {
  const body = { id: spec.id, kind: spec.kind, label: spec.label };
  for (const field of spec.fields || []) {
    const raw = (fieldValues[field.name] ?? "").trim();
    if (raw) setNestedField(body, field.name, raw);
  }
  const key = (apiKey ?? "").trim();
  if (key) body.apiKey = key;
  return body;
}

// Slugify a label into the suffix of an openai-compatible record id (e.g. "My Proxy" ->
// "openai-compatible:my-proxy"). Falls back to "endpoint" when the label has no usable characters.
function openAICompatibleId(label) {
  const slug = String(label || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `openai-compatible:${slug || "endpoint"}`;
}

function findProviderRecord(providerId) {
  return providerConfigState.providers.find((p) => p.id === providerId) || null;
}

function setProviderConfigLoading(loading) {
  const indicator = els["provider-config-loading"];
  if (indicator) indicator.hidden = !loading;
}

function showProviderConfigError(message) {
  const box = els["provider-config-error"];
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
}

function hideProviderConfigError() {
  const box = els["provider-config-error"];
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
}

// Render a redacted result line into a card/form result element. Server responses are already
// redacted at the boundary; client-built strings carry only static text + the non-secret label and
// model id, so no key material can appear (Req 15.2–15.5).
function showProviderConfigResult(box, kind, message) {
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
  box.className = `provider-config-result provider-config-result--${kind === "ok" ? "ok" : "err"}`;
}

function clearProviderConfigResult(box) {
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
  box.className = "provider-config-result";
}

// Wire a masked key input to its show/hide toggle (Req 11.1). Flipping reveals/masks the value and
// keeps the button label + aria-pressed in sync. No value is persisted anywhere by toggling.
function bindKeyToggle(input, toggle) {
  if (!input || !toggle) return;
  toggle.addEventListener("click", () => {
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    toggle.textContent = reveal ? "Hide" : "Show";
    toggle.setAttribute("aria-pressed", reveal ? "true" : "false");
  });
}

// Run a connection test for one configured provider (Req 15). Validates via the server, applies a
// 30s aborting client timeout (Req 15.5), disables the action while in flight (Req 15.4), and
// renders a redacted success/failure/timeout message (Req 15.2/15.3) into the card's result box.
async function runProviderConfigTest(providerId, label, resultBox, testBtn, loadingEl) {
  if (providerConfigTest.inFlight) return;
  providerConfigTest.inFlight = true;
  clearProviderConfigResult(resultBox);
  if (testBtn) testBtn.disabled = true;
  if (loadingEl) loadingEl.hidden = false;

  const controller = new AbortController();
  providerConfigTest.abort = controller;
  let timedOut = false;
  providerConfigTest.timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, PROVIDER_TEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API}/setup/test-connection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerId }),
      signal: controller.signal,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};
    if (res.ok && body.ok) {
      const model = typeof body.model === "string" && body.model ? ` (model: ${body.model})` : "";
      showProviderConfigResult(resultBox, "ok", `${label} is ready. Connection succeeded${model}.`);
    } else {
      const reason = (body && (body.error || body.code)) || "the provider rejected the request";
      showProviderConfigResult(resultBox, "err", `${label} connection failed: ${reason}`);
    }
  } catch (err) {
    if (timedOut || (err && err.name === "AbortError")) {
      showProviderConfigResult(
        resultBox,
        "err",
        `${label} connection test timed out after 30 seconds. No result was received.`,
      );
    } else {
      showProviderConfigResult(resultBox, "err", `${label} connection failed: could not reach the server.`);
    }
  } finally {
    clearTimeout(providerConfigTest.timer);
    providerConfigTest.timer = null;
    providerConfigTest.abort = null;
    providerConfigTest.inFlight = false;
    if (testBtn) testBtn.disabled = false;
    if (loadingEl) loadingEl.hidden = true;
  }
}

// Persist a record via POST /api/providers, sending the key only when entered (write-once). On
// success the key input is cleared (no secret lingers in the DOM) and the panel reloads.
async function saveProviderConfig(spec, inputs, keyInput, resultBox) {
  const fieldValues = {};
  for (const field of spec.fields || []) {
    const input = inputs[field.name];
    fieldValues[field.name] = input ? input.value : "";
  }
  const body = buildProviderUpsertBody(spec, fieldValues, keyInput ? keyInput.value : "");
  try {
    await api("/providers", { method: "POST", body: JSON.stringify(body) });
    if (keyInput) keyInput.value = ""; // never keep a secret in the DOM after save
    showProviderConfigResult(resultBox, "ok", `${spec.label} saved.`);
    await loadProviderConfig();
  } catch (err) {
    showProviderConfigResult(resultBox, "err", `Could not save ${spec.label}: ${err.message}`);
  }
}

// Remove a record + its stored secret via DELETE /api/providers/:id, then reload.
async function removeProviderConfig(spec, resultBox) {
  try {
    await api(`/providers/${encodeURIComponent(spec.id)}`, { method: "DELETE" });
    await loadProviderConfig();
  } catch (err) {
    showProviderConfigResult(resultBox, "err", `Could not remove ${spec.label}: ${err.message}`);
  }
}

// Toggle the active provider for a role (Req 14.5). Designating a role that this provider already
// serves clears it (providerId: null); otherwise it claims the role. Reloads to reflect the change.
async function toggleActiveRole(spec, role, resultBox) {
  const current = providerConfigState.activeRoutes ? providerConfigState.activeRoutes[role] : undefined;
  const providerId = current === spec.id ? null : spec.id;
  try {
    await api("/providers/active", { method: "POST", body: JSON.stringify({ role, providerId }) });
    await loadProviderConfig();
  } catch (err) {
    showProviderConfigResult(resultBox, "err", `Could not update active provider: ${err.message}`);
  }
}

// Build one provider card (preset or openai-compatible) reflecting its real record + secret presence
// + active-route state. Every interactive control is wired to the real API. Returns the card element.
function createProviderConfigCard(spec) {
  const record = findProviderRecord(spec.id);
  const recordEntry = providerConfigState.providers.find((p) => p.id === spec.id);
  const secretPresent = recordEntry ? recordEntry.secretPresent === true : false;
  const status = providerConfigStatus(spec.id, Boolean(record), providerConfigState.activeRoutes);
  const meta = PROVIDER_CONFIG_STATUS_META[status];

  const card = document.createElement("div");
  card.className = `provider-config-card provider-config-card--${status}`;
  card.dataset.providerId = spec.id;
  card.dataset.status = status;

  // Header: icon + name + status text (never color alone, Req 9.4 / 10.4).
  const head = document.createElement("div");
  head.className = "provider-config-card__head";
  const icon = document.createElement("span");
  icon.className = "provider-config-card__icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = meta.icon;
  const name = document.createElement("span");
  name.className = "provider-config-card__name";
  name.textContent = spec.label;
  const statusEl = document.createElement("span");
  statusEl.className = "provider-config-card__status";
  statusEl.textContent = meta.label;
  head.appendChild(icon);
  head.appendChild(name);
  head.appendChild(statusEl);
  card.appendChild(head);

  // Non-secret fields.
  const fields = document.createElement("div");
  fields.className = "provider-config-card__fields";
  const inputs = {};
  for (const field of spec.fields || []) {
    const row = document.createElement("label");
    row.className = "provider-config-field-row";
    const label = document.createElement("span");
    label.className = "provider-config-label";
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "provider-config-input provider-config-field";
    input.dataset.field = field.name;
    input.value = providerConfigFieldValue(record, field.name);
    if (field.placeholder) input.setAttribute("placeholder", field.placeholder);
    inputs[field.name] = input;
    row.appendChild(label);
    row.appendChild(input);
    fields.appendChild(row);
  }

  // Masked API key input + show/hide toggle (Req 11.1) with write-once hint (Req 11.3/11.5).
  const keyRow = document.createElement("label");
  keyRow.className = "provider-config-field-row";
  const keyLabel = document.createElement("span");
  keyLabel.className = "provider-config-label";
  keyLabel.textContent = "API key";
  const keyWrap = document.createElement("span");
  keyWrap.className = "provider-config-key-wrap";
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.className = "provider-config-input provider-config-key";
  keyInput.setAttribute("autocomplete", "off");
  keyInput.setAttribute("placeholder", secretPresent ? "•••••• stored — leave blank to keep" : "Enter API key");
  const keyToggle = document.createElement("button");
  keyToggle.type = "button";
  keyToggle.className = "btn btn--ghost btn--sm provider-config-key-toggle";
  keyToggle.setAttribute("aria-pressed", "false");
  keyToggle.textContent = "Show";
  bindKeyToggle(keyInput, keyToggle);
  keyWrap.appendChild(keyInput);
  keyWrap.appendChild(keyToggle);
  keyRow.appendChild(keyLabel);
  keyRow.appendChild(keyWrap);
  fields.appendChild(keyRow);

  const keyHint = document.createElement("span");
  keyHint.className = "provider-config-key-hint";
  keyHint.textContent = secretPresent ? "A key is stored for this provider." : "No key stored yet.";
  fields.appendChild(keyHint);
  card.appendChild(fields);

  // Active-route selection (Req 14.5): one toggle per role with clear active indication.
  const roles = document.createElement("div");
  roles.className = "provider-config-card__roles";
  const rolesLabel = document.createElement("span");
  rolesLabel.className = "provider-config-roles__label";
  rolesLabel.textContent = "Active for:";
  roles.appendChild(rolesLabel);
  const resultBox = document.createElement("div");
  resultBox.className = "provider-config-result";
  resultBox.setAttribute("role", "status");
  resultBox.setAttribute("aria-live", "polite");
  resultBox.hidden = true;
  for (const role of PROVIDER_CONFIG_ROLES) {
    const isActive = providerConfigState.activeRoutes && providerConfigState.activeRoutes[role.id] === spec.id;
    const roleBtn = document.createElement("button");
    roleBtn.type = "button";
    roleBtn.className = "provider-config-role" + (isActive ? " is-active" : "");
    roleBtn.dataset.role = role.id;
    roleBtn.setAttribute("aria-pressed", isActive ? "true" : "false");
    roleBtn.textContent = isActive ? `${role.label} ✓` : role.label;
    // A role can only be assigned to a provider that has a saved record.
    roleBtn.disabled = !record;
    roleBtn.addEventListener("click", () => void toggleActiveRole(spec, role.id, resultBox));
    roles.appendChild(roleBtn);
  }
  card.appendChild(roles);

  // Actions: Save / Test connection / Remove.
  const actions = document.createElement("div");
  actions.className = "provider-config-card__actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn--primary btn--sm provider-config-save";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", () => void saveProviderConfig(spec, inputs, keyInput, resultBox));

  const testLoading = document.createElement("span");
  testLoading.className = "provider-config-test-loading";
  testLoading.setAttribute("aria-hidden", "true");
  testLoading.hidden = true;

  const testBtn = document.createElement("button");
  testBtn.type = "button";
  testBtn.className = "btn btn--sm provider-config-test";
  testBtn.textContent = "Test connection";
  // A connection test resolves the provider from its persisted record, so it requires a saved one.
  testBtn.disabled = !record;
  testBtn.addEventListener("click", () =>
    void runProviderConfigTest(spec.id, spec.label, resultBox, testBtn, testLoading),
  );

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "btn btn--sm provider-config-remove";
  removeBtn.textContent = "Remove";
  removeBtn.disabled = !record;
  removeBtn.addEventListener("click", () => void removeProviderConfig(spec, resultBox));

  actions.appendChild(saveBtn);
  actions.appendChild(testBtn);
  actions.appendChild(testLoading);
  actions.appendChild(removeBtn);
  card.appendChild(actions);
  card.appendChild(resultBox);

  return card;
}

// Render the preset cards and the existing openai-compatible cards from the latest API state.
function renderProviderConfig() {
  const presetContainer = els["provider-config-cards"];
  if (presetContainer) {
    presetContainer.innerHTML = "";
    for (const preset of PROVIDER_CONFIG_PRESETS) {
      presetContainer.appendChild(createProviderConfigCard(preset));
    }
  }

  const advContainer = els["provider-config-adv-cards"];
  if (advContainer) {
    advContainer.innerHTML = "";
    const advRecords = providerConfigState.providers.filter((p) => p.kind === "openai-compatible");
    for (const record of advRecords) {
      const spec = {
        id: record.id,
        kind: "openai-compatible",
        label: record.label || record.id,
        fields: [
          { name: "baseUrl", label: "Base URL", placeholder: "https://api.example.com/v1" },
          { name: "model", label: "Model id", placeholder: "model id" },
        ],
      };
      advContainer.appendChild(createProviderConfigCard(spec));
    }
  }
}

// Fetch the current provider configuration (records + active routes + secret presence) and render
// it. Any failure shows a redacted error while chat/trace stay accessible (Req 10.7).
async function loadProviderConfig() {
  setProviderConfigLoading(true);
  hideProviderConfigError();
  try {
    const data = await api("/providers");
    providerConfigState.providers = Array.isArray(data.providers) ? data.providers : [];
    providerConfigState.activeRoutes =
      data.activeRoutes && typeof data.activeRoutes === "object" ? data.activeRoutes : {};
    renderProviderConfig();
  } catch {
    providerConfigState.providers = [];
    providerConfigState.activeRoutes = {};
    renderProviderConfig();
    showProviderConfigError(
      "Provider configuration could not be loaded. Chat and trace remain available.",
    );
  } finally {
    setProviderConfigLoading(false);
  }
}

// Add a new openai-compatible endpoint from the Advanced form. The id is derived from the name; the
// key is sent only when entered (write-once). On success the form is cleared and the panel reloads.
async function addOpenAICompatibleProvider() {
  const label = (els["provider-config-adv-label"]?.value ?? "").trim();
  const baseUrl = (els["provider-config-adv-baseurl"]?.value ?? "").trim();
  const model = (els["provider-config-adv-model"]?.value ?? "").trim();
  const apiKey = (els["provider-config-adv-key"]?.value ?? "").trim();
  const resultBox = els["provider-config-adv-result"];

  if (!label || !baseUrl || !model) {
    showProviderConfigResult(resultBox, "err", "Name, base URL, and model id are all required.");
    return;
  }

  const body = { id: openAICompatibleId(label), kind: "openai-compatible", label, baseUrl, model };
  if (apiKey) body.apiKey = apiKey;

  try {
    await api("/providers", { method: "POST", body: JSON.stringify(body) });
    if (els["provider-config-adv-label"]) els["provider-config-adv-label"].value = "";
    if (els["provider-config-adv-baseurl"]) els["provider-config-adv-baseurl"].value = "";
    if (els["provider-config-adv-model"]) els["provider-config-adv-model"].value = "";
    if (els["provider-config-adv-key"]) els["provider-config-adv-key"].value = "";
    showProviderConfigResult(resultBox, "ok", `${label} added.`);
    await loadProviderConfig();
  } catch (err) {
    showProviderConfigResult(resultBox, "err", `Could not add endpoint: ${err.message}`);
  }
}

function openProviderConfig() {
  const modal = els["provider-config-modal"];
  if (!modal) return;
  modal.hidden = false;
  void loadProviderConfig();
}

function closeProviderConfig() {
  // Abort any in-flight connection test so a background request never resolves against a closed panel.
  if (providerConfigTest.abort) {
    try {
      providerConfigTest.abort.abort();
    } catch {
      /* ignore */
    }
  }
  if (providerConfigTest.timer) {
    clearTimeout(providerConfigTest.timer);
    providerConfigTest.timer = null;
  }
  providerConfigTest.inFlight = false;
  const modal = els["provider-config-modal"];
  if (modal) modal.hidden = true;
}

function bindProviderConfig() {
  els["open-provider-config"]?.addEventListener("click", openProviderConfig);
  els["close-provider-config"]?.addEventListener("click", closeProviderConfig);
  els["provider-config-backdrop"]?.addEventListener("click", closeProviderConfig);
  bindKeyToggle(els["provider-config-adv-key"], els["provider-config-adv-key-toggle"]);
  els["provider-config-adv-form"]?.addEventListener("submit", (event) => {
    event.preventDefault();
    void addOpenAICompatibleProvider();
  });
}

// --- Setup Wizard panel (Setup_Wizard, Requirement 1) ---
//
// A read-only status surface rendered as a modal overlay so the chat + trace UI stay mounted and
// accessible at all times (Requirement 1.7), including while an error/timeout state is shown
// (Requirements 1.8, 1.9). It presents the orchestration mode (1.1) and exactly one readiness pill
// per configuration category (1.2). It mutates no configuration (1.6) and persists nothing to
// localStorage/sessionStorage (1.5) — no browser storage is touched anywhere in this flow.

const setupWizard = {
  inFlight: false,
  abort: null,
  timer: null,
};

// Human-language mode label (Requirement 1.1). Local_Mode unless the server reports "external".
function setupModeLabel(mode) {
  return mode === "external" ? "External mode" : "Local mode";
}

// Map a closed-set readiness status to its pill style. Unknown values fall back to the error style.
function readinessPillClass(status) {
  if (status === "Ready") return "wizard-pill--ready";
  if (status === "Incomplete") return "wizard-pill--incomplete";
  return "wizard-pill--error";
}

function setSetupWizardLoading(loading) {
  const indicator = els["setup-wizard-loading"];
  if (indicator) indicator.hidden = !loading;
}

// Show the error state and hide the status body. Messages are static, key-free strings; the wizard
// never echoes a server payload here, so no secret material can appear (Requirements 1.5, 1.8, 1.9).
function showSetupWizardError(message) {
  if (els["setup-wizard-body"]) els["setup-wizard-body"].hidden = true;
  const error = els["setup-wizard-error"];
  if (!error) return;
  error.hidden = false;
  error.textContent = message;
}

// Render the redacted SetupStatusResponse: the mode plus one pill per category (Requirements 1.1, 1.2).
function renderSetupStatus(status) {
  if (els["setup-wizard-error"]) els["setup-wizard-error"].hidden = true;

  const modeEl = els["setup-wizard-mode"];
  if (modeEl) modeEl.textContent = setupModeLabel(status.mode);

  const container = els["setup-wizard-categories"];
  if (container) {
    container.innerHTML = "";
    const categories = Array.isArray(status.categories) ? status.categories : [];
    for (const entry of categories) {
      const pill = document.createElement("div");
      pill.className = `wizard-pill ${readinessPillClass(entry.status)}`;

      const head = document.createElement("div");
      head.className = "wizard-pill__head";

      const name = document.createElement("span");
      name.className = "wizard-pill__name";
      name.textContent = SETUP_CATEGORY_LABELS[entry.category] || entry.category;

      const badge = document.createElement("span");
      badge.className = "wizard-pill__status";
      badge.textContent = entry.status;

      head.appendChild(name);
      head.appendChild(badge);

      const detail = document.createElement("p");
      detail.className = "wizard-pill__detail";
      detail.textContent = entry.detail || "";

      pill.appendChild(head);
      pill.appendChild(detail);
      container.appendChild(pill);
    }
  }

  if (els["setup-wizard-body"]) els["setup-wizard-body"].hidden = false;
}

// Fetch the redacted setup status from the existing Setup_API. Applies a 10s aborting client-side
// timeout (Requirement 1.9); on any failure or non-OK response shows an error state (Requirement
// 1.8). The chat/trace UI stays mounted and accessible throughout (Requirement 1.7).
async function loadSetupStatus() {
  if (setupWizard.inFlight) return;
  setupWizard.inFlight = true;
  if (els["setup-wizard-body"]) els["setup-wizard-body"].hidden = true;
  if (els["setup-wizard-error"]) els["setup-wizard-error"].hidden = true;
  setSetupWizardLoading(true);

  const controller = new AbortController();
  setupWizard.abort = controller;
  let timedOut = false;
  setupWizard.timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, SETUP_STATUS_TIMEOUT_MS);

  try {
    const res = await fetch(`${API}/setup/status`, {
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};

    if (!res.ok || !body || !Array.isArray(body.categories)) {
      showSetupWizardError("Setup status is unavailable right now. Chat and trace remain available.");
      return;
    }
    renderSetupStatus(body);
  } catch (err) {
    if (timedOut || (err && err.name === "AbortError")) {
      showSetupWizardError("Setup status timed out after 10 seconds. Chat and trace remain available.");
    } else {
      showSetupWizardError("Setup status could not be loaded. Chat and trace remain available.");
    }
  } finally {
    clearTimeout(setupWizard.timer);
    setupWizard.timer = null;
    setupWizard.abort = null;
    setupWizard.inFlight = false;
    setSetupWizardLoading(false);
  }
}

function openSetupWizard() {
  const modal = els["setup-wizard-modal"];
  if (!modal) return;
  modal.hidden = false;
  void loadSetupStatus();
}

function closeSetupWizard() {
  // Abort any in-flight status fetch so a background request never resolves against a closed panel.
  if (setupWizard.abort) {
    try {
      setupWizard.abort.abort();
    } catch {
      /* ignore */
    }
  }
  if (setupWizard.timer) {
    clearTimeout(setupWizard.timer);
    setupWizard.timer = null;
  }
  setupWizard.inFlight = false;
  setSetupWizardLoading(false);
  const modal = els["setup-wizard-modal"];
  if (modal) modal.hidden = true;
}

function bindSetupWizard() {
  els["open-setup-wizard"]?.addEventListener("click", openSetupWizard);
  els["close-setup-wizard"]?.addEventListener("click", closeSetupWizard);
  els["setup-wizard-backdrop"]?.addEventListener("click", closeSetupWizard);
}

// --- Workspace safety panel (Workspace_Safety_Panel, Requirement 3) ---

// Human-readable labels for the approval-required operation categories returned by the Setup_API
// (`/api/setup/workspace`). Unknown categories fall back to their raw id so nothing is dropped.
const APPROVAL_CATEGORY_LABELS = {
  FILE_WRITE: "File writes",
  COMMAND: "Shell commands",
};

// Render a string list into a <ul>, or an italic empty-state line when the list is empty. Used for
// both the allowlisted commands and the approval-required categories.
function renderSafetyList(list, values, emptyText) {
  if (!list) return;
  list.innerHTML = "";
  const items = Array.isArray(values) ? values : [];
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "safety-list__empty";
    empty.textContent = emptyText;
    list.appendChild(empty);
    return;
  }
  for (const value of items) {
    const item = document.createElement("li");
    item.className = "safety-list__item";
    item.textContent = value;
    list.appendChild(item);
  }
}

// Render a WorkspaceSafetyResponse into the panel. This is a read-only view: it shows the workspace
// root, allowlisted commands, destructive-protection status, and approval-required categories, and
// it exposes no command-execution control (Req 3.1–3.4, 3.6). When `available` is not true (the
// root or policy could not be retrieved), the unavailable error state is shown with no workspace
// details and no action controls (Req 3.8). Server responses are already redacted at the boundary.
function renderWorkspaceSafety(safety) {
  setWorkspaceSafetyLoading(false);
  const unavailable = els["workspace-safety-unavailable"];
  const detail = els["workspace-safety-detail"];

  if (!safety || safety.available !== true) {
    if (detail) detail.hidden = true;
    if (unavailable) unavailable.hidden = false;
    return;
  }

  if (unavailable) unavailable.hidden = true;

  if (els["safety-workspace-root"]) {
    els["safety-workspace-root"].textContent = safety.workspaceRoot || "—";
  }

  const protectionEnabled = safety.destructiveProtection === "enabled";
  const badge = els["safety-destructive"];
  if (badge) {
    badge.textContent = protectionEnabled ? "Enabled" : "Disabled";
    badge.className = `safety-badge safety-badge--${protectionEnabled ? "ok" : "warn"}`;
  }

  renderSafetyList(
    els["safety-allowlist"],
    safety.allowlistedCommands,
    "No commands are allowlisted.",
  );
  renderSafetyList(
    els["safety-approval"],
    (Array.isArray(safety.approvalRequiredCategories) ? safety.approvalRequiredCategories : []).map(
      (category) => APPROVAL_CATEGORY_LABELS[category] || category,
    ),
    "No operation categories require approval.",
  );

  if (detail) detail.hidden = false;
}

// Toggle the loading indicator for the workspace safety panel.
function setWorkspaceSafetyLoading(loading) {
  const indicator = els["workspace-safety-loading"];
  if (indicator) indicator.hidden = !loading;
}

// Fetch the read-only workspace safety policy from the Setup_API and render it. Any failure — a
// network error, a thrown response, or an `available:false` payload — is treated as "policy
// unavailable" and shows the unavailable state with no action controls (Req 3.8).
async function loadWorkspaceSafety() {
  const unavailable = els["workspace-safety-unavailable"];
  const detail = els["workspace-safety-detail"];
  if (unavailable) unavailable.hidden = true;
  if (detail) detail.hidden = true;
  setWorkspaceSafetyLoading(true);

  try {
    const safety = await api("/setup/workspace");
    renderWorkspaceSafety(safety);
  } catch {
    renderWorkspaceSafety(null);
  }
}

function openWorkspaceSafety() {
  const modal = els["workspace-safety-modal"];
  if (!modal) return;
  modal.hidden = false;
  void loadWorkspaceSafety();
}

function closeWorkspaceSafety() {
  const modal = els["workspace-safety-modal"];
  if (modal) modal.hidden = true;
}

function bindWorkspaceSafety() {
  els["open-workspace-safety"]?.addEventListener("click", openWorkspaceSafety);
  els["close-workspace-safety"]?.addEventListener("click", closeWorkspaceSafety);
  els["workspace-safety-backdrop"]?.addEventListener("click", closeWorkspaceSafety);
}

// --- Run approval panel (Approval_Flow, Requirement 9) ---
//
// A decision surface rendered as a modal overlay so the chat + trace UI stay mounted at all times.
// It consumes the existing SSE run stream (via `applyLiveEvent` -> `maybePresentApprovalFromEvent`):
// when a run pauses for an approval decision the server emits a `DECISION_REQUESTED` run-event whose
// payload carries the redacted approval request. The panel presents that pending operation and
// displays its redacted diff, command, and target path BEFORE any approve/deny action can be
// submitted (Req 9.2). Every displayed value is already redacted by the server boundary
// (`createDecisionRequest`/`presentApprovalRequest`), so no secret can appear here (Req 9.6).

const approval = {
  runId: null, // the run currently awaiting a decision (null once decided/cleared)
  operationId: null, // the operation currently presented for a decision
  inFlight: false, // guards against double-submitting a decision
};

// Pure: extract a normalized approval request from a persisted `decisionRequest`, or `null` when the
// request is not an approval-kind request (so a non-approval decision request is never mistaken for
// one). Kept side-effect free so the detection rule is trivially testable. The fields are read
// defensively because the payload crossed the redaction/persistence boundary.
function extractApprovalRequest(decisionRequest) {
  if (!decisionRequest || typeof decisionRequest !== "object") return null;
  if (decisionRequest.kind !== "approval") return null;
  const operationId = typeof decisionRequest.operationId === "string" ? decisionRequest.operationId : "";
  if (!operationId) return null;
  const view = decisionRequest.view && typeof decisionRequest.view === "object" ? decisionRequest.view : {};
  return {
    operationId,
    riskyCommand: decisionRequest.riskyCommand === true,
    view: {
      runId: typeof view.runId === "string" ? view.runId : "",
      operationId: typeof view.operationId === "string" ? view.operationId : operationId,
      diff: typeof view.diff === "string" ? view.diff : "",
      command: typeof view.command === "string" ? view.command : undefined,
      targetPath: typeof view.targetPath === "string" ? view.targetPath : "",
    },
  };
}

// Enable/disable the approve + deny actions. They are gated so a decision can only be submitted once
// a pending operation's redacted details have been rendered (Req 9.2) and no decision is in flight.
function setApprovalActionsEnabled(enabled) {
  const approveBtn = els["approval-approve"];
  const denyBtn = els["approval-deny"];
  if (approveBtn) approveBtn.disabled = !enabled;
  if (denyBtn) denyBtn.disabled = !enabled;
}

function setApprovalLoading(loading) {
  const indicator = els["approval-loading"];
  if (indicator) indicator.hidden = !loading;
}

function clearApprovalResult() {
  const box = els["approval-result"];
  if (!box) return;
  box.hidden = true;
  box.textContent = "";
  box.className = "approval-result";
}

// Render a decision result/indication. `kind` is "ok" (decision recorded) or "err" (could not be
// processed — the run stays pending and the user can retry, Req 9.7).
function showApprovalResult(kind, message) {
  const box = els["approval-result"];
  if (!box) return;
  box.hidden = false;
  box.textContent = message;
  box.className = `approval-result approval-result--${kind === "ok" ? "ok" : "err"}`;
}

// Reflect pending approvals on the sidebar "System" cluster badge (Req 6.6). Accepts either a
// boolean (legacy callers) or a numeric count. The badge shows the count when any operation is
// awaiting a decision and is hidden (never color-only) otherwise; an aria-label keeps it readable
// to assistive tech.
function setApprovalBadge(countOrVisible) {
  const badge = els["approval-badge"];
  if (!badge) return;
  const count =
    countOrVisible === true ? 1 : countOrVisible === false ? 0 : Number(countOrVisible) || 0;
  badge.hidden = count <= 0;
  if (count > 0) {
    badge.textContent = String(count);
    badge.setAttribute("aria-label", `${count} pending approval${count === 1 ? "" : "s"}`);
  } else {
    badge.textContent = "";
  }
}

// Render the redacted pending operation into the panel (Req 9.2). The diff/command/target path are
// shown verbatim — already redacted at the server boundary — and the approve/deny actions are only
// enabled after these fields are populated.
function renderApprovalRequest(runId, request) {
  const view = request.view;

  if (els["approval-run-id"]) els["approval-run-id"].textContent = runId || view.runId || "—";
  if (els["approval-operation-id"]) els["approval-operation-id"].textContent = request.operationId || "—";
  if (els["approval-target-path"]) els["approval-target-path"].textContent = view.targetPath || "—";

  // Command block: shown only when the operation carries a command. The risky-command note is shown
  // for risky shell commands, which require explicit approval before they can run (Req 9.4 context).
  const commandBlock = els["approval-command-block"];
  if (commandBlock) {
    if (view.command !== undefined && view.command !== "") {
      commandBlock.hidden = false;
      if (els["approval-command"]) els["approval-command"].textContent = view.command;
    } else {
      commandBlock.hidden = true;
      if (els["approval-command"]) els["approval-command"].textContent = "";
    }
  }
  const riskyNote = els["approval-risky"];
  if (riskyNote) riskyNote.hidden = !request.riskyCommand;

  if (els["approval-diff"]) els["approval-diff"].textContent = view.diff || "(no diff provided)";

  clearApprovalResult();
  if (els["approval-empty"]) els["approval-empty"].hidden = true;
  if (els["approval-detail"]) els["approval-detail"].hidden = false;
  if (els["approval-foot"]) els["approval-foot"].hidden = false;
}

// Present a pending operation for a decision: record which run/operation is awaiting a decision,
// render its redacted details, enable the actions, surface the sidebar badge, and open the panel
// (Req 9.1). Called from the SSE event handler when a DECISION_REQUESTED approval arrives.
function presentApproval(runId, request) {
  approval.runId = runId || request.view.runId || null;
  approval.operationId = request.operationId;
  approval.inFlight = false;

  renderApprovalRequest(approval.runId, request);
  setApprovalActionsEnabled(true);
  setApprovalLoading(false);
  setApprovalBadge(true);

  const modal = els["approval-modal"];
  if (modal) modal.hidden = false;
}

// Inspect a live run event; if it is an approval DECISION_REQUESTED, present the pending operation.
// Safe to call for every event — non-approval events are ignored.
function maybePresentApprovalFromEvent(event) {
  if (!event || event.type !== "DECISION_REQUESTED") return;
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const request = extractApprovalRequest(payload.decisionRequest);
  if (!request) return;
  presentApproval(event.runId || liveRun.runId, request);
}

// Submit an approve/deny decision to the existing decision endpoint (`POST /api/runs/:id/decision`).
// The action is disabled while in flight. On success the decision is recorded server-side (the run
// continues to execute or to a final answer that excludes the operation); on a processing failure
// the run stays pending and the user can retry (Req 9.7).
async function submitApprovalDecision(decision) {
  if (approval.inFlight || !approval.runId || !approval.operationId) return;
  const decidedByRaw = (els["approval-decided-by"]?.value ?? "").trim();
  const decidedBy = decidedByRaw || "browser-user";

  approval.inFlight = true;
  setApprovalActionsEnabled(false);
  setApprovalLoading(true);
  clearApprovalResult();

  const runId = approval.runId;
  const operationId = approval.operationId;

  try {
    const res = await fetch(`${API}/runs/${runId}/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId, decision, decidedBy }),
    });
    const text = await res.text();
    const body = text ? JSON.parse(text) : {};

    if (res.ok && body.decisionProcessed) {
      // Decided: clear the pending operation and leave the actions disabled so it cannot be
      // submitted twice. The run continues per the recorded decision.
      approval.runId = null;
      approval.operationId = null;
      setApprovalBadge(false);
      showApprovalResult(
        "ok",
        decision === "approve"
          ? "Operation approved. The run will continue and execute it."
          : "Operation denied. The run will continue to a final answer that excludes it.",
      );
    } else {
      // Req 9.7: the decision could not be processed; keep the operation pending and allow a retry.
      showApprovalResult(
        "err",
        body.error || "The decision could not be processed. The run is still awaiting a decision.",
      );
      setApprovalActionsEnabled(true);
    }
  } catch {
    showApprovalResult("err", "The decision could not be sent. The run is still awaiting a decision.");
    setApprovalActionsEnabled(true);
  } finally {
    approval.inFlight = false;
    setApprovalLoading(false);
  }
}

// Open the panel manually (e.g. from the sidebar). When nothing is pending, the empty state shows
// and no decision controls are available.
function openApprovalPanel() {
  const modal = els["approval-modal"];
  if (!modal) return;
  if (!approval.operationId) {
    if (els["approval-empty"]) els["approval-empty"].hidden = false;
    if (els["approval-detail"]) els["approval-detail"].hidden = true;
    if (els["approval-foot"]) els["approval-foot"].hidden = true;
  }
  modal.hidden = false;
}

function closeApprovalPanel() {
  const modal = els["approval-modal"];
  if (modal) modal.hidden = true;
}

function bindApproval() {
  els["open-approval"]?.addEventListener("click", openApprovalPanel);
  els["close-approval"]?.addEventListener("click", closeApprovalPanel);
  els["approval-backdrop"]?.addEventListener("click", closeApprovalPanel);
  els["approval-approve"]?.addEventListener("click", () => void submitApprovalDecision("approve"));
  els["approval-deny"]?.addEventListener("click", () => void submitApprovalDecision("deny"));
  // No operation is pending on load: actions stay disabled until a pending operation is presented
  // and its redacted details are rendered (Req 9.2).
  setApprovalActionsEnabled(false);
  setApprovalBadge(false);
}

// --- Appearance settings panel (Appearance_Settings, Req 1.2/1.4, 3.3–3.10) ---
//
// A customization surface rendered as a modal overlay so the chat + trace UI stay mounted at all
// times (parity with the other panels). Every control is wired to window.RectorTheme so changes
// apply at runtime and persist to localStorage["rector.appearance"]; no secret is ever read or
// written here (Req 3.3). On open, the panel reflects the persisted appearance via
// RectorTheme.getAppearance() so the controls never drift from the applied state.

// The five selectable themes (Req 1.2). Ids mirror RectorTheme.THEMES; the note is a static,
// non-secret display hint describing each theme's character (Req 1.4 — themes differ by more than
// color).
const APPEARANCE_THEMES = [
  { id: "halo", label: "Halo", note: "Dark · indigo" },
  { id: "aether", label: "Aether", note: "Near-black · prism" },
  { id: "cairn", label: "Cairn", note: "Near-black · mint" },
  { id: "penumbra", label: "Penumbra", note: "Monochrome" },
  { id: "vellum", label: "Vellum Tessera", note: "Light · cream" },
];

// Curated accent palette (Req 3.5). The empty value reverts to the active theme's own accent token
// (Req 3.8). The rest are theme-safe accents the user can apply; a chosen accent that fails contrast
// against the active theme's surfaces is warned about but never blocked (Req 3.9).
const APPEARANCE_ACCENTS = [
  { value: "", label: "Theme default", swatch: null },
  { value: "#5b6bff", label: "Indigo", swatch: "#5b6bff" },
  { value: "#2dd4bf", label: "Teal", swatch: "#2dd4bf" },
  { value: "#9fe7c7", label: "Mint", swatch: "#9fe7c7" },
  { value: "#f59e0b", label: "Amber", swatch: "#f59e0b" },
  { value: "#f472b6", label: "Pink", swatch: "#f472b6" },
  { value: "#a78bfa", label: "Violet", swatch: "#a78bfa" },
  { value: "#38bdf8", label: "Sky", swatch: "#38bdf8" },
];

// WCAG contrast threshold for body text (Req 9.1) reused for the accent-vs-surface warning (Req 3.9).
const APPEARANCE_CONTRAST_MIN = 4.5;

// The runtime Theme_System singleton (theme.js). Resolved lazily so app.js never throws if the
// script load order changes; all calls are guarded.
function rectorTheme() {
  return typeof window !== "undefined" ? window.RectorTheme : undefined;
}

// Parse a CSS color string (#rgb, #rrggbb, or rgb()/rgba()) into {r,g,b}, or null if unparseable.
function parseColor(input) {
  const str = String(input || "").trim();
  if (!str) return null;
  if (str[0] === "#") {
    let hex = str.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("");
    }
    if (hex.length !== 6 || /[^0-9a-f]/i.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    };
  }
  const match = str.match(/rgba?\(([^)]+)\)/i);
  if (match) {
    const parts = match[1].split(",").map((s) => parseFloat(s));
    if (parts.length >= 3 && parts.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { r: parts[0], g: parts[1], b: parts[2] };
    }
  }
  return null;
}

// Relative luminance per WCAG 2.x.
function relativeLuminance(rgb) {
  const channel = (value) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

// WCAG contrast ratio between two colors (1:1 .. 21:1).
function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

// Read a resolved theme surface token from the document root (e.g. "--surface", "--bg").
function readThemeToken(name) {
  if (typeof window === "undefined" || !window.getComputedStyle) return "";
  try {
    return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  } catch {
    return "";
  }
}

// Evaluate a chosen accent against the active theme's surfaces. Returns the worst contrast ratio
// found (vs --bg and --surface), or null when it cannot be computed. Used to warn (not block) on a
// low-contrast accent (Req 3.9).
function accentWorstContrast(accentValue) {
  const accent = parseColor(accentValue);
  if (!accent) return null;
  const surfaces = ["--bg", "--surface", "--elevated"]
    .map((token) => parseColor(readThemeToken(token)))
    .filter(Boolean);
  if (!surfaces.length) return null;
  let worst = Infinity;
  for (const surface of surfaces) worst = Math.min(worst, contrastRatio(accent, surface));
  return Number.isFinite(worst) ? worst : null;
}

// Show/hide the accent contrast warning for the currently chosen accent value. Empty accent (theme
// default) never warns. The warning is advisory only — the choice still applies and persists.
function refreshAccentWarning(accentValue) {
  const box = els["appearance-accent-warning"];
  if (!box) return;
  if (!accentValue) {
    box.hidden = true;
    box.textContent = "";
    return;
  }
  const ratio = accentWorstContrast(accentValue);
  if (ratio !== null && ratio < APPEARANCE_CONTRAST_MIN) {
    box.hidden = false;
    box.textContent = `This accent has low contrast (${ratio.toFixed(
      1,
    )}:1) against this theme's surfaces. It's still applied, but text or controls using it may be hard to read.`;
  } else {
    box.hidden = true;
    box.textContent = "";
  }
}

// Render the theme picker as a radiogroup of cards reflecting the active theme.
function renderAppearanceThemes(activeTheme) {
  const list = els["appearance-theme-list"];
  if (!list) return;
  list.innerHTML = "";
  for (const theme of APPEARANCE_THEMES) {
    const option = document.createElement("label");
    option.className = "appearance-theme" + (theme.id === activeTheme ? " is-active" : "");

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "appearance-theme";
    input.value = theme.id;
    input.checked = theme.id === activeTheme;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const api = rectorTheme();
      if (api) api.applyTheme(theme.id);
      // Accent overrides are stored per theme, so re-render the accent row and warning for the
      // newly active theme.
      renderAppearancePanel();
    });

    const swatch = document.createElement("span");
    swatch.className = `appearance-theme__swatch appearance-theme__swatch--${theme.id}`;
    swatch.setAttribute("aria-hidden", "true");

    const text = document.createElement("span");
    text.className = "appearance-theme__text";
    const name = document.createElement("span");
    name.className = "appearance-theme__name";
    name.textContent = theme.label;
    const note = document.createElement("span");
    note.className = "appearance-theme__note";
    note.textContent = theme.note;
    text.appendChild(name);
    text.appendChild(note);

    option.appendChild(input);
    option.appendChild(swatch);
    option.appendChild(text);
    list.appendChild(option);
  }
}

// Render the curated accent palette as a radiogroup reflecting the active theme's persisted accent
// override (or "Theme default" when none).
function renderAppearanceAccents(activeAccent) {
  const list = els["appearance-accent-list"];
  if (!list) return;
  list.innerHTML = "";
  const current = activeAccent || "";
  for (const accent of APPEARANCE_ACCENTS) {
    const option = document.createElement("label");
    option.className = "appearance-accent" + (accent.value === current ? " is-active" : "");
    option.title = accent.label;

    const input = document.createElement("input");
    input.type = "radio";
    input.name = "appearance-accent";
    input.value = accent.value;
    input.checked = accent.value === current;
    input.addEventListener("change", () => {
      if (!input.checked) return;
      const api = rectorTheme();
      if (api) api.setAccent(accent.value);
      renderAppearanceAccents(accent.value);
      refreshAccentWarning(accent.value);
    });

    const swatch = document.createElement("span");
    swatch.className = "appearance-accent__swatch";
    swatch.setAttribute("aria-hidden", "true");
    if (accent.swatch) {
      swatch.style.background = accent.swatch;
    } else {
      swatch.classList.add("appearance-accent__swatch--default");
    }

    const label = document.createElement("span");
    label.className = "appearance-accent__label";
    label.textContent = accent.label;

    option.appendChild(input);
    option.appendChild(swatch);
    option.appendChild(label);
    list.appendChild(option);
  }
}

// Reflect a value onto a named radiogroup, checking the matching input (or none when value is null).
function setRadioGroupValue(containerId, value) {
  const container = els[containerId];
  if (!container) return;
  const inputs = container.querySelectorAll("input[type=radio]");
  for (const input of inputs) input.checked = input.value === value;
}

// Reflect the full persisted appearance onto the panel controls (Req: panel reflects current state
// on open). Reads only from RectorTheme.getAppearance(); never mutates state.
function renderAppearancePanel() {
  const api = rectorTheme();
  const appearance = api
    ? api.getAppearance()
    : { theme: "halo", accents: {}, density: null, fontScale: null, reducedMotion: false };

  const activeTheme = appearance.theme;
  const activeAccent = (appearance.accents && appearance.accents[activeTheme]) || "";

  renderAppearanceThemes(activeTheme);
  renderAppearanceAccents(activeAccent);
  refreshAccentWarning(activeAccent);

  // Density / font-scale default to the runtime defaults when nothing is persisted yet.
  setRadioGroupValue("appearance-density", appearance.density || "comfortable");
  setRadioGroupValue("appearance-fontscale", appearance.fontScale || "default");

  const motion = els["appearance-reduced-motion"];
  if (motion) motion.checked = appearance.reducedMotion === true;
}

function openAppearance() {
  const modal = els["appearance-modal"];
  if (!modal) return;
  renderAppearancePanel();
  modal.hidden = false;
}

function closeAppearance() {
  const modal = els["appearance-modal"];
  if (modal) modal.hidden = true;
}

function bindAppearance() {
  els["open-appearance"]?.addEventListener("click", openAppearance);
  els["close-appearance"]?.addEventListener("click", closeAppearance);
  els["appearance-backdrop"]?.addEventListener("click", closeAppearance);

  els["appearance-density"]?.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || target.name !== "appearance-density" || !target.checked) return;
    const api = rectorTheme();
    if (api) api.setDensity(target.value);
  });

  els["appearance-fontscale"]?.addEventListener("change", (event) => {
    const target = event.target;
    if (!target || target.name !== "appearance-fontscale" || !target.checked) return;
    const api = rectorTheme();
    if (api) api.setFontScale(target.value);
  });

  els["appearance-reduced-motion"]?.addEventListener("change", (event) => {
    const api = rectorTheme();
    if (api) api.setReducedMotion(event.target.checked);
  });

  els["appearance-reset"]?.addEventListener("click", () => {
    const api = rectorTheme();
    if (api) api.resetCustomizations();
    // Reflect the reverted-to-theme-default state back onto the controls.
    renderAppearancePanel();
  });
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
  bindProviderTest();
  bindProviderConfig();
  bindSetupWizard();
  bindWorkspaceSafety();
  bindApproval();
  bindAppearance();

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
