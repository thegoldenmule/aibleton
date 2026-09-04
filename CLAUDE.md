# aibleton

AI bandmate for practicing musicians, drummers first. Bun-workspaces monorepo, all TypeScript.

- `mate/` — local Bun service: mailbox-fed state-machine agent loop, Hono HTTP API, MCP clients for Ableton and Splice, Anthropic "brain".
- `app/` — Next.js (app router, Tailwind 4) stripped-down DAW view. Non-realtime: it re-renders on mate's SSE events only.
- `packages/protocol/` — `@aibleton/protocol`: zod schemas + types shared by mate and app. Raw TS, consumed via Next `transpilePackages`.

## Commands

```bash
bun install                         # once, at repo root
bun run --cwd mate test             # offline unit tests (bun test)
bun run typecheck                   # protocol + mate + app
MATE_ABLETON=stub MATE_SPLICE=stub MATE_BRAIN=scripted bun run --cwd mate dev   # all-stub mate on :4545
bun run --cwd app dev               # UI on :3000 (NEXT_PUBLIC_MATE_URL defaults to http://localhost:4545)
./deploy.sh -i key.pem [--setup] user@host   # demo box; see deploy/README.md
```

Env vars are documented in `.env.example`. Modes per dependency: `MATE_ABLETON`/`MATE_SPLICE` = `auto | mcp | stub`, `MATE_BRAIN` = `auto | anthropic | scripted`. `auto` tries the real thing at startup and falls back to the stub with a logged reason; `GET /adapters` reports what is live.

## Architecture rules (keep these true)

- **Contracts first.** `packages/protocol` is the wire contract; `mate/src/core/commands.ts`, `intelligence/brain/types.ts`, `ports/*/types.ts` are the internal contracts. Change them deliberately and update both sides.
- **The reducer is pure.** `intelligence/machine.ts` is `step(state, command) -> { state, effects }` with no I/O. All I/O lives in `intelligence/effects.ts`. Completions (snapshot, brain result, actions done) re-enter the mailbox as commands with `source: "loop"` and carry a `requestId`; stale results are ignored.
- **The machine is the only mutator.** The brain returns a `Decision { message, actions, followUp? }`; it never touches Ableton directly. In `AnthropicBrain`, read-only tools run inline, mutating tool calls are collected into `actions`.
- **Ports are domain-level.** `AbletonPort`/`SplicePort` expose musical operations, never MCP types. Each has an MCP adapter and an in-memory/fixture stub; tests use the stubs or recording fakes and a `ManualClock`. No network in `bun test`.
- **Timing goes through `Clock`.** Never call `setTimeout`/`Date.now()` directly in loop code; ticks are re-armed per tick, not `setInterval`.

## Conventions

- **Commit incrementally to `main`.** No feature branches; commit each coherent step (a module, a fix, a test) directly on `main` as you go, with a short imperative message. Don't batch a whole task into one commit.

- Strict TS, ESM, explicit `.ts` extensions on relative imports (`verbatimModuleSyntax`), `import type` for types.
- Validate at boundaries with zod (env in `config.ts`, API bodies, MCP payloads). Inside mate, plain TS types.
- **UI verification is manual.** Do not drive a browser or screenshot the app yourself. Start mate and the app dev server, then ask the user to look and give them the link (normally http://localhost:3000). Typecheck and lint still run automatically.
- **Never run `next build`.** It writes the same `.next/` the dev server is serving from and kills a running `bun run dev:app`. `bun run typecheck` plus `bun run --cwd app lint` are the gates for app changes; there is no build step to verify.
- Tests live in `mate/test/*.test.ts` and run with `bun test`. Add a test when you add a machine transition.
- Anthropic: `@anthropic-ai/sdk`, model from `MATE_MODEL` (default `claude-opus-5`), adaptive thinking (omit `thinking`), check `stop_reason === "refusal"` before reading content. Credentials resolve from `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile; don't hardcode keys.

## Gotchas

- Ableton MCP (`uvx ableton-mcp`, stdio, see `.mcp.json`) returns `{"result": "<JSON string>"}` and the inner string may have a trailing `---` banner appended: parse the first balanced JSON object. Every Ableton tool takes `user_prompt`; the adapter fills it with the originating request text (the user chose to keep contributing to the server's open dataset).
- Splice MCP (`https://mcp.splice.com/mcp`) returns **markdown**, parsed in `ports/splice/markdown.ts`. The server needs OAuth: `bun run --cwd mate splice:login` opens the browser once and saves the registration and tokens to `.mate/splice-oauth.json` (`ports/mcp/oauth.ts`, refreshed by the SDK on 401); without that file `auto` falls back to the fixture stub with a "not logged in" reason, and `SPLICE_MCP_TOKEN` is a plain bearer override. `download_asset` spends a credit; it is reachable only through `POST /songs/:id/download` behind the app's confirm (`songwriting/download.ts`), never as a brain tool. Search is free: `songwriting/resolve.ts` fans short per-slot queries out and scores hits on bpm, key and loop length, because Splice returns 10 hits per query with no key filter.
- Ableton MCP answers every failure with prose starting `Error` (never an MCP error) and most mutations with a sentence, so `ports/ableton/mcp.ts` checks that prefix before reading anything and takes a snapshot to learn a new track's index. The server has no delete-track, delete-arrangement-clip, create-scene, or warp tools: mate only ever **adds**, a re-pick leaves old arrangement copies for the drummer to cut, section labels must fit the set's scene count, and the imported clip's length is whatever Live's auto-warp decided (`dawStatus` reads it back and counts copies from it).
- **Mate's tracks are the ones named with the `[mate]` suffix** (`packages/protocol/src/daw.ts`). That name is the only identity Live exposes. `dawStatus(song, session)` is the pure song-vs-set diff used by `songwriting/arrange.ts` (runs the steps, called by `POST /songs/:id/arrange` and after every download) and by the app (in-Live markers). The machine drops brain actions on any other track (`guardDecision`), and brain-created MIDI tracks get the suffix as they are made. The set tempo is set once, on the first arrange of a song.
- **Parts come in and out.** `songwriting/lineup.ts` decides who plays in each form occurrence: the brief's `arrangement` when it lines up with the final form, else a rule (role rank × section intensity, thinner first pass). A missing placement is a rest; a slot exists only where it is played (schema-enforced, since slots cost searches and credits). `PUT /songs/:id/placements` toggles one cell; resting the last occurrence of a part × section drops that slot and its pick.
- Out of scope so far: real MIDI input (`inputs/midi.ts` is a placeholder), realtime playback/playhead, actual drum-pattern generation.

`app/CLAUDE.md` holds Next.js-specific guidance generated by create-next-app.
