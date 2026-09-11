export type EventListener<E> = (event: E) => void;

/**
 * Minimal typed pub/sub. Feeds the SSE route and tests.
 *
 * The union is a type parameter with **no default**: a default would name one
 * aggregate here, and this file is the one place that should know nothing about
 * any of them. The cost is spelling the union at every construction site, which
 * is the point — a bus carries one aggregate's events and says so.
 */
export class EventBus<E extends { type: string }> {
  private listeners = new Set<EventListener<E>>();
  private history: E[] = [];
  constructor(private readonly keep = 200) {}

  emit(event: E): void {
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
  subscribe(listener: EventListener<E>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  recent(): readonly E[] {
    return this.history;
  }
  ofType<T extends E["type"]>(type: T): Extract<E, { type: T }>[] {
    return this.history.filter((e): e is Extract<E, { type: T }> => e.type === type);
  }
}
