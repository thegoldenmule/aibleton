# aibleton

An AI bandmate for practicing musicians, drummers first.

Two pieces run on your machine:

- **`mate`** — a Bun/TypeScript service. It runs the intelligence loop (a state machine fed by a mailbox), exposes an HTTP API, talks to Ableton Live and Splice over MCP, and calls the Anthropic API for decisions.
- **`app`** — a Next.js UI that reads mate's state and renders a stripped-down, non-realtime DAW view: tracks and what sits on them.

Everything is TypeScript. `mate` runs on Bun.

## Layout

```
aibleton/
  packages/protocol/   shared zod schemas + types: the mate <-> app contract
  mate/                Bun service
    src/core/          commands, mailbox, clock, event bus, state store
    src/intelligence/  pure state machine, effect runner, agent loop, brains (Anthropic + scripted), tool defs
    src/ports/         Ableton and Splice ports, each with an MCP adapter and an in-memory stub
    src/inputs/        command producers: startup tick, MIDI placeholder
    src/api/           Hono routes on Bun.serve
    test/              bun test suites (all offline)
  app/                 Next.js DAW view
  .mcp.json            Ableton MCP server config used by Claude Code (uvx ableton-mcp)
```

## How it works

Every input (API call, timer, future MIDI controller, Ableton change) becomes a **command** in a mailbox. The **agent loop** pops one command at a time and hands it to a pure reducer, `step(state, command) -> { state, effects }`. Effects (refresh the Ableton snapshot, call the brain, apply actions, emit an event, enqueue a follow-up) run asynchronously and their completions re-enter the mailbox as commands. Phases: `idle -> observing -> deciding -> acting -> idle`, plus `paused` and `error`.

The **brain** turns a session snapshot plus the drummer's request into a `Decision`: a message and a list of `Action`s. Only the loop applies actions to Ableton; the brain never mutates anything directly. The Anthropic brain runs a manual tool-use loop; the scripted brain returns canned decisions and is what tests and the no-credentials demo use.

**Ports** hide MCP. `AbletonPort` and `SplicePort` each have a real MCP adapter and a stub. Each port's mode is `auto | mcp | stub`; `auto` tries MCP at startup and falls back to the stub if that fails, so the whole stack runs with no Ableton, no Splice, and no API key.

## Running

Requirements: [Bun](https://bun.sh) 1.3+. For live Ableton: Ableton Live 12 with the [ableton-mcp](https://github.com/ahujasid/ableton-mcp) remote script installed and `uvx` on your PATH. For the Anthropic brain: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile.

```bash
bun install
cp .env.example .env    # optional; every variable has a default
```

### All-stub run (no Ableton, no Splice, no API key)

```bash
MATE_ABLETON=stub MATE_SPLICE=stub MATE_BRAIN=scripted bun run dev:mate
```

Then in another terminal:

```bash
curl localhost:4545/health
curl localhost:4545/state
curl -N localhost:4545/events &
curl -X POST localhost:4545/commands \
  -H 'content-type: application/json' \
  -d '{"command":{"type":"userRequest","text":"set the tempo to 120"}}'
```

You should see the phase move `observing -> deciding -> acting -> idle` on the event stream.

### UI

```bash
bun run dev:app     # http://localhost:3000, expects mate on http://localhost:4545
```

Set `NEXT_PUBLIC_MATE_URL` in `app/.env.local` if mate runs elsewhere.

### Live Ableton

Open a Live set, make sure the ableton-mcp remote script is enabled, then:

```bash
MATE_ABLETON=auto bun run dev:mate
curl localhost:4545/adapters   # -> {"ableton":"mcp", ...}
```

`/state` now mirrors the open set. If `uvx` or the remote script is missing, the log shows the fallback reason and `/adapters` reports `stub`.

### Mode matrix

| Variable | Values | `auto` behaviour |
|---|---|---|
| `MATE_ABLETON` | `auto` `mcp` `stub` | spawn `uvx ableton-mcp` over stdio; stub on failure |
| `MATE_SPLICE` | `auto` `mcp` `stub` | connect to `https://mcp.splice.com/mcp` (optional `SPLICE_MCP_TOKEN`); stub on failure |
| `MATE_BRAIN` | `auto` `anthropic` `scripted` | Anthropic if credentials resolve, else scripted |

Other variables: `MATE_PORT` (4545), `MATE_CORS_ORIGIN` (http://localhost:3000), `MATE_TICK_MS` (5000), `MATE_MODEL` (claude-opus-5), `MATE_MAX_BRAIN_RETRIES` (3), `MATE_LOG_LEVEL` (info).

## API

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ ok, uptimeMs }` |
| GET | `/state` | full `StateResponse`: session snapshot, phase, goal, adapters, recent commands, last message |
| GET | `/adapters` | which adapter is live per port and brain |
| POST | `/commands` | `{ command: ExternalCommand }` -> `{ id, queued }`; accepts `userRequest`, `goalSet`, `abletonChanged`, `midiNote`, `pause`, `resume`, `cancel` |
| GET | `/commands/recent` | last commands seen by the mailbox, newest first |
| GET | `/events` | server-sent events; first event is `snapshot`, then one event per bus event (`state.changed`, `phase.changed`, `command.received`, `message`, `action.applied`, ...) |

Schemas live in `packages/protocol`.

## Testing

```bash
bun test                 # from root, runs mate's suites
bun run typecheck        # protocol, mate, app
```

Tests are fully offline: a scripted brain, in-memory ports, and a manual clock.

## Out of scope for the skeleton

Real MIDI input (placeholder interface only), realtime playback or playhead, Splice asset downloads (spend credits) and Splice OAuth wiring for mate, persistence across restarts, and any actual drum-pattern generation logic.

## Known risks

- Splice MCP auth from a non-Claude client is unresolved; the Splice port is stub-first with a bearer-token hook.
- Splice returns markdown rather than JSON; the parser is fixture-tested but will break if the format changes.
- The Ableton MCP server records prompts, notes and clip names to an open training dataset by default. This project keeps contributing and forwards the originating request text in each tool's `user_prompt` field.
