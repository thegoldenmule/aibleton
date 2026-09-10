import {
  DeleteSessionResponseSchema,
  ResumeSessionResponseSchema,
  SessionListResponseSchema,
  SessionResponseSchema,
  type CreateSessionRequest,
  type ResumeSessionResponse,
  type SessionSummary,
} from "@aibleton/protocol";
import { request } from "./mate";

/** What mate is holding right now: every saved session, most recently updated first, plus the one it is in. */
export function listSessions(): Promise<{ sessions: SessionSummary[]; currentId: string }> {
  return request("/sessions", SessionListResponseSchema);
}

/**
 * Starts a fresh session and switches to it; the old one keeps everything it had.
 * An omitted name becomes the session's start time. 409 while mate is busy.
 */
export function createSession(body: CreateSessionRequest = {}): Promise<ResumeSessionResponse> {
  return request("/sessions", ResumeSessionResponseSchema, { method: "POST", body: JSON.stringify(body) });
}

/** One session's summary, without switching to it. */
export async function getSession(id: string): Promise<SessionSummary> {
  const { session } = await request(`/sessions/${encodeURIComponent(id)}`, SessionResponseSchema);
  return session;
}

/**
 * Puts mate back in a session: its conversation, its goal and its song.
 * Resuming the current one is a 200 no-op, so double-firing is safe.
 * The whole `StateResponse` comes back because a switch replaces everything —
 * but so does a `state.replaced` event, which `useMateState` already folds, so
 * the caller does not have to do anything with it.
 */
export function resumeSession(id: string): Promise<ResumeSessionResponse> {
  return request(`/sessions/${encodeURIComponent(id)}/resume`, ResumeSessionResponseSchema, { method: "POST" });
}

/** True when a session was there to delete. 409 on the session mate is currently in. */
export async function deleteSession(id: string): Promise<boolean> {
  const { deleted } = await request(`/sessions/${encodeURIComponent(id)}`, DeleteSessionResponseSchema, {
    method: "DELETE",
  });
  return deleted;
}
