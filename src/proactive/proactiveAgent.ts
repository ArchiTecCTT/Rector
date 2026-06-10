import type { RectorStore } from "../store";
import type { ModelRouter } from "../providers/llm";
import { runChat, type ChatRunArgs, type ChatRunnerDeps } from "../orchestration/chatRunner";
import { triageUserMessage } from "../orchestration/triage";
import { createInMemoryObservabilityTrace } from "../observability";
import { redactString } from "../security/redaction";
import type { OrchestratorMode } from "../deployment";

/**
 * ProactiveAgent (Chunk 28 / neuro-symbolic Step 3)
 *
 * Makes Rector feel "alive". It can initiate check-ins using the existing
 * chat pipeline with a synthetic prompt and a warmer "proactive-companion" route.
 *
 * All LLM calls (if any) go through budget + redaction + the symbolic control plane.
 * In local mode, the agent is never auto-started.
 */
export class ProactiveAgent {
  private readonly store: RectorStore;
  private readonly router?: ModelRouter;
  private readonly mode: OrchestratorMode;
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: {
    store: RectorStore;
    router?: ModelRouter;
    mode?: OrchestratorMode;
  }) {
    this.store = deps.store;
    this.router = deps.router;
    this.mode = deps.mode ?? "local";
  }

  /**
   * Trigger a proactive check-in.
   * Reuses the full runChat pipeline with a synthetic user message.
   * The resulting assistant message will have source: "proactive".
   */
  async triggerCheckIn(params: {
    conversationId: string;
    syntheticUserPrompt?: string;
  }): Promise<{ runId?: string; message?: string }> {
    const { conversationId, syntheticUserPrompt = "[proactive check-in] Any pending goals, reminders, or things I can help move forward today?" } = params;

    const conversation = await this.store.getConversation(conversationId);
    if (!conversation) {
      throw new Error("Conversation not found for proactive check-in");
    }

    // Create a synthetic user message (redacted)
    const redacted = redactString(syntheticUserPrompt);
    const userMessage = await this.store.createMessage({
      conversationId,
      role: "user",
      content: redacted,
      status: "created",
      redactionState: redacted === syntheticUserPrompt ? "none" : "redacted",
    });

    const observability = createInMemoryObservabilityTrace({ provider: "local" });
    const triage = await observability.recordSpan("TRIAGE", () => triageUserMessage(redacted));

    // Build minimal context (memory from Step 2 will enrich it if present)
    const messages = await this.store.listMessages(conversationId);
    const contextPack = await observability.recordSpan("CONTEXT_BUILDING", async () => {
      // Reuse existing builder but we pass a light version here for proactive
      // In full flow the server does richer build; here we let runChat handle via args
      return {
        id: `ctx-proactive-${Date.now()}`,
        createdAt: new Date().toISOString(),
        userIntentSummary: "proactive check-in",
        conversationRef: { id: conversationId },
        messageRefs: messages.map(m => ({ id: m.id, role: m.role, status: m.status, createdAt: m.createdAt })),
        relevantDocs: [],
        relevantMemory: [],
        constraints: [],
        availableProviders: { configured: [], unavailable: [], notes: [] },
        availableTools: { names: [], notes: [] },
        riskFlags: [],
        triage,
        artifactHandles: [],
        inlineContext: [],
      } as any;
    });

    const runArgs: ChatRunArgs = {
      conversationId,
      userMessageId: userMessage.id,
      prompt: redacted,
      triage,
      contextPack,
      observability,
    };

    const runnerDeps: ChatRunnerDeps = {
      mode: this.mode,
      router: this.router,
      enableNetwork: this.mode === "external",
    };

    const result = await runChat(this.store, runArgs, runnerDeps);

    // Create the assistant message and complete the user message in the store
    if (result.synthesis) {
      await this.store.createMessage({
        conversationId,
        role: "assistant",
        content: result.synthesis.response,
        status: "completed",
        runId: result.run.id,
        redactionState: "none",
        source: "proactive",
      } as any);
      await this.store.updateMessage(userMessage.id, {
        status: "completed",
        runId: result.run.id,
      });
    }

    return {
      runId: result.run.id,
      message: result.synthesis?.response,
    };
  }

  /**
   * Start a simple timer for demo "alive" behavior (only in external mode by default).
   * In real usage this could be driven by events (long NEEDS_DECISION, idle, etc.).
   */
  startTimer(intervalMs = 1000 * 60 * 60 * 4 /* 4h demo interval */) {
    if (this.mode !== "external") {
      // Never auto-start timers in local/provider-free mode
      return;
    }
    if (this.timer) return;

    this.timer = setInterval(async () => {
      try {
        // Pick a default conversation if exists (for alpha demo)
        const convs = await this.store.listConversations();
        if (convs.length > 0) {
          await this.triggerCheckIn({ conversationId: convs[0].id });
        }
      } catch {
        // swallow for timer safety
      }
    }, intervalMs);
  }

  stopTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export function createProactiveAgent(deps: {
  store: RectorStore;
  router?: ModelRouter;
  mode?: OrchestratorMode;
}) {
  return new ProactiveAgent(deps);
}