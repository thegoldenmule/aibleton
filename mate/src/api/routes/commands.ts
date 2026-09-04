import { Hono } from "hono";
import {
  PostCommandRequestSchema,
  type PostCommandResponse,
  type RecentCommandsResponse,
} from "@aibleton/protocol";
import type { StateStore } from "../../core/state.ts";
import type { Intelligence } from "../../intelligence/types.ts";

export function commandRoutes(deps: { store: StateStore; intelligence: Intelligence; mailboxSize: () => number }): Hono {
  const r = new Hono();

  r.post("/commands", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = PostCommandRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: "invalid command", issues: parsed.error.issues }, 400);
    }
    const id = deps.intelligence.submit(parsed.data.command, "api");
    const body: PostCommandResponse = { id, queued: deps.mailboxSize() };
    return c.json(body);
  });

  r.get("/commands/recent", (c) => {
    const body: RecentCommandsResponse = { commands: [...deps.store.recentCommands()].reverse() };
    return c.json(body);
  });

  return r;
}
