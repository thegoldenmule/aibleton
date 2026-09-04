# Song → Splice clips: research notes

Captured 2026-09-04 against the live Splice MCP server (`https://mcp.splice.com/mcp`) from
Claude Code's authenticated session. Real responses are saved under
`mate/src/ports/splice/fixtures/` (`stack_response.md`, `search_response_keys.md`).

## Logging in

The Splice MCP server only serves authenticated clients (OAuth 2.1 with PKCE and dynamic client
registration). mate holds its own login, separate from Claude Code's:

```bash
bun run --cwd mate splice:login
```

The command connects, receives the 401, prints the authorization URL and opens it (macOS `open`;
paste it otherwise). It listens on `http://localhost:4546/callback` (`SPLICE_OAUTH_CALLBACK_PORT`)
for the redirect, checks the `state`, exchanges the code, reconnects and prints
`logged in, N tools`. Nothing it calls spends credits.

The client registration, tokens and pending PKCE verifier live in one file,
`.mate/splice-oauth.json` (`SPLICE_OAUTH_FILE`), written with mode 0600 and gitignored. At
startup `MATE_SPLICE=auto|mcp` reads it (`ports/mcp/oauth.ts`); the MCP SDK sends the access
token on every request and, on a 401, swaps the refresh token for a new pair and writes it back
to the file, so a login normally lasts as long as the refresh token does. When the file is
missing or the refresh is rejected, `auto` falls back to fixtures with the reason
``not logged in to Splice: run `bun run --cwd mate splice:login` `` in mate's startup log
(`GET /adapters` reports `splice: "stub"`);
`mcp` refuses to start. Delete the file to log out. `SPLICE_MCP_TOKEN`, when set, is sent as a
plain bearer token instead and the file is ignored.

## The three questions

### Can we pack many requests into one MCP call?

No. There is no batch tool and no tool takes a list of queries.

| Tool | Input | Output | Notes |
| --- | --- | --- | --- |
| `describe_a_sound` | one `query`, optional `bpm_min`/`bpm_max`/`type` | exactly 10 sounds | No pagination, no key filter, no offset. |
| `prompt_to_stack` | one `prompt`, `bpm_min`/`bpm_max` | one stack, 4 layers by default | One call yields one sample per instrument layer. |
| `create_stack` | one seed loop `asset_uuid` | one stack | Seed must be a loop. |
| `update_stack` | `stack_uuid` plus arrays | the whole stack | **The only array-in-one-call primitive.** `add_compatible_layers` with two entries added two layers in one round trip. Max 8 layers per stack. |
| `download_asset` | one `asset_uuid` | one presigned URL | Spends a credit. |
| `share_stack` | one `stack_uuid` | public URL | Free. |

What works instead: **concurrent calls over one connection.** Three `describe_a_sound` calls
issued in parallel all returned normally. `McpConnection.callTool` is already async per call,
so mate can fan out `Promise.all` over every slot's query variants. Rate limits are not
documented; the help center only limits downloads (100 per rolling 24h).

So "lots of queries per section" is fine, but each query costs a round trip and returns only
10 candidates. Budget on the order of 3 to 5 phrasings per slot, deduplicated by asset UUID.

### Can we preview, or must we buy everything?

Search and stack building are free. The MCP results carry **no audio**; Splice's own help
text says "open returned sample links in your browser to preview sounds".

Preview options, sanctioned first:

1. **Sample `Link` in the browser.** Every result has a `splice.com/sounds/sample/...` URL with
   a player. Zero cost, works today. The app can render it as a link per slot candidate.
2. **Stack permalink in the browser.** `prompt_to_stack` returns
   `https://splice.com/sounds/stacks/<uuid>`, which plays all layers together at the stack's
   BPM. This is the closest thing to "preview a section". The page is a client-rendered shell
   (5 KB, no audio URLs server-side); it returned 200 without cookies but whether playback
   needs a login is unverified. `share_stack` exists to make one public.
3. **Unofficial: scrape the sample page.** The sample page HTML (about 300 KB, no auth) embeds
   an `AssetFile` with `asset_file_type_slug: "preview_mp3"` pointing at a presigned S3 URL
   (`spliceproduction.s3...audio_samples/<hash>-scrambled/<hash>.mp3`). It downloaded
   unauthenticated: 118 KB, 128 kbps stereo mp3, which at that bitrate is about 7.4 s, the
   full length of the 7.4 s loop. Caveats: the URL expires after 6 h (`X-Amz-Expires=21600`),
   the `-scrambled` path name suggests Splice may alter previews and the audio was not
   listened to, the page's GraphQL endpoint (`surfaces-graphql.splice.com`) has introspection
   disabled so there is no documented API, and scraping sits under splice.com/terms. Treat as
   a nice-to-have behind a flag, not the plan.

Buying: `download_asset` costs **1 credit per new asset, re-downloads free, 100 per 24 h,
subscription required** (Sounds+, Creator, Creator+). There is no "download stack" call; a
stack is downloaded layer by layer, one credit each. Getting audio into Ableton requires the
file on disk, so every placed sample is a purchase. Dedupe by asset UUID before downloading:
a slot reused across sections, or the same loop chosen for verse and chorus, is one credit.

