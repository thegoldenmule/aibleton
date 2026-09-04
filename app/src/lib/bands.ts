import {
  BandListResponseSchema,
  BandResponseSchema,
  DeleteBandResponseSchema,
  type Band,
  type GenerateBandRequest,
} from "@aibleton/protocol";
import { request } from "./mate";

/** Saved bands, newest first. */
export async function listBands(): Promise<Band[]> {
  const { bands } = await request("/bands", BandListResponseSchema);
  return bands;
}

/** Generates a band server-side. The result is NOT saved — POST it back with `saveBand`. */
export async function generateBand(opts: GenerateBandRequest = {}): Promise<Band> {
  const { band } = await request("/bands/generate", BandResponseSchema, {
    method: "POST",
    body: JSON.stringify(opts),
  });
  return band;
}

/** Upserts a band and returns what the store kept. */
export async function saveBand(band: Band): Promise<Band> {
  const res = await request("/bands", BandResponseSchema, {
    method: "POST",
    body: JSON.stringify({ band }),
  });
  return res.band;
}

/** True when a band was there to delete. */
export async function deleteBand(id: string): Promise<boolean> {
  const { deleted } = await request(`/bands/${encodeURIComponent(id)}`, DeleteBandResponseSchema, {
    method: "DELETE",
  });
  return deleted;
}
