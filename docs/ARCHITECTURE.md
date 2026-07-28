# Architecture

How the provider works internally. For build/test/debug workflow see [DEVELOPMENT.md](./DEVELOPMENT.md).

## Module map

```
extensions/index.ts   registerProvider + model discovery + /agy command (entry)
src/provider.ts       streamSimple: pi Context -> agy turn -> pi event stream
src/runner.ts         spawn agy -p, concurrent poll loop, abort/timeout, emit events
src/poller.ts         read-only node:sqlite handle over one conversation DB
src/protobuf.ts       hand-rolled varint walker + extractors (field 20.1 = text)
src/discovery.ts      snapshot/diff to bind the conversation id agy never prints
src/models.ts         agy models -> pi Model projection
src/sessions.ts       atomic JSON store: pi session -> agy conversation + last step
src/config.ts         persisted runtime config (mode, narration, permissions, model/thinking defaults)
src/narration.ts      drop agy's "I will ..." planning chunks
src/ask-tool.ts       the AskAntigravity one-shot delegation tool (model/thinking defaults)
src/mcp-server.ts     MCP tool bridge: exposes pi's tools to agy over Streamable HTTP
src/diff-render.ts    render agy's file edits as git diffs in pi's thinking stream
```

No generated protobuf code, no native SQLite dependency.

## The decode pipeline

agy writes each step to a SQLite row with a protobuf blob in `step_payload`. The text we want lives at field 20, submessage field 1. Tool calls live at field 5, submessage field 4, with the name at field 2 or 9 and the raw input JSON at field 3. These field numbers are reverse-engineered facts (cross-checked against the shindgew/agy-acp and shubzkothekar/antigravity-acp decoders, then verified against real databases on agy 1.1.7). They are load-bearing. Unknown fields are skipped per protobuf wire rules, so a future agy that adds fields will not break decoding.

### Step types

| step_type | meaning |
| --- | --- |
| 15 | agent text (payload field 20 -> field 1) |
| 14 | thinking |
| 23 | title update (payload field 30 -> field 4) |
| 5, 7, 8, 9, 17, 21, 33, 101, 132, 138 | tool run (payload field 5 -> field 4 -> name@2/9, input@3) |

Status 3 = complete; anything else = in-flight.

## Polling

The runner spawns `agy -p`, then polls its conversation DB on a 250ms interval concurrent with the running process (this is what makes the provider actually stream, not replay at exit). Each tick issues a single `PRAGMA data_version` check; while agy is thinking and has not committed, that check is false and no row SELECT runs at all (neither the new-row read nor the in-place re-read of the step agy is currently extending). Only when a commit lands do both reads fire in one pass. Three trailing polls at 100ms after agy exits catch the last flush; on abort these are skipped so cancellation is prompt.

## Conversation id discovery

agy `-p` does not print the conversation id. On a fresh run the runner snapshots the `*.db` stems in the conversations dir before spawn, then diffs after. Exactly one new file = ours; zero new = refuse to bind (surfaced as an error rather than a guess).

When **more than one** new file appears (a concurrent agy or subagent started in parallel), the runner passes its spawned pid to `newConversationId`, which scans the process tree's open file descriptors (`/proc/<pid>/fd` on Linux) to find the single candidate `.db` our own agy is writing to. This is the authoritative disambiguator: mtime cannot separate two *active* concurrent runs, and the user-message payload (`step_type 98`) is undocumented and deeply nested, so content-matching would risk a silent misbind. When the pid is unavailable, the platform is not Linux, the process has already exited (the AskAntigravity tool binds post-exit), or the scan itself is ambiguous, discovery fails safe to null rather than guessing.
