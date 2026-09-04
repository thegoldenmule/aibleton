export type TimerHandle = number;

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export class SystemClock implements Clock {
  private handles = new Map<TimerHandle, ReturnType<typeof setTimeout>>();
  private next = 1;
  now(): number {
    return Date.now();
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = this.next++;
    this.handles.set(
      handle,
      setTimeout(() => {
        this.handles.delete(handle);
        fn();
      }, ms),
    );
    return handle;
  }
  clearTimeout(handle: TimerHandle): void {
    const t = this.handles.get(handle);
    if (t !== undefined) {
      clearTimeout(t);
      this.handles.delete(handle);
    }
  }
}

/** Deterministic clock for tests: time only moves when advance() is called. */
export class ManualClock implements Clock {
  private time: number;
  private next = 1;
  private timers: { handle: TimerHandle; due: number; seq: number; fn: () => void }[] = [];

  constructor(start = 0) {
    this.time = start;
  }
  now(): number {
    return this.time;
  }
  setTimeout(fn: () => void, ms: number): TimerHandle {
    const handle = this.next++;
    this.timers.push({ handle, due: this.time + Math.max(0, ms), seq: handle, fn });
    return handle;
  }
  clearTimeout(handle: TimerHandle): void {
    this.timers = this.timers.filter((t) => t.handle !== handle);
  }
  pending(): number {
    return this.timers.length;
  }
  /** Advance time, firing due timers in order (timers armed while firing are honoured if due). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.seq - b.seq);
      const nextTimer = due[0];
      if (!nextTimer) break;
      this.timers = this.timers.filter((t) => t.handle !== nextTimer.handle);
      this.time = Math.max(this.time, nextTimer.due);
      nextTimer.fn();
    }
    this.time = target;
  }
}
