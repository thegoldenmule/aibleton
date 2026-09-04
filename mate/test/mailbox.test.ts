import { describe, expect, test } from "bun:test";
import { ManualClock } from "../src/core/clock.ts";
import { envelope, type Command } from "../src/core/commands.ts";
import { Mailbox } from "../src/core/mailbox.ts";

const cmd = (body: Parameters<typeof envelope>[0]): Command => envelope(body, "test", 0);

describe("Mailbox", () => {
  test("two ticks coalesce to one", () => {
    const m = new Mailbox();
    m.enqueue(cmd({ type: "tick" }));
    m.enqueue(cmd({ type: "tick" }));
    expect(m.size()).toBe(1);
    expect(m.next()?.type).toBe("tick");
    expect(m.next()).toBeUndefined();
  });

  test("cancel pops before earlier FIFO items", () => {
    const m = new Mailbox();
    m.enqueue(cmd({ type: "userRequest", text: "a" }));
    m.enqueue(cmd({ type: "userRequest", text: "b" }));
    m.enqueue(cmd({ type: "cancel" }));
    expect(m.next()?.type).toBe("cancel");
    expect(m.next()).toMatchObject({ type: "userRequest", text: "a" });
    expect(m.next()).toMatchObject({ type: "userRequest", text: "b" });
  });

  test("abletonChanged keeps only the newest", () => {
    const m = new Mailbox();
    m.enqueue(cmd({ type: "abletonChanged", hint: "tempo" }));
    m.enqueue(cmd({ type: "userRequest", text: "x" }));
    m.enqueue(cmd({ type: "abletonChanged", hint: "clips" }));
    expect(m.size()).toBe(2);
    expect(m.next()?.type).toBe("userRequest");
    expect(m.next()).toMatchObject({ type: "abletonChanged", hint: "clips" });
  });

  test("listener fires for accepted commands only", () => {
    const m = new Mailbox();
    let n = 0;
    m.setListener(() => n++);
    m.enqueue(cmd({ type: "tick" }));
    m.enqueue(cmd({ type: "tick" })); // coalesced, no notification
    expect(n).toBe(1);
  });
});

describe("ManualClock", () => {
  test("fires timers in due order and advances now()", () => {
    const c = new ManualClock();
    const order: string[] = [];
    c.setTimeout(() => order.push("b"), 200);
    c.setTimeout(() => order.push("a"), 100);
    c.advance(150);
    expect(order).toEqual(["a"]);
    expect(c.now()).toBe(150);
    c.advance(100);
    expect(order).toEqual(["a", "b"]);
    expect(c.now()).toBe(250);
  });

  test("re-armed timers fire once per period, never double", () => {
    const c = new ManualClock();
    let fires = 0;
    const arm = () => c.setTimeout(() => (fires++, arm()), 100);
    arm();
    c.advance(1000);
    expect(fires).toBe(10);
    expect(c.pending()).toBe(1);
  });

  test("cleared timers do not fire", () => {
    const c = new ManualClock();
    let fired = false;
    const h = c.setTimeout(() => (fired = true), 10);
    c.clearTimeout(h);
    c.advance(100);
    expect(fired).toBe(false);
  });
});
