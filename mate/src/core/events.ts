import type { MateEvent } from "@aibleton/protocol";

export type EventListener = (event: MateEvent) => void;

/** Minimal typed pub/sub. Feeds the SSE route and tests. */
export class EventBus {
  private listeners = new Set<EventListener>();
  private history: MateEvent[] = [];
  constructor(private readonly keep = 200) {}

  emit(event: MateEvent): void {
    this.history.push(event);
    if (this.history.length > this.keep) this.history.shift();
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (err) {
        console.error("event listener threw", err);
      }
    }
  }
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  recent(): readonly MateEvent[] {
    return this.history;
  }
  ofType<T extends MateEvent["type"]>(type: T): Extract<MateEvent, { type: T }>[] {
    return this.history.filter((e): e is Extract<MateEvent, { type: T }> => e.type === type);
  }
}
