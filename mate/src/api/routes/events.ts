import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Logger } from "../../log.ts";

const KEEPALIVE_MS = 15_000;

/**
 * One aggregate riding on the shared `/events` stream.
 *
 * There is **no envelope**: the SSE `event:` field *is* the tag, and every
 * aggregate's event names are unique across the three unions (pinned by
 * `library.fold.test.ts`), so the frame's data can stay the event object itself
 * and no consumer needs an unwrap step.
 *
 * `subscribe` is a closure rather than the bus itself on purpose: handing the
 * route a bare `EventBus<E>` would make the descriptor's variance depend on
 * method bivariance, which `strictFunctionTypes` does not check. A closure that
 * accepts the widest event shape is checked properly.
 */
export interface AggregateStream {
  /** SSE event name of this aggregate's opening frame: `"snapshot"`, `"bands.snapshot"`, … */
  snapshot: string;
  /** The picture that frame carries, read at connect time. May be async. */
  state: () => unknown | Promise<unknown>;
  /** Forwards every event to `send`; returns the detach. */
  subscribe: (send: (event: { type: string }) => void) => () => void;
}

/**
 * GET /events: server-sent events, one connection for every aggregate.
 *
 * Each stream opens with its own frame — `event: snapshot` for the session,
 * `event: bands.snapshot`, `event: templates.snapshot` — and every event after
 * that is forwarded as `event: <its own type>`. The streams are written in the
 * order given, so the first frame on the wire is the first stream's snapshot.
 */
export function eventRoutes(streams: readonly AggregateStream[], log: Logger): Hono {
  const r = new Hono();

  r.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let seq = 0;
      let closed = false;
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((res) => (resolveDone = res));
      const unsubscribes: (() => void)[] = [];
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        // Every stream's detach, not just the last one: a connection that let
        // one subscription outlive it would write into a closed stream forever.
        for (const unsubscribe of unsubscribes) unsubscribe();
        resolveDone();
      };

      const write = (event: string, data: unknown): Promise<void> => {
        if (closed) return Promise.resolve();
        return stream.writeSSE({ event, data: JSON.stringify(data), id: String(seq++) }).catch(() => finish());
      };

      // Events that arrived before the opening frames went out. `null` once
      // forwarding is live.
      let pending: { type: string }[] | null = [];

      // The order below is the whole correctness of this handler; a refactor
      // that reshuffles it breaks the stream silently.
      //
      // 1. Subscribe to **every** stream before reading a single picture, with
      //    no `await` in between, so nothing emitted from this moment on can be
      //    lost. That is the one-aggregate rule this route always had,
      //    generalised.
      // 2. Buffer what arrives instead of writing it: a `state()` may be async
      //    (the libraries' `list()` is), and a `band.saved` written while
      //    `bands.snapshot` is still being read would land *ahead* of the
      //    snapshot that then overwrites it on the client. Resolving the
      //    pictures before subscribing is not the fix either — that reopens the
      //    gap the first rule closes.
      // 3. Read the pictures. This is the only await in the opening sequence.
      // 4. Write every opening frame and drain the buffer in **one synchronous
      //    span**, so no event can slip between a snapshot and the events that
      //    followed it. `writeSSE` queues on the underlying writer in call
      //    order, so awaiting nothing here is what makes the wire order equal
      //    to the call order.
      for (const s of streams) {
        unsubscribes.push(
          s.subscribe((event) => {
            if (closed) return;
            if (pending) pending.push(event);
            else void write(event.type, event);
          }),
        );
      }

      // Registered before the await, so a client that disconnects while a
      // picture is still being read still detaches every subscription.
      stream.onAbort(finish);
      c.req.raw.signal.addEventListener("abort", finish);
      log.debug("SSE client connected");

      let pictures: unknown[];
      try {
        pictures = await Promise.all(streams.map((s) => s.state()));
      } catch (err) {
        log.error("SSE: an opening picture could not be read", err);
        finish();
        return;
      }

      // No `await` from here to the end of the drain.
      let opening = Promise.resolve();
      for (let i = 0; i < streams.length; i++) opening = write(streams[i]!.snapshot, pictures[i]);
      const buffered = pending ?? [];
      pending = null;
      for (const event of buffered) opening = write(event.type, event);

      keepalive = setInterval(() => {
        if (closed) return;
        stream.write(`: keepalive ${Date.now()}\n\n`).catch(() => finish());
      }, KEEPALIVE_MS);

      await opening;
      await done;
      log.debug("SSE client disconnected");
    }),
  );

  return r;
}
