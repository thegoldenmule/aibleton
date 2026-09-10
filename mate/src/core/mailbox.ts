import { PRIORITY_COMMANDS, type Command } from "./commands.ts";

/**
 * In-memory command queue the agent loop drains.
 * - Priority lane: cancel/pause/resume/shutdown jump ahead of everything.
 * - Coalescing: at most one pending `tick`; `abletonChanged` and `songChanged` keep only the newest.
 */
export class Mailbox {
  private priority: Command[] = [];
  private normal: Command[] = [];
  private onEnqueue: ((cmd: Command) => void) | null = null;

  /** Called for every accepted command; the loop uses this to wake up. */
  setListener(fn: ((cmd: Command) => void) | null): void {
    this.onEnqueue = fn;
  }

  enqueue(cmd: Command): void {
    if (PRIORITY_COMMANDS.has(cmd.type)) {
      this.priority.push(cmd);
    } else if (cmd.type === "tick") {
      if (!this.normal.some((c) => c.type === "tick")) this.normal.push(cmd);
      else return;
    } else if (cmd.type === "abletonChanged") {
      this.normal = this.normal.filter((c) => c.type !== "abletonChanged");
      this.normal.push(cmd);
    } else if (cmd.type === "songChanged") {
      // A digest is a picture of the whole plan, so only the newest one can be right. A resolve
      // saves once per slot, and a burst of those would otherwise queue twenty stale pictures.
      this.normal = this.normal.filter((c) => c.type !== "songChanged");
      this.normal.push(cmd);
    } else {
      this.normal.push(cmd);
    }
    this.onEnqueue?.(cmd);
  }

  next(): Command | undefined {
    return this.priority.shift() ?? this.normal.shift();
  }
  size(): number {
    return this.priority.length + this.normal.length;
  }
  peekAll(): readonly Command[] {
    return [...this.priority, ...this.normal];
  }
  clear(): void {
    this.priority = [];
    this.normal = [];
  }
}
