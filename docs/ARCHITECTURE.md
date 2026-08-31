# Architecture

How the provider works internally. For build/test/debug workflow see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Engines

The provider runs one of two turn engines (`config.engine`, default `stream-json`):

- **`stream-json` (default):** one long-lived `agy --input-format stream-json --output-format stream-json` process per provider. Turns are fed over stdin; agy emits NDJSON events on stdout; the driver parses them and streams text into pi token by token. Conversation binding comes from the `init` event, tool steps arrive as typed events (no protobuf decoding), and token usage is live.
- **`legacy-sqlite` (fallback):** the pre-1.3.0 engine - spawn `agy -p`, poll its SQLite conversation DB on a 250 ms interval, decode the protobuf step payloads. Kept as a fallback and scheduled for removal once `stream-json` has burned in (`AGY_ENGINE=legacy-sqlite` selects it).

Shared by both engines: session binding (`sessions.json`), runtime config, the `AskAntigravity` tool, the MCP tool bridge surface, and the G1 context digest (off by default - see below).

## Module map

```
extensions/index.ts   pi extension entry: provider registration, model discovery, /agy command, lifecycle notices
src/provider.ts       streamSimple: pi Context -> agy turn -> pi event stream; owns the G9 round-trip store and the G1 digest
src/driver.ts         stream-json driver: persistent agy process, turn serialization, conversation binding, idle/abort timers
src/stream-events.ts  agy NDJSON event parser (init / step_update / result) + usage mapping onto pi's Usage
src/native-tools.ts   maps agy read-only tool steps to real pi builtins (read/ls/grep/find) for native re-execution
src/skills.ts         activate_skill bridge: exposes the pi Agent Skills catalog to agy, answered by the bridge directly
src/patch-cleanup.ts  detects a leftover invokeTool patch from pre-1.3.0 installs; /agy patch-cleanup restores the backup
src/runner.ts         legacy engine: spawn agy -p, concurrent poll loop, abort/timeout, emit events
src/poller.ts         legacy engine: read-only node:sqlite handle over one conversation DB
src/protobuf.ts       legacy engine: hand-rolled varint walker + extractors (field 20.1 = text)
src/discovery.ts      legacy engine: snapshot/diff + pid fd-scan to bind the conversation id agy -p never prints
src/models.ts         agy models -> pi Model projection (full catalog, per-model effort)
src/sessions.ts       atomic JSON store: pi session -> agy conversation + watermark
src/config.ts         persisted runtime config (engine, bridgeTools, digest, mode, permissions, model/thinking defaults)
src/ask-tool.ts       the AskAntigravity one-shot delegation tool (model/thinking defaults)
src/mcp-server.ts     MCP tool bridge server: ferries tools/list + tools/call; calls park in the provider round-trip
src/diff-render.ts    render agy's file edits as git diffs in pi's thinking stream
```

