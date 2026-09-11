import { Hono } from "hono";
import {
  CreateSessionRequestSchema,
  type DeleteSessionResponse,
  type ResumeSessionResponse,
  type SessionListResponse,
  type SessionResponse,
} from "@aibleton/protocol";
import { isValidSessionId, type SessionManager } from "../../core/sessions.ts";
import type { StateStore } from "../../core/state.ts";
import type { Logger } from "../../log.ts";

/**
 * The session library: list what mate remembers, start a new one, go back to an
 * old one.
 *
 * Every switch is `SessionManager`'s — routes are Hono plumbing, zod parsing
 * and status codes, the way the song routes leave every song operation to
 * `SongService`. What lives here that the manager does not need is the one
 * refusal it cannot make for itself, and the status codes.
 */
export interface SessionRouteDeps {
  /** The one place the current session changes. */
  sessions: SessionManager;
  /** Read for `activity`: the one thing a switch waits for. */
  store: StateStore;
  log: Logger;
}

export function sessionRoutes(deps: SessionRouteDeps): Hono {
  const r = new Hono();

  /**
   * Why a switch cannot happen right now, or null.
   *
   * Only one thing qualifies: a song operation the drummer started themselves.
   * `cancellable` marks the ones the loop owns and can therefore be stopped —
   * `SessionManager` pauses the loop and drops them. What is left is a compose
   * or a download running behind their own confirm, spending credits and
   * writing a song; replacing the store underneath one would strand it.
   *
   * The loop's own phase is deliberately **not** consulted. With a real brain
   * and a five-second tick mate is thinking most of the time, and "mate is
   * deciding" is never a reason the drummer cannot start a new session — that
   * is mate's business, not theirs.
   */
  const blocked = (): string | null => {
    const activity = deps.store.getActivity();
    if (activity && !activity.cancellable) return `mate is in the middle of a ${activity.kind}`;
    return null;
  };

  r.get("/sessions", async (c) => {
    const body: SessionListResponse = { sessions: await deps.sessions.list(), currentId: deps.sessions.currentId() };
    return c.json(body);
  });

  /** Start a fresh session and switch to it. The old one keeps everything it had. */
  r.post("/sessions", async (c) => {
    // A body is optional here — an unnamed session takes its start time — so an
    // empty one is `{}`, and only malformed JSON is a 400.
    const text = await c.req.text();
    let raw: unknown = {};
    if (text.trim().length > 0) {
      try {
        raw = JSON.parse(text);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
    }
    const parsed = CreateSessionRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "invalid request", issues: parsed.error.issues }, 400);

    const reason = blocked();
    if (reason) return c.json({ error: `${reason}; try again when it is done` }, 409);

    const name = parsed.data.name;
    const switched = await deps.sessions.create(name === undefined ? undefined : name);
    deps.log.info(`started session ${switched.session.id}`);
    const body: ResumeSessionResponse = { session: switched.session, state: switched.state };
    return c.json(body);
  });

  r.get("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidSessionId(id)) return c.json({ error: `invalid session id ${JSON.stringify(id)}` }, 400);
    const session = await deps.sessions.get(id);
    if (!session) return c.json({ error: `no session ${id}` }, 404);
    const body: SessionResponse = { session };
    return c.json(body);
  });

  /** Put mate back in a session: its conversation, its goal and its song. Reads no body. */
  r.post("/sessions/:id/resume", async (c) => {
    const id = c.req.param("id");
    if (!isValidSessionId(id)) return c.json({ error: `invalid session id ${JSON.stringify(id)}` }, 400);
    const session = await deps.sessions.get(id);
    if (!session) return c.json({ error: `no session ${id}` }, 404);

    // Checked before `blocked`, because resuming the session mate is already in
    // changes nothing at all: the app may double-fire it, and answering 409 to
    // a request for the state it is already showing would only confuse it.
    if (id !== deps.sessions.currentId()) {
      const reason = blocked();
      if (reason) return c.json({ error: `${reason}; try again when it is done` }, 409);
    }

    const switched = await deps.sessions.resume(id);
    if (switched.switched) deps.log.info(`resumed session ${id}`);
    const body: ResumeSessionResponse = { session: switched.session, state: switched.state };
    return c.json(body);
  });

  r.delete("/sessions/:id", async (c) => {
    const id = c.req.param("id");
    if (!isValidSessionId(id)) return c.json({ error: `invalid session id ${JSON.stringify(id)}` }, 400);
    // The journal has the current session's file open: deleting it would leave
    // every later append going to an unlinked inode, writing the drummer's
    // session into nowhere. Move somewhere else first.
    if (id === deps.sessions.currentId()) {
      return c.json({ error: `session ${id} is the current one; resume another session before deleting it` }, 409);
    }
    const body: DeleteSessionResponse = { deleted: await deps.sessions.delete(id) };
    return c.json(body);
  });

  return r;
}
