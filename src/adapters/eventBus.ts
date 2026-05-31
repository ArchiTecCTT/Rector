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

  publish(topic: string, payload: Record<string, unknown>): void {
    const handlers = this.subscribers.get(topic);
    if (handlers) {
      for (const handler of handlers) {
        handler(topic, payload);
      }
    }
  }

  clear(): void {
    this.subscribers.clear();
  }
}
