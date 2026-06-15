import { redactSecrets } from "../security/redaction.js";

export type EventHandler = (topic: string, payload: Record<string, unknown>) => void;

export class InMemoryEventBus {
  private subscribers = new Map<string, Set<EventHandler>>();

  subscribe(topic: string, handler: EventHandler): () => void {
    if (!this.subscribers.has(topic)) {
      this.subscribers.set(topic, new Set());
    }
    this.subscribers.get(topic)!.add(handler);

    // Return unsubscribe function
    return () => {
      const set = this.subscribers.get(topic);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.subscribers.delete(topic);
        }
      }
    };
  }

  /** Publish a payload without redaction. Use for internal orchestration where the payload
   *  never crosses a process boundary (e.g. task pipeline events within the worker layer). */
  publish(topic: string, payload: Record<string, unknown>): void {
    const handlers = this.subscribers.get(topic);
    if (handlers) {
      for (const handler of handlers) {
        handler(topic, payload);
      }
    }
  }

  /** Publish a payload after applying {@link redactSecrets} to strip any embedded secrets
   *  before dispatching. Use at SSE/streaming boundaries where the payload leaves the process
   *  (e.g. run events broadcast to SSE subscribers). (M3) */
  publishRedacted(topic: string, payload: Record<string, unknown>): void {
    const redacted = redactSecrets(payload);
    const handlers = this.subscribers.get(topic);
    if (handlers) {
      for (const handler of handlers) {
        handler(topic, redacted);
      }
    }
  }

  clear(): void {
    this.subscribers.clear();
  }
}
