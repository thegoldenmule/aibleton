import {
  ActiveSongResponseSchema,
  ArrangeSongResponseSchema,
  DeleteSongResponseSchema,
  DownloadSongResponseSchema,
  ResolveSongResponseSchema,
  SongListResponseSchema,
  SongResponseSchema,
  type ArrangeSongResponse,
  type ComposeSongRequest,
  type DownloadSongResponse,
  type PickSlotRequest,
  type ResolveSongResponse,
  type SetPlacementRequest,
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

/** Searches Splice for every slot and stores ranked candidates on the song. Free. */
export function resolveSong(id: string): Promise<ResolveSongResponse> {
  return request(`/songs/${encodeURIComponent(id)}/resolve`, ResolveSongResponseSchema, { method: "POST" });
}

/** Chooses which candidate a slot downloads. */
export async function pickSlot(id: string, body: PickSlotRequest): Promise<Song> {
  const { song } = await request(`/songs/${encodeURIComponent(id)}/pick`, SongResponseSchema, { method: "POST", body: JSON.stringify(body) });
  return song;
}

/** Spends Splice credits: downloads every pending pick. Partial failure comes back as `failed`. */
export function downloadSong(id: string): Promise<DownloadSongResponse> {
  return request(`/songs/${encodeURIComponent(id)}/download`, DownloadSongResponseSchema, { method: "POST" });
}

/** Builds what the song has on disk into the Live set: tracks, session clips, arrangement copies. Adds only; safe to repeat. */
export function arrangeSong(id: string): Promise<ArrangeSongResponse> {
  return request(`/songs/${encodeURIComponent(id)}/arrange`, ArrangeSongResponseSchema, { method: "POST" });
}

/** Brings a part in for one occurrence of the form, or rests it. */
export async function setPlacement(id: string, body: SetPlacementRequest): Promise<Song> {
  const { song } = await request(`/songs/${encodeURIComponent(id)}/placements`, SongResponseSchema, { method: "PUT", body: JSON.stringify(body) });
  return song;
}

/** Drops a part from the song: its track, slots and placements. The last track cannot be removed. */
export async function deleteTrack(id: string, partId: string): Promise<Song> {
  const { song } = await request(`/songs/${encodeURIComponent(id)}/tracks/${encodeURIComponent(partId)}`, SongResponseSchema, { method: "DELETE" });
  return song;
}
