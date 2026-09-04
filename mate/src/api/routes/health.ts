import { Hono } from "hono";
import type { HealthResponse } from "@aibleton/protocol";

export function healthRoutes(startedAt: number): Hono {
  const r = new Hono();
  r.get("/health", (c) => {
    const body: HealthResponse = { ok: true, uptimeMs: Date.now() - startedAt };
    return c.json(body);
  });
  return r;
}