### Are the files usable in Ableton as-is?

Partly, and this is the biggest finding. A stack's header says `BPM: 120 | Key: f minor`,
but its layers are the catalog originals: 130, 118, 110 and 119 BPM in F# minor, G minor and
C major. The stack player stretches and shifts; the assets do not. `download_asset` takes
the catalog `asset_uuid`, so the download is presumably the original file (not called; it
spends credits).

Ableton side, from the loaded Ableton MCP tool list:

- `create_audio_clip(track_index, clip_index, path)` imports a file into an empty slot on an
  audio track. **Requires Live 12.0.5+** and an absolute local path, so mate must fetch the
  presigned URL and write the file itself.
- There is **no warp, transpose, or loop-point tool**. Tempo mismatch relies on Live's
  auto-warp guessing the loop's tempo. Key mismatch cannot be corrected through MCP at all.

Consequence: for pitched parts, pick samples that already match the song key. For drums and
percussion, key is irrelevant and only BPM matters.

## What the search actually does

- **Key in the query text is ignored.** "F minor" and "Fmin" both returned all keys. But
  pitched results carry a `Key: f# minor` field, so key is a client-side filter. `Sound` has
  no `key` today; the parser drops it.
- **Query wording matters a lot.** Short, instrument-first queries returned all drum loops
  ("acoustic drum groove, live sounds, rock, indie"). The layout's comma-joined style
  ("acoustic drum groove chorus, live sounds, rock, crash, energetic, 4 bars") returned ten
  guitar licks for a drum slot. Genre tags dominate: "organ chords loop, indie rock, warm"
  returned mostly indie-rock guitar songstarters.
- **Duration is usable.** `Duration` and `BPM` give bars: `bars = duration * bpm / 60 / beatsPerBar`.
  A 7.4 s loop at 130 BPM is 4 bars. Match against the slot's `loopBars` or a divisor of it.
- `bpm_min`/`bpm_max` are honored.

## Code findings

Status (2026-09-04): items 1–3 and 5 are done (`parseStack`, `Sound.key`, `songwriting/resolve.ts`, `songwriting/download.ts` behind `POST /songs/:id/download`). Item 4, Ableton audio tracks and clips, is the next step.

1. `parseStack` yields **zero layers** on the real response. `HEADING_RE` expects `### N. title`
   but the real format is `### Layer 1: Drums` with the filename on a `**Sample:**` line, and
   `**Stack UUID:**` / `**Permalink:**` trailers. UUID, BPM and permalink do parse.
   `stack_response.md` is the fixture to test against.
2. `Sound` needs `key: string | null` (parse `Key: <root> <mode>`; some entries are just `Key: a`).
3. `layoutSong` composes `slot.query` as brief + section brief + every tag + key name. That
   string is a poor Splice query (see above). Keep the slot's inputs structured and let the
   Splice resolver compose several short queries from them.
4. `AbletonPort` has no `createAudioTrack` or `createAudioClip`; plan tracks are already
   `kind: "audio"`. Both adapters (MCP and stub) need them.
5. `download_asset` is deliberately not a brain tool. The resolver should call it from an
   effect that runs only after the user approves a purchase list.

## Recommended design

**Search-per-slot as the primary path**, because it fits the existing `SampleSlot` grid and
lets mate control BPM, key and loop length. Per slot:

1. Compose 3 to 5 short queries from structured inputs: role or instrument first, then 1 to 3
   descriptors, then genre. No key, no bar count in the text. Pass `bpm_min`/`bpm_max` from
   `slot.bpm` and `type: "loop"`.
2. Run them concurrently, merge, dedupe by UUID.
3. Score client-side: BPM distance to target, key match (skip for drums/percussion), bar
   count against `loopBars`, tag overlap with the slot's role. Keep the top few as candidates.
4. Store candidates on the slot (`candidates: Sound[]`) with `resolved` still null. The app
   shows them with their Splice links for preview; the user or brain picks; the pick is
   downloaded once and `resolved.localPath` is set. Credits spent equals distinct UUIDs.

**`prompt_to_stack` per section as a secondary source.** One call returns a coherent 4-layer
set whose layer types (drums, bass, guitar, keys...) map onto `ROLES`, and its permalink is
the only whole-section preview. Use it to seed candidates for every part in a section at once,
but run the layers through the same key and BPM scoring, since the raw assets may not match.
`update_stack` with `swap_compatible_layers` and a `tag_filter` (always include `grooves` for
drums) is the cheap way to reroll one part.

Order of work: parser fix plus `key` field (fixtures exist) → Splice resolver in
`songwriting/` with a scripted test using the fixture adapter → `AbletonPort` audio track and
audio clip → download effect gated on approval → app: candidates with preview links.

## Side effects of this research

Stack `c03f989b-bbd5-494a-8b09-7c528224704e` ("indie rock verse at 120 bpm in F minor...")
was created in the connected Splice library and grown to 6 layers. It can be deleted. No
credits were spent.

Sources: Splice help center "Getting Started with the Splice MCP Server (Beta)"
(support.splice.com/en/articles/14442749), Splice blog "Splice Sounds in Claude via MCP",
live tool schemas from mcp.splice.com and the Ableton MCP server.