No generated protobuf code, no native SQLite dependency (`node:sqlite` covers the legacy engine's reads).

## Stream-json engine (default)

### Process and events

The driver spawns `agy --input-format stream-json --output-format stream-json` once per provider and keeps it alive across turns (`/agy doctor` shows the reuse counter). A turn writes the prompt to stdin and reads NDJSON events until the terminal `result`:

| event | meaning |
| --- | --- |
| `init` | conversation binding (`conversation_id`); the driver remembers it and resumes later turns via `--conversation <id>` |
| `step_update` | `user_input` / `checkpoint` / `agent_response` / `tool` steps; agent text arrives as `text_delta` on live agy (1.1.13+), with `usage` attached |
| `result` | terminal; live builds report status `SUCCESS` (older builds `OK` - both accepted) |

Unknown event kinds parse as `{kind:"unknown"}` so a future agy release degrades instead of crashing the reader loop. Shapes were captured from live output and cross-checked against tianzuo/pi-antigravity `lib/events.ts` (MIT).

Usage maps onto pi's `Usage` (input/output/thinking/cache-read tokens); cost stays zero because agy runs on subscription quota.

### No-patch tool round-trip (G9)

The MCP bridge server executes no tools itself. A `tools/call` parks in the provider's round-trip store; the provider ends the current pi assistant message with a `toolUse` stop reason for the real pi tool; pi executes it in its own loop (native cards, permissions, hooks); the `toolResult` completes the parked MCP response on the next stream call. No pi patch, no privileged API.

Display follows the same split: agy read-only steps (`view_file`, `list_dir`, `grep_search`, `find_by_name`) re-run as real pi builtins via `native-tools.ts`, so their cards render with pi's own renderers. Mutating and agy-specialty steps replay through a display-only `antigravity` wrapper tool - recorded output only, nothing re-executes. The skills bridge exposes one `activate_skill` tool whose enum is the pi Agent Skills catalog; the bridge answers it directly, no round-trip.

### Context digest (G1)

By default the prompt agy receives is only the latest user message: agy keeps its own history. When `config.digest` is on (`AGY_DIGEST`, `/agy digest on`), the provider prepends a DELTA digest of pi-side context agy was not spawned for - compaction summaries, other-provider turns, pi-tool results. Off by default because the digest changes every turn and defeats agy's server-side prompt cache (~25-30k tokens re-billed per turn). Enable it for mixed-provider sessions where agy must see pi-side context; pure antigravity sessions gain nothing, and bridge round-trips deliver tool results through the bridge, not the digest.

## Legacy-sqlite engine internals

The sections below describe the `legacy-sqlite` fallback only (`AGY_ENGINE=legacy-sqlite`). The stream-json engine shares none of this code path.

### The decode pipeline

agy writes each step to a SQLite row with a protobuf blob in `step_payload`. The text we want lives at field 20, submessage field 1. Tool calls live at field 5, submessage field 4, with the name at field 2 or 9 and the raw input JSON at field 3. These field numbers are reverse-engineered facts (cross-checked against the shindgew/agy-acp and shubzkothekar/antigravity-acp decoders, then verified against real databases on agy 1.1.7). They are load-bearing. Unknown fields are skipped per protobuf wire rules, so a future agy that adds fields will not break decoding.

### Step types

| step_type | meaning |
| --- | --- |
| 15 | agent text (payload field 20 -> field 1) |
| 14 | thinking |
| 23 | title update (payload field 30 -> field 4) |
| 5, 7, 8, 9, 17, 21, 33, 101, 132, 138 | tool run (payload field 5 -> field 4 -> name@2/9, input@3) |

Status 3 = complete; anything else = in-flight.

### Polling

The runner spawns `agy -p`, then polls its conversation DB on a 250ms interval concurrent with the running process (this is what makes the provider actually stream, not replay at exit). Each tick issues a single `PRAGMA data_version` check; while agy is thinking and has not committed, that check is false and no row SELECT runs at all (neither the new-row read nor the in-place re-read of the step agy is currently extending). Only when a commit lands do both reads fire in one pass. Three trailing polls at 100ms after agy exits catch the last flush; on abort these are skipped so cancellation is prompt.

### Conversation id discovery

agy `-p` does not print the conversation id. On a fresh run the runner snapshots the `*.db` stems in the conversations dir before spawn, then diffs after. Exactly one new file = ours; zero new = refuse to bind (surfaced as an error rather than a guess).

When **more than one** new file appears (a concurrent agy or subagent started in parallel), the runner passes its spawned pid to `newConversationId`, which scans the process tree's open file descriptors (`/proc/<pid>/fd` on Linux) to find the single candidate `.db` our own agy is writing to. This is the authoritative disambiguator: mtime cannot separate two *active* concurrent runs, and the user-message payload (`step_type 98`) is undocumented and deeply nested, so content-matching would risk a silent misbind. When the pid is unavailable, the platform is not Linux, the process has already exited (the AskAntigravity tool binds post-exit), or the scan itself is ambiguous, discovery fails safe to null rather than guessing.
