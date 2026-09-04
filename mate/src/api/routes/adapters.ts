import { Hono } from "hono";
import type { AdaptersResponse } from "@aibleton/protocol";
import type { StateStore } from "../../core/state.ts";

export function adaptersRoutes(store: StateStore): Hono {
  const r = new Hono();
  r.get("/adapters", (c) => {
    const body: AdaptersResponse = store.getAdapters();
    return c.json(body);
  });
  return r;
}
