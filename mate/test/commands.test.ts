import { expect, test } from "bun:test";
import { newId } from "../src/core/commands.ts";

test("ids are unique within a process", () => {
  const ids = new Set(Array.from({ length: 1000 }, () => newId("tx")));
  expect(ids.size).toBe(1000);
});

/**
 * The real hazard: `newId`'s counter restarts at 1 every boot, so without a per-process salt two
 * mates starting in the same millisecond mint identical ids — which `--watch` reloads really do.
 * That matters because the fold dedupes `transcript.appended` by id and those ids are journaled, so
 * a collision across a restart would silently drop a line of the conversation.
 *
 * Only a second process can prove the fix, and it only proves anything if both mint during the same
 * millisecond — so both spin-wait to one absolute target before they start counting.
 */
test("ids from two processes at the same millisecond do not collide", async () => {
  const target = Date.now() + 500;
  const script = `
    const { newId } = await import("${import.meta.dir}/../src/core/commands.ts");
    while (Date.now() < ${target}) {}
    const out = [];
    for (let i = 0; i < 500; i++) out.push(newId("tx"));
    console.log(out.join(","));
  `;
  const run = async () => {
    const proc = Bun.spawn(["bun", "-e", script], { stdout: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.trim().split(",");
  };
  const [a, b] = await Promise.all([run(), run()]);
  expect(a).toHaveLength(500);
  expect(b).toHaveLength(500);
  // Both ran over the same wall-clock window, or the test proved nothing.
  const ms = (id: string) => id.split("_")[1];
  const shared = new Set(a.map(ms)).intersection(new Set(b.map(ms)));
  expect(shared.size).toBeGreaterThan(0);
  expect(new Set([...a, ...b]).size).toBe(1000);
});
