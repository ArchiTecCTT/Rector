const API = "/api";

let currentTaskId = null;

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 204) return null;
  return res.json().catch(() => ({}));
}

async function loadTasks() {
  const tasks = await api("/tasks");
  const cols = document.querySelectorAll(".kanban-col .cards");
  cols.forEach((col) => col.innerHTML = "");

  for (const task of tasks) {
    const col = document.querySelector(`.kanban-col[data-state="${task.state}"] .cards`);
    if (!col) continue;
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.id = task.id;
    card.innerHTML = `<h4>${escapeHtml(task.description.slice(0, 80))}</h4>
      <div class="meta">${task.id.slice(0, 12)}… · ${task.subtasks.filter(s=>s.status==="completed").length}/${task.subtasks.length}</div>`;
    card.addEventListener("click", () => selectTask(task.id));
    col.appendChild(card);
  }
}

async function loadTelemetry() {
  const metrics = await api("/telemetry");
  const container = document.getElementById("telemetry-metrics");
  if (!container) return;
  container.innerHTML = [
    ["Model invocations", metrics.modelInvocations ?? 0],
    ["Cache hits", metrics.cacheHits ?? 0],
    ["Validation runs", metrics.validationRuns ?? 0],
    ["Healing runs", metrics.healingRuns ?? 0],
    ["Synthesis runs", metrics.synthesisRuns ?? 0],
    ["Estimated cost", `$${(metrics.totalCost ?? 0).toFixed(4)}`],
  ]
    .map(([k, v]) => `<div class="metric"><span>${k}</span><span class="metric-value">${v}</span></div>`)
    .join("");
}

async function selectTask(id) {
  const task = await api(`/tasks/${id}`);
  if (!task) return;
  currentTaskId = id;

  const panel = document.getElementById("detail-panel");
  panel.classList.remove("hidden");

  const content = document.getElementById("detail-content");
  content.innerHTML = `
    <h3>${escapeHtml(task.description)}</h3>
    <p><strong>State:</strong> ${task.state}${task.previousState ? ` <em>← ${task.previousState}</em>` : ""}</p>

    <h4>Subtasks (${task.subtasks.length})</h4>
    ${task.subtasks
      .map(
        (s) =>
          `<div class="subtask-item"><span>${escapeHtml(s.title)}</span><span class="status-badge ${s.status}">${s.status}</span></div>`
      )
      .join("")}

    <h4>History</h4>
    <div class="events">${task.events
      .slice(-8)
      .reverse()
      .map(
        (e) =>
          `<div class="event-item">⏱ ${new Date(e.timestamp).toLocaleTimeString()} · ${e.topic}</div>`
      )
      .join("")}</div>

    ${task.output ? `<h4>Output</h4><pre>${escapeHtml(task.output)}</pre>` : ""}
  `;
}

function bindControls() {
  const controls = document.getElementById("detail-panel");
  controls.addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    if (!btn || !currentTaskId) return;
    const routes = {
      "retry-btn": `/tasks/${currentTaskId}/retry`,
      "pause-btn": `/tasks/${currentTaskId}/pause`,
      "approve-btn": `/tasks/${currentTaskId}/approve`,
      "abort-btn": `/tasks/${currentTaskId}/abort`,
      "advance-btn": `/tasks/${currentTaskId}/advance`,
    };
    const path = routes[btn.id];
    if (!path) return;
    await api(path, { method: "POST" });
    await Promise.all([loadTasks(), selectTask(currentTaskId), loadTelemetry()]);
  });
}

function bindCreateForm() {
  const form = document.getElementById("create-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const desc = document.getElementById("task-desc").value.trim();
    if (!desc) return;
    await api("/tasks", { method: "POST", body: JSON.stringify({ description: desc }) });
    document.getElementById("task-desc").value = "";
    await loadTasks();
  });
}

function bindSetup() {
  const btn = document.getElementById("setup-btn");
  const modal = document.getElementById("setup-modal");
  const list = document.getElementById("setup-list");

  btn.addEventListener("click", async () => {
    const items = await api("/setup");
    list.innerHTML = items
      .map(
        (it) =>
          `<div class="setup-item"><span><span class="key">${escapeHtml(it.key)}</span>${it.required ? '<span class="required">required</span>' : ""}<br/><small class="value">${escapeHtml(it.displayValue || it.currentValue || '—')}</small></span><small>${escapeHtml(it.description.slice(0, 60))}</small></div>`
      )
      .join("");
    modal.showModal();
  });
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function init() {
  bindCreateForm();
  bindControls();
  bindSetup();
  await loadTasks();
  await loadTelemetry();
  setInterval(() => Promise.all([loadTasks(), loadTelemetry()]), 4000);
}

init().catch(console.error);
