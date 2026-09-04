import { Hono } from "hono";
import type { StateStore } from "../../core/state.ts";

export function stateRoutes(store: StateStore): Hono {
  const r = new Hono();
  r.get("/state", (c) => c.json(store.snapshot()));
  return r;
}
