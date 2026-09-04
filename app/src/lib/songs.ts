import {
  ActiveSongResponseSchema,
  DeleteSongResponseSchema,
  SongListResponseSchema,
  SongResponseSchema,
  type ComposeSongRequest,
  type Song,
} from "@aibleton/protocol";
import { request } from "./mate";

/**
 * Runs the song flow on mate: picks a template and band, briefs the model,
 * lays the song out, saves it and makes it active. Slow — it waits on the LLM.
 */
export async function composeSong(opts: ComposeSongRequest): Promise<Song> {
  const { song } = await request("/songs/compose", SongResponseSchema, {
    method: "POST",
    body: JSON.stringify(opts),
  });
  return song;
}

/** Saved songs, newest first. */
export async function listSongs(): Promise<Song[]> {
  const { songs } = await request("/songs", SongListResponseSchema);
  return songs;
}

/** Makes a saved song the active one. */
export async function activateSong(id: string): Promise<Song> {
  const { song } = await request(`/songs/${encodeURIComponent(id)}/activate`, SongResponseSchema, { method: "POST" });
  return song;
}

/** Clears the active song; returns what was active, if anything. */
export async function clearActiveSong(): Promise<Song | null> {
  const { song } = await request("/songs/active", ActiveSongResponseSchema, { method: "DELETE" });
  return song;
}

/** True when a song was there to delete. */
export async function deleteSong(id: string): Promise<boolean> {
  const { deleted } = await request(`/songs/${encodeURIComponent(id)}`, DeleteSongResponseSchema, { method: "DELETE" });
  return deleted;
}
