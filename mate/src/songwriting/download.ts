import { SongSchema, pendingDownloadUuids } from "@aibleton/protocol";
import type { DownloadSongResponse, Song } from "@aibleton/protocol";
import type { Logger } from "../log.ts";
import type { SplicePort } from "../ports/splice/types.ts";

/**
 * The paid half of the Splice integration: downloading the picked sound of
 * every slot. One credit per distinct new asset, so picks are deduplicated,
 * anything already on disk is reused, and a failed download is reported and
 * never retried. Only `downloadPicks` does I/O.
 */

export interface DownloadDeps {
  splice: Pick<SplicePort, "downloadAsset">;
  /** Directory the files land in. */
  dir: string;
  log: Logger;
  /** Checked before each paid call; an aborted request stops starting new downloads. */
  signal: AbortSignal;
  /** Called after every successful download with the song so far; save and publish it here. */
  onProgress: (song: Song) => Promise<void>;
}

export type Downloaded = DownloadSongResponse["downloaded"][number];
export type DownloadFailure = DownloadSongResponse["failed"][number];

export interface DownloadOutcome {
  song: Song;
  downloaded: Downloaded[];
  failed: DownloadFailure[];
}

/** Copy `resolved` onto every slot whose pick another slot already has on disk. Free. */
export function reuseDownloaded(song: Song): Song {
  const onDisk = new Map<string, NonNullable<Song["plan"]["slots"][number]["resolved"]>>();
  for (const slot of song.plan.slots) {
    if (slot.resolved?.localPath) onDisk.set(slot.resolved.soundUuid, slot.resolved);
  }
  let changed = false;
  const slots = song.plan.slots.map((slot) => {
    if (!slot.pickedUuid || slot.resolved?.soundUuid === slot.pickedUuid) return slot;
    const found = onDisk.get(slot.pickedUuid);
    if (!found) return slot;
    changed = true;
    return { ...slot, resolved: found };
  });
  return changed ? SongSchema.parse({ ...song, plan: { ...song.plan, slots } }) : song;
}

/**
 * What a download would spend: each pending uuid with the slots that want
 * it. A uuid counts only where it is among the owning slot's candidates, so a
 * hand-edited song file cannot trigger arbitrary paid downloads.
 */
export function downloadPlan(song: Song): { uuid: string; slotIds: string[] }[] {
  return pendingDownloadUuids(song.plan)
    .map((uuid) => ({
      uuid,
      slotIds: song.plan.slots.filter((s) => s.pickedUuid === uuid && s.candidates.some((c) => c.uuid === uuid)).map((s) => s.id),
    }))
    .filter((entry) => entry.slotIds.length > 0);
}

/** Download every pending pick, one asset at a time, reporting progress as each lands. */
export async function downloadPicks(song: Song, deps: DownloadDeps): Promise<DownloadOutcome> {
  let current = reuseDownloaded(song);
  if (current !== song) await deps.onProgress(current);

  const downloaded: Downloaded[] = [];
  const failed: DownloadFailure[] = [];
  for (const { uuid, slotIds } of downloadPlan(current)) {
    if (deps.signal.aborted) {
      deps.log.warn(`client gone; not starting more paid downloads (${uuid} and later skipped)`);
      break;
    }
    let result;
    try {
      result = await deps.splice.downloadAsset(uuid, deps.dir);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.log.warn(`download of ${uuid} failed: ${error}`);
      failed.push({ uuid, slotIds, error });
      continue;
    }
    const resolved = { soundUuid: uuid, fileName: result.fileName, localPath: result.localPath };
    current = SongSchema.parse({
      ...current,
      plan: { ...current.plan, slots: current.plan.slots.map((s) => (slotIds.includes(s.id) ? { ...s, resolved } : s)) },
    });
    downloaded.push({ uuid, fileName: result.fileName, localPath: result.localPath, slotIds });
    await deps.onProgress(current);
  }
  return { song: current, downloaded, failed };
}
