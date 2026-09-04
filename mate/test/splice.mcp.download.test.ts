import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { silentLogger } from "../src/log.ts";
import { McpSpliceAdapter, type FetchLike } from "../src/ports/splice/mcp.ts";

const RESPONSE = `## Download Ready
**File Name:** PL_SC_90_Drum_Break_Loop_Frisco_E.wav
**Asset UUID:** 1d2df67b-275d-4c99-823d-05605e70f15d
**Asset Type:** sample
**Credit Spent:** yes
**Remaining Downloads (24h):** 97
**Download URL:** https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/2908e38b?X-Amz-Expires=119&X-Amz-Signature=abc
`;

/** The adapter with the MCP call replaced by the captured response and the file fetch by a script. */
function adapter(fetchImpl: FetchLike) {
  const a = new McpSpliceAdapter({ url: "http://127.0.0.1:1/mcp", log: silentLogger, fetch: fetchImpl });
  a.connection.callTool = async () => RESPONSE;
  return a;
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mate-splice-dl-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("McpSpliceAdapter.downloadAsset", () => {
  test("parses the real download response and writes the fetched bytes", async () => {
    const urls: string[] = [];
    const a = adapter(async (input) => {
      urls.push(String(input));
      return new Response("RIFFdata", { status: 200 });
    });
    const r = await a.downloadAsset("1d2df67b-275d-4c99-823d-05605e70f15d", dir);
    expect(r.fileName).toBe("PL_SC_90_Drum_Break_Loop_Frisco_E.wav");
    expect(r.localPath).toBe(join(dir, "PL_SC_90_Drum_Break_Loop_Frisco_E.wav"));
    expect(urls).toEqual(["https://spliceproduction.s3.us-west-1.amazonaws.com/audio_samples/2908e38b?X-Amz-Expires=119&X-Amz-Signature=abc"]);
    expect((await readFile(r.localPath)).toString()).toBe("RIFFdata");
  });

  test("retries the fetch once, then gives up with the reason", async () => {
    let calls = 0;
    const flaky = adapter(async () => {
      calls++;
      if (calls === 1) throw new Error("socket hang up");
      return new Response("ok", { status: 200 });
    });
    await expect(flaky.downloadAsset("1d2df67b-275d-4c99-823d-05605e70f15d", dir)).resolves.toMatchObject({ fileName: "PL_SC_90_Drum_Break_Loop_Frisco_E.wav" });
    expect(calls).toBe(2);

    let denied = 0;
    const dead = adapter(async () => {
      denied++;
      return new Response("expired", { status: 403 });
    });
    await expect(dead.downloadAsset("1d2df67b-275d-4c99-823d-05605e70f15d", dir)).rejects.toThrow(/HTTP 403/);
    expect(denied).toBe(2);
  });
});
