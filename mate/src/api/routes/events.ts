import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { StateStore } from "../../core/state.ts";
import type { Logger } from "../../log.ts";

const KEEPALIVE_MS = 15_000;

/**
 * GET /events: server-sent events. First message is `event: snapshot` carrying the full
 * StateResponse, then every EventBus event is forwarded as `event: <type>`.
 */
export function eventRoutes(store: StateStore, log: Logger): Hono {
  const r = new Hono();

  r.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let seq = 0;
      let closed = false;
      let resolveDone: () => void = () => {};
      const done = new Promise<void>((res) => (resolveDone = res));
      let unsubscribe: () => void = () => {};
      let keepalive: ReturnType<typeof setInterval> | undefined;
      const finish = () => {
        if (closed) return;
        closed = true;
        if (keepalive) clearInterval(keepalive);
        unsubscribe();
        resolveDone();
      };

      // Subscribe before the first write so nothing emitted while the snapshot is in flight is lost.
      // Writes on the underlying writer are queued in order, so the snapshot still goes out first.
      unsubscribe = store.events.subscribe((event) => {
        if (closed) return;
        stream.writeSSE({ event: event.type, data: JSON.stringify(event), id: String(seq++) }).catch(() => finish());
      });

      const snapshotWrite = stream.writeSSE({ event: "snapshot", data: JSON.stringify(store.snapshot()), id: String(seq++) });

      keepalive = setInterval(() => {
        if (closed) return;
        stream.write(`: keepalive ${Date.now()}\n\n`).catch(() => finish());
      }, KEEPALIVE_MS);

      stream.onAbort(finish);
      c.req.raw.signal.addEventListener("abort", finish);

      log.debug("SSE client connected");
      await snapshotWrite;
      await done;
      log.debug("SSE client disconnected");
    }),
  );

  return r;
}
