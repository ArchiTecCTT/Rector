// ============================================================
// Rector Stealth Portal Client Application Logic
// Handles client-side state machine simulation & ROI calculators.
// ============================================================

// --- Configuration Setup ---
const API = "/api";
let activeDialog = null;

// --- State Variables for Simulator ---
let currentTask = null;
let currentStepIndex = -1;
let simInterval = null;
let simMetrics = {
  modelInvocations: 0,
  cacheHits: 0,
  totalCost: 0,
  validationRuns: 0,
  healingRuns: 0,
  synthesisRuns: 0
};

// --- Scenarios specifications ---
const SCENARIOS = {
  happy: {
    id: "REC-9082-HAPPY",
    description: "Build high-performance REST API endpoints with Vitest testing suite for task management database",
    states: [
      { state: "1_INTAKE", statusText: "DISTILLING VECTOR CONTEXT" },
      { state: "2_ARCHITECTURAL_PLAN", statusText: "FLAGSHIP PLAN GENERATION" },
      { state: "3_SLM_EXECUTION_FANOUT", statusText: "SLM WORKER EXECUTION" },
      { state: "4_SANDBOX_VALIDATION", statusText: "SANDBOX TEST RUN" },
      { state: "6_FINAL_SYNTHESIS", statusText: "FINAL ARCHITECTURE SYNTHESIS" },
      { state: "7_HUMAN_HANDOFF", statusText: "COMPLETED & HANDED OFF" }
    ],
    subtasks: [
      { title: "AST code representation distillation", status: "completed", type: "intake" },
      { title: "Red-team cognitive strategy blueprinting", status: "completed", type: "plan" },
      { title: "Synthesize route controllers in server.ts", status: "completed", type: "slm" },
      { title: "Generate JSON repository database adapters", status: "completed", type: "slm" },
      { title: "Write Vitest specs in server.test.ts", status: "completed", type: "slm" },
      { title: "Execute 'vitest run' inside Depot container", status: "completed", type: "sandbox" },
      { title: "Consolidate PR branch & update Linear ticket", status: "completed", type: "flagship" }
    ],
    logs: [
      { state: "1_INTAKE", text: "[INTAKE] Task ingested from webhook. Querying Chroma vector store for database contexts...", type: "system" },
      { state: "1_INTAKE", text: "[INTAKE] Distilled 18 code chunks into 8.2KB dense markdown blueprint context. Chroma index lookup: 14ms", type: "success" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] Initializing Flagship Model (Claude 3.5 Sonnet) to construct implementation spec...", type: "system" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] System specifications generated: 3 sub-agent code-writing files allocated. KV-cache prefix written.", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] Launching concurrent Small Language Models (Qwen 2.5 Coder 7B) on Together AI...", type: "system" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-1] Generated server.ts task route handler. Prefix Cache HIT: 91%", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-2] Synthesized database adapter. Time-to-first-token: 180ms", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-3] Wrote Vitest test specs. Together AI Compute Cost: $0.0004", type: "success" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Spinning up isolated Depot container environment using Node 20 runtime...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Injecting code volumes and running Vitest integration test suite...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Vitest: 14/14 test cases successfully executed. Coverage: 100%. Sandbox exited with status: 0", type: "success" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Initiating Flagship Model review of sandboxed files and tests outputs...", type: "system" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Code pattern clean. AST integrity check verified. Constructing final PR package...", type: "success" },
      { state: "7_HUMAN_HANDOFF", text: "[HANDOFF] PR #104 published. Linear issue 'RECT-82' resolved. State Machine finished deterministically.", type: "success" }
    ]
  },
  healing: {
    id: "REC-3841-HEAL",
    description: "Refactor multi-agent router retry logic and resolve AST node leak failures",
    states: [
      { state: "1_INTAKE", statusText: "DISTILLING VECTOR CONTEXT" },
      { state: "2_ARCHITECTURAL_PLAN", statusText: "FLAGSHIP PLAN GENERATION" },
      { state: "3_SLM_EXECUTION_FANOUT", statusText: "SLM WORKER EXECUTION" },
      { state: "4_SANDBOX_VALIDATION", statusText: "SANDBOX TEST RUN (FAILING)" },
      { state: "5_HEALING_LOOP", statusText: "AST TRACE SELF-HEALING" },
      { state: "4_SANDBOX_VALIDATION", statusText: "SANDBOX TEST RUN (PASSED)" },
      { state: "6_FINAL_SYNTHESIS", statusText: "FINAL ARCHITECTURE SYNTHESIS" },
      { state: "7_HUMAN_HANDOFF", statusText: "COMPLETED & HANDED OFF" }
    ],
    subtasks: [
      { title: "Retrieve router context and active configurations", status: "completed", type: "intake" },
      { title: "Generate healing tasks specification array", status: "completed", type: "plan" },
      { title: "Refactor thalamus/router.ts retry transition states", status: "completed", type: "slm" },
      { title: "Generate Vitest suite for retry mechanics", status: "completed", type: "slm" },
      { title: "Verify specs inside Depot container (fails first)", status: "failed", type: "sandbox" },
      { title: "Parse AST stack traces and re-route error", status: "completed", type: "healing" },
      { title: "Rerun healed Vitest suite in Sandbox", status: "completed", type: "sandbox" },
      { title: "Verify final synthesis & Linear webhook handshake", status: "completed", type: "flagship" }
    ],
    logs: [
      { state: "1_INTAKE", text: "[INTAKE] Ingested retry loop failure issue. Chromadb sync triggered for thalamus router...", type: "system" },
      { state: "1_INTAKE", text: "[INTAKE] Chunked 34 records. Derived 12.4KB dense context markdown vector. Completed: 11ms", type: "success" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] Requesting spec from Flagship (Claude 3.5 Sonnet)...", type: "system" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] Subtasks specified: 2 SLMs allocated concurrently for editing and testing. Prefix written.", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] Together AI workers (Qwen 2.5 Coder 7B) active concurrently...", type: "system" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-1] Refactored thalamus/router.ts file. Prefix Cache HIT: 89%", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-2] Wrote Vitest specs for retry states. Compute Cost: $0.0003", type: "success" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Launching Docker Node runtime sandbox in Depot...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Running test commands: 'vitest run'... Execution active.", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[ERROR] Vitest ASSERTION FAILED: router.ts Line 42. Target retry state mismatched. Sandbox exited with status: 1", type: "error" },
      { state: "5_HEALING_LOOP", text: "[HEALING] Caught Sandbox exit code 1. Dispatching to AST Trace Healing Engine...", type: "system" },
      { state: "5_HEALING_LOOP", text: "[HEALING] Locating assertion at line 42. Matching Sentry trace telemetry. Rerouting to Qwen Coder with error context...", type: "system" },
      { state: "5_HEALING_LOOP", text: "[HEALING] [Worker-Correction] Successfully patched target retry state mismatch inside router.ts. Cost: $0.0001", type: "success" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Spinning up new clean sandbox container. Re-injecting healed router.ts module...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Vitest: 8/8 test cases executed. Passed. Coverage: 100%. Sandbox status: 0", type: "success" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Frontier Flagship reviewing task correctness, changes diff, and sandbox history...", type: "system" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Synthesis approved. Ready to deploy code utilities.", type: "success" },
      { state: "7_HUMAN_HANDOFF", text: "[HANDOFF] PR #105 compiled. Linear notification updated. State Machine finished deterministically.", type: "success" }
    ]
  },
  migration: {
    id: "REC-4091-MIGR",
    description: "Automate Next.js Page Router codebase migration to the v15 App Router architecture",
    states: [
      { state: "1_INTAKE", statusText: "DISTILLING VECTOR CONTEXT" },
      { state: "2_ARCHITECTURAL_PLAN", statusText: "FLAGSHIP PLAN GENERATION" },
      { state: "3_SLM_EXECUTION_FANOUT", statusText: "SLM WORKER EXECUTION" },
      { state: "4_SANDBOX_VALIDATION", statusText: "SANDBOX TEST RUN" },
      { state: "6_FINAL_SYNTHESIS", statusText: "FINAL ARCHITECTURE SYNTHESIS" },
      { state: "7_HUMAN_HANDOFF", statusText: "COMPLETED & HANDED OFF" }
    ],
    subtasks: [
      { title: "Analyze pages directory structures and page dependency trees", status: "completed", type: "intake" },
      { title: "Formulate Page Router to App Router mapping plans", status: "completed", type: "plan" },
      { title: "Convert legacy pages/index.tsx to app/page.tsx Server Component", status: "completed", type: "slm" },
      { title: "Convert pages/about.tsx to app/about/page.tsx Server Component", status: "completed", type: "slm" },
      { title: "Migrate legacy layouts to nested layout.tsx routing wrappers", status: "completed", type: "slm" },
      { title: "Execute 'next build' and page routing tests inside Depot sandbox", status: "completed", type: "sandbox" },
      { title: "Verify NextJS routing bundle outputs and publish PR branch", status: "completed", type: "flagship" }
    ],
    logs: [
      { state: "1_INTAKE", text: "[INTAKE] Next.js Page Router codebase migration target detected. Querying file structures...", type: "system" },
      { state: "1_INTAKE", text: "[INTAKE] Distilled 42 legacy routes into a clean structural page mapping document. Chromadb lookup: 21ms", type: "success" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] Initializing Flagship Model (Claude 3.5 Sonnet) to construct translation schema...", type: "system" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] NextJS conversion blueprint generated. Storing layout prefixes inside Together AI cache...", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] Launching concurrent specialized code rewriting models (Qwen 2.5 Coder 7B)...", type: "system" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-1] Migrated index.tsx home routing. Together AI Prefix Cache HIT: 93%", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-2] Refactored about.tsx and layouts into modern layouts wrappers. Time: 155ms", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[Worker-3] Wrote Vitest routing integrity tests.", type: "success" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Spinning up isolated Depot container loaded with Next v15 developer environment...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Executing 'npm run build' compiler page-generation verification specs...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] NextJS: all page route chunks generated successfully. Bundle sizes checked. Exit code: 0", type: "success" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Initiating Flagship Model logic checks for App Router optimization and hydration rules...", type: "system" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Server Component boundaries validated. Ready to ship optimal NextJS layout utilities.", type: "success" },
      { state: "7_HUMAN_HANDOFF", text: "[HANDOFF] PR #106 published. Migrated NextJS layout codebase successfully. Tasks complete.", type: "success" }
    ]
  },
  stripe: {
    id: "REC-7801-STRIPE",
    description: "Implement secure Stripe checkout webhook signature verification and checkout session endpoints",
    states: [
      { state: "1_INTAKE", statusText: "DISTILLING VECTOR CONTEXT" },
      { state: "2_ARCHITECTURAL_PLAN", statusText: "FLAGSHIP PLAN GENERATION" },
      { state: "3_SLM_EXECUTION_FANOUT", statusText: "SLM WORKER EXECUTION" },
      { state: "4_SANDBOX_VALIDATION", statusText: "SANDBOX TEST RUN" },
      { state: "6_FINAL_SYNTHESIS", statusText: "FINAL ARCHITECTURE SYNTHESIS" },
      { state: "7_HUMAN_HANDOFF", statusText: "COMPLETED & HANDED OFF" }
    ],
    subtasks: [
      { title: "Retrieve Stripe subscription API specs and DB schemas", status: "completed", type: "intake" },
      { title: "Formulate webhook endpoint signature checking plans", status: "completed", type: "plan" },
      { title: "Implement signature checking stripe.ts verification helpers", status: "completed", type: "slm" },
      { title: "Implement invoice.created webhook controller adapters", status: "completed", type: "slm" },
      { title: "Write mock Stripe request webhook payload signing test specs", status: "completed", type: "slm" },
      { title: "Execute billing integration tests using stripe-mock services", status: "completed", type: "sandbox" },
      { title: "Synthesize payment gateways status and publish PR branch", status: "completed", type: "flagship" }
    ],
    logs: [
      { state: "1_INTAKE", text: "[INTAKE] Stripe billing integration target specs received. Analyzing webhook verification limits...", type: "system" },
      { state: "1_INTAKE", text: "[INTAKE] Index matching: invoice, checkout, subscription entities synced: 8ms", type: "success" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] Dispatching Frontier Model to layout secure payload signature inspection methods...", type: "system" },
      { state: "2_ARCHITECTURAL_PLAN", text: "[PLAN] Security specifications outlined. Together AI prefix cache schemas committed.", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] Deploying concurrent specialized code writing models (Qwen 2.5 Coder 7B)...", type: "system" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-1] Wrote stripe.ts billing logic helper. Together AI Prefix Cache HIT: 92%", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[EXECUTION] [Worker-2] Restructured user invoice database adapter models. Time: 140ms", type: "success" },
      { state: "3_SLM_EXECUTION_FANOUT", text: "[Worker-3] Wrote checkout mock request payloads specs.", type: "success" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Initializing isolated Depot container sandbox with Stripe-mock servers gateway fixtures...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Triggering webhook mock payloads verification requests and inspecting DB transitions...", type: "system" },
      { state: "4_SANDBOX_VALIDATION", text: "[VALIDATE] Checkout verification succeeded. Subscriptions updated. Tests: 18/18 passed. Exit code: 0", type: "success" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Flagship Architect auditing signature validations and rate limits error handlers...", type: "system" },
      { state: "6_FINAL_SYNTHESIS", text: "[SYNTHESIS] Security checks approved. Creating billing integration pull request...", type: "success" },
      { state: "7_HUMAN_HANDOFF", text: "[HANDOFF] PR #107 compiled. Billing integration live. State machine execution completed successfully.", type: "success" }
    ]
  }
};

// --- Economic Base Calculator Constants ---
const COSTS = {
  artisanalTask: 7.40,  // GPT-4o on every single step & loop
  rectorTaskBase: 0.37, // 90% SLMs + 10% Flagship
  cacheSavings: 0.40,   // Prefix caching saves 40%
  codebaseMultiplier: {
    small: 1.0,
    medium: 1.5,
    large: 2.5
  }
};

// ============================================================
// Page Setup Dialog Controls
// ============================================================

function bindSetupModal() {
  const setupBtn = document.getElementById("setup-btn");
  const modal = document.getElementById("setup-modal");
  
  if (setupBtn && modal) {
    setupBtn.addEventListener("click", () => {
      modal.showModal();
    });
  }
}

// ============================================================
// Interactive ROI & Cognitive Arbitrage Calculator
// ============================================================

function updateCalculator() {
  const tasksInput = document.getElementById("calc-tasks");
  const sizeSelect = document.getElementById("calc-size");
  const cachingCheck = document.getElementById("check-caching");
  const healingCheck = document.getElementById("check-healing");

  const costArtisanalEl = document.getElementById("cost-artisanal");
  const costRectorEl = document.getElementById("cost-rector");
  const costSavingsEl = document.getElementById("cost-savings");

  if (!tasksInput || !sizeSelect || !cachingCheck || !healingCheck) return;

  const tasksVolume = parseInt(tasksInput.value) || 0;
  const codebaseSize = sizeSelect.value;
  const multiplier = COSTS.codebaseMultiplier[codebaseSize] || 1.0;

  // Traditional cost: Tasks * base cost * size multiplier
  let artisanalTotal = tasksVolume * COSTS.artisanalTask * multiplier;

  // Rector cost: base cost * size multiplier
  let rectorBase = COSTS.rectorTaskBase * multiplier;
  if (cachingCheck.checked) {
    rectorBase = rectorBase * (1.0 - COSTS.cacheSavings);
  }
  // Add a tiny overhead for healing if enabled
  if (healingCheck.checked) {
    rectorBase += 0.05 * multiplier;
  }

  let rectorTotal = tasksVolume * rectorBase;
  let savingsTotal = artisanalTotal - rectorTotal;

  // Keep positive
  if (savingsTotal < 0) savingsTotal = 0;

  // Format currencies
  costArtisanalEl.innerText = `$${artisanalTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  costRectorEl.innerText = `$${rectorTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  costSavingsEl.innerText = `$${savingsTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function bindCalculatorEvents() {
  const ids = ["calc-tasks", "calc-size", "check-caching", "check-healing"];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("input", updateCalculator);
      el.addEventListener("change", updateCalculator);
    }
  });

  // Run initial calculation
  updateCalculator();
}

// ============================================================
// Interactive Tabs Swapping
// ============================================================

function bindTabs() {
  const tabVisual = document.getElementById("tab-visual");
  const tabLogs = document.getElementById("tab-logs");
  const contentVisual = document.getElementById("content-visual");
  const contentLogs = document.getElementById("content-logs");

  if (tabVisual && tabLogs && contentVisual && contentLogs) {
    tabVisual.addEventListener("click", () => {
      tabVisual.classList.add("tabs__item--active");
      tabLogs.classList.remove("tabs__item--active");
      contentVisual.classList.remove("hidden");
      contentLogs.classList.add("hidden");
    });

    tabLogs.addEventListener("click", () => {
      tabLogs.classList.add("tabs__item--active");
      tabVisual.classList.remove("tabs__item--active");
      contentLogs.classList.remove("hidden");
      contentVisual.classList.add("hidden");
    });
  }
}

// ============================================================
// Interactive State Machine Simulator Engine
// ============================================================

function resetSimulator() {
  clearInterval(simInterval);
  simInterval = null;
  currentTask = null;
  currentStepIndex = -1;

  // Reset visual steps
  const steps = document.querySelectorAll(".pipeline-step");
  steps.forEach(step => {
    step.classList.remove("active", "completed");
  });

  // Reset connectors
  const connectors = document.querySelectorAll(".pipeline-connector");
  connectors.forEach(conn => {
    conn.classList.remove("active", "completed");
  });

  // Reset active status block
  document.getElementById("sim-task-id").innerText = "TASK: IDLE";
  document.getElementById("sim-task-state-badge").innerText = "NO EVENT";
  document.getElementById("sim-task-state-badge").className = "pill";
  document.getElementById("sim-task-desc").innerText = "No active task. Seed a scenario to watch the execution engine spin.";
  document.getElementById("subtask-progress-box").classList.add("hidden");
  document.getElementById("sim-subtasks-list").innerHTML = "";

  // Reset controls
  const resetBtn = document.getElementById("btn-reset-sim");
  if (resetBtn) resetBtn.disabled = true;

  // Clear Logs
  const logsBox = document.getElementById("terminal-logs-box");
  logsBox.innerHTML = '<div class="log-line system-line">[SYSTEM] Rector factory engine reset. Waiting for task ingestion event...</div>';

  if (window.lucide) {
    lucide.createIcons();
  }
}

function initScenario(type) {
  resetSimulator();
  currentTask = JSON.parse(JSON.stringify(SCENARIOS[type]));
  currentStepIndex = 0;

  document.getElementById("sim-task-id").innerText = `TASK: ${currentTask.id}`;
  document.getElementById("sim-task-state-badge").innerText = "INGESTED";
  document.getElementById("sim-task-state-badge").className = "pill text-signal";
  document.getElementById("sim-task-desc").innerText = currentTask.description;

  // Setup subtask visual elements based on scenario
  const listEl = document.getElementById("sim-subtasks-list");
  listEl.innerHTML = currentTask.subtasks.map((s, i) => `
    <div class="subtask-item-sim" id="subtask-item-${i}">
      <span>${s.title}</span>
      <span class="status-badge-sim" id="subtask-badge-${i}">queued</span>
    </div>
  `).join("");
  document.getElementById("subtask-progress-box").classList.remove("hidden");

  // Enable control buttons
  const resetBtnEl = document.getElementById("btn-reset-sim");
  if (resetBtnEl) resetBtnEl.disabled = false;

  // Write initial log
  logWrite(`[SYSTEM] Task ingested into queue. Triggering Thalamus event router. ID: ${currentTask.id}`, "system");

  // Step immediately to the first state: INTAKE
  executeStep();
}

function logWrite(text, type) {
  const logsBox = document.getElementById("terminal-logs-box");
  if (!logsBox) return;

  const line = document.createElement("div");
  line.className = `log-line ${type}-line`;
  line.innerText = text;
  logsBox.appendChild(line);
  logsBox.scrollTop = logsBox.scrollHeight;
}

function updateTelemetryStats(stepState) {
  // Ticking metrics on every transition
  simMetrics.modelInvocations += 1;
  
  if (stepState === "1_INTAKE") {
    simMetrics.cacheHits = 0;
    simMetrics.totalCost += 0.0001; // SLM ingest call
  } else if (stepState === "2_ARCHITECTURAL_PLAN") {
    simMetrics.totalCost += 0.015; // Flagship plan call
    simMetrics.cacheHits = 30;
  } else if (stepState === "3_SLM_EXECUTION_FANOUT") {
    simMetrics.cacheHits = 88;
    simMetrics.totalCost += 0.0004; // cheap SLM calls
  } else if (stepState === "4_SANDBOX_VALIDATION") {
    simMetrics.validationRuns += 1;
    simMetrics.totalCost += 0.002; // sandbox execution overhead
  } else if (stepState === "5_HEALING_LOOP") {
    simMetrics.healingRuns += 1;
    simMetrics.totalCost += 0.0008; // AST healing run
  } else if (stepState === "6_FINAL_SYNTHESIS") {
    simMetrics.synthesisRuns += 1;
    simMetrics.totalCost += 0.015; // Flagship synthesis call
  }

  // Update dynamic elements
  document.getElementById("stat-invocations").innerText = simMetrics.modelInvocations;
  document.getElementById("stat-hits").innerText = `${simMetrics.cacheHits}%`;
  document.getElementById("stat-cost").innerText = `$${simMetrics.totalCost.toFixed(4)}`;

  // Calculate dynamic savings percentage against Artisanal (which runs everything on GPT-4o = ~$0.08 per event)
  const artisanalComp = simMetrics.modelInvocations * 0.078;
  const reduction = artisanalComp > 0 ? ((artisanalComp - simMetrics.totalCost) / artisanalComp) * 100 : 95;
  document.getElementById("stat-savings").innerText = `${reduction.toFixed(0)}%`;
}

function executeStep() {
  if (!currentTask || currentStepIndex < 0 || currentStepIndex >= currentTask.states.length) {
    // Pipeline finished
    clearInterval(simInterval);
    simInterval = null;
    const playSimButton = document.getElementById("btn-play-sim");
    if (playSimButton) {
      playSimButton.innerHTML = '<i data-lucide="play"></i> Auto-Play';
      playSimButton.disabled = true;
    }
    const stepSimButton = document.getElementById("btn-step-sim");
    if (stepSimButton) {
      stepSimButton.disabled = true;
    }
    logWrite("[SYSTEM] Assembly line pipeline processing finalized deterministically.", "success");
    if (window.lucide) lucide.createIcons();
    return;
  }

  const currentStep = currentTask.states[currentStepIndex];
  const stateVal = currentStep.state;

  // 1. Update pipeline state visualization classes
  const steps = document.querySelectorAll(".pipeline-step");
  steps.forEach(step => {
    const sState = step.getAttribute("data-state");
    if (sState === stateVal) {
      step.className = "pipeline-step active";
    } else {
      // Find the index of this step in visual flow
      const stepStates = Array.from(steps).map(st => st.getAttribute("data-state"));
      const activeIdxInFlow = stepStates.indexOf(stateVal);
      const stepIdxInFlow = stepStates.indexOf(sState);

      if (stepIdxInFlow < activeIdxInFlow) {
        step.className = "pipeline-step completed";
      } else {
        step.className = "pipeline-step";
      }
    }
  });

  // Connectors coloring
  const connectors = document.querySelectorAll(".pipeline-connector");
  steps.forEach((step, idx) => {
    if (idx < connectors.length) {
      const conn = connectors[idx];
      const visualSteps = Array.from(steps);
      const activeIdx = visualSteps.findIndex(s => s.classList.contains("active"));
      if (idx < activeIdx) {
        conn.className = "pipeline-connector completed";
      } else if (idx === activeIdx) {
        conn.className = "pipeline-connector active";
      } else {
        conn.className = "pipeline-connector";
      }
    }
  });

  // 2. Set task state label
  document.getElementById("sim-task-state-badge").innerText = stateVal;
  if (stateVal === "5_HEALING_LOOP") {
    document.getElementById("sim-task-state-badge").className = "pill text-signal";
  } else if (stateVal === "7_HUMAN_HANDOFF") {
    document.getElementById("sim-task-state-badge").className = "pill";
    document.getElementById("sim-task-state-badge").style.backgroundColor = "var(--color-ink)";
    document.getElementById("sim-task-state-badge").style.color = "var(--color-on-ink)";
  } else {
    document.getElementById("sim-task-state-badge").className = "pill text-signal";
  }

  // 3. Write logs for this specific state
  const stateLogs = currentTask.logs.filter(log => log.state === stateVal);
  stateLogs.forEach(log => {
    logWrite(log.text, log.type);
  });

  // 4. Update subtask checklist dynamically based on step index
  updateSubtasksProgress(stateVal);

  // 5. Update Telemetry metrics
  updateTelemetryStats(stateVal);

  // Ready for next step
  currentStepIndex++;
}

function updateSubtasksProgress(stateVal) {
  const subtasks = currentTask.subtasks;

  if (stateVal === "1_INTAKE") {
    setSubtaskBadge(0, "running");
  } else if (stateVal === "2_ARCHITECTURAL_PLAN") {
    setSubtaskBadge(0, "completed");
    setSubtaskBadge(1, "running");
  } else if (stateVal === "3_SLM_EXECUTION_FANOUT") {
    setSubtaskBadge(1, "completed");
    setSubtaskBadge(2, "running");
    setSubtaskBadge(3, "running");
    setSubtaskBadge(4, "running");
  } else if (stateVal === "4_SANDBOX_VALIDATION") {
    // If it's the healing loop scenario and this is the first validation (step index 3)
    // subtask 4 fails.
    if (currentTask.id === "REC-3841-HEAL" && currentStepIndex === 3) {
      setSubtaskBadge(2, "completed");
      setSubtaskBadge(3, "completed");
      setSubtaskBadge(4, "failed");
    } else {
      // standard passing
      setSubtaskBadge(2, "completed");
      setSubtaskBadge(3, "completed");
      setSubtaskBadge(4, "completed");
      setSubtaskBadge(6, "running");
    }
  } else if (stateVal === "5_HEALING_LOOP") {
    setSubtaskBadge(5, "running");
  } else if (stateVal === "6_FINAL_SYNTHESIS") {
    // Set validation re-runs as completed
    if (currentTask.id === "REC-3841-HEAL") {
      setSubtaskBadge(4, "completed");
      setSubtaskBadge(5, "completed");
      setSubtaskBadge(6, "completed");
      setSubtaskBadge(7, "running");
    } else {
      setSubtaskBadge(6, "completed");
    }
  } else if (stateVal === "7_HUMAN_HANDOFF") {
    subtasks.forEach((_, i) => setSubtaskBadge(i, "completed"));
  }
}

function setSubtaskBadge(index, status) {
  const badge = document.getElementById(`subtask-badge-${index}`);
  if (badge) {
    badge.innerText = status;
    badge.className = `status-badge-sim ${status}`;
  }
}

function startAutoPlay() {
  if (simInterval) clearInterval(simInterval);
  simInterval = setInterval(() => {
    executeStep();
  }, 2200);
}

function bindSimulatorEvents() {
  const seedHappyBtn = document.getElementById("btn-seed-happy");
  const seedHealingBtn = document.getElementById("btn-seed-healing");
  const seedMigrationBtn = document.getElementById("btn-seed-migration");
  const seedStripeBtn = document.getElementById("btn-seed-stripe");
  const resetBtn = document.getElementById("btn-reset-sim");

  if (seedHappyBtn) {
    seedHappyBtn.addEventListener("click", () => {
      initScenario("happy");
      startAutoPlay();
    });
  }

  if (seedHealingBtn) {
    seedHealingBtn.addEventListener("click", () => {
      initScenario("healing");
      startAutoPlay();
    });
  }

  if (seedMigrationBtn) {
    seedMigrationBtn.addEventListener("click", () => {
      initScenario("migration");
      startAutoPlay();
    });
  }

  if (seedStripeBtn) {
    seedStripeBtn.addEventListener("click", () => {
      initScenario("stripe");
      startAutoPlay();
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      resetSimulator();
    });
  }
}

// ============================================================
// Scroll-Driven Light Animations Observer
// ============================================================

function initScrollAnimations() {
  const elements = document.querySelectorAll(".scroll-animate");
  if (elements.length === 0) return;

  const observerOptions = {
    root: null,
    rootMargin: "-6% 0px -6% 0px", // Trigger slightly inside target thresholds
    threshold: 0.05
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
      } else {
        // Reverse animation when leaving viewport frame
        entry.target.classList.remove("in-view");
      }
    });
  }, observerOptions);

  elements.forEach(el => {
    observer.observe(el);
  });
}

// ============================================================
// Initialization Entry Point
// ============================================================

function init() {
  bindSetupModal();
  bindCalculatorEvents();
  bindTabs();
  bindSimulatorEvents();
  initScrollAnimations();
}

// Run when DOM elements are fully structured
window.addEventListener("DOMContentLoaded", init);
