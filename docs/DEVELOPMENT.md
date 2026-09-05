# Development & Debugging

How to build, test, and debug this extension outside pi.

## Build, test, typecheck

```bash
npm install
npm test          # unit tests via vitest (no agy spawn, no network)
npm run build     # tsc --noEmit type check
```

The integration scripts below spawn a real `agy` process and need a logged-in account. The unit tests (`npm test`) need neither.

## Standalone scripts

These exercise the pipeline without pi. Useful for isolating where a bug lives (driver? provider? pi loader?).

```bash
# Drive the provider's streamSimple directly (no pi TUI) and assert the
# full event lifecycle: start -> text_start -> text_delta -> text_end ->
# done. The closest thing to a pi turn without pi.
npx tsx scripts/test-provider.ts

# Load the extension through a mock ExtensionAPI and assert registerProvider
# + registerCommand (/agy) fire with the right shape. No agy spawn.
npx tsx scripts/test-extension.ts

# Load the extension through pi's REAL loader and confirm the antigravity/*
# models register. This is the in-pi smoke test.
npm run smoke:pi

# Live smoke for the stream-json engine. OPT-IN: spends a little Antigravity
# quota. Proves the persistent process: init binds a conversation, text deltas
# arrive, the result settles, and a second turn reuses the process.
AGY_LIVE=1 node --experimental-strip-types scripts/smoke-stream-json.mjs

# Live smoke for the ACP engine through OUR driver stack. OPT-IN: spends a
# little quota. Needs AGY_ACP_BIN (or acp on PATH) and a one-time
# /agy auth-manual credential setup.
AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
  npx tsx scripts/smoke-acp.mjs

# Live smoke for the Gate F bridge e2e: the real ACP server lists the bridge
# catalog and completes a tool call through the registered mcpServers entry.
AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
  npx tsx scripts/smoke-acp-bridge.mjs

# Live smoke for image prompts on the ACP engine: builds a 64x64 two-tone PNG
# in-process and asserts the model identifies both halves through the full
# driver stack.
AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
  npx tsx scripts/smoke-acp-image.mjs

# Live probe: thought-chunk sparsity, tool_call content[]/rawInput shapes,
# and the /plan command flow, captured to probe-logs/ (local only).
AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
  npx tsx scripts/probe-acp-phase2.mjs

# Live parity run: the SAME scenario set (streaming, continuity, bridge
# round-trip, effort switch, serialization, abort+recover, usage) through
# BOTH engines. Needs the agy CLI AND the ACP binary. Spends ~13 flash-low
# turns; prints a per-scenario matrix and exits non-zero on any mismatch.
AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par \
  npx tsx scripts/parity-live.mjs
```

## Debugging a hang or "stuck" turn

Most "stuck" reports trace to one of:

1. **agy blocked on a permission prompt.** `accept-edits` auto-approves file edits but NOT shell commands. Any `run_command` prompts `y/n`, which hangs forever in non-interactive mode. The provider passes `--dangerously-skip-permissions` by default to avoid this. If you turned it off (`/agy permissions off`), that is why. See the README Permissions section.
2. **agy never started.** Check `AGY_BIN` is on PATH (or set explicitly). The spawner swallows spawn ENOENT into the result's stderr, surfaced by the provider as an error event.
3. **Conversation id never bound.** On `stream-json` the `init` event carries the id, so a missing binding means the turn never produced a result event. `/agy doctor` prints the last lifecycle events.
4. **Print-mode environmental hang.** `pi -p` can hang with zero output in some containers (upstream [google-antigravity/antigravity-cli#318](https://github.com/google-antigravity/antigravity-cli/issues/318)). It affects built-in providers too, not this extension. Validate the turn with `scripts/test-provider.ts` instead.

## Regression tests worth knowing

- `tests/stream-roundtrip.test.ts` - the stream-json engine pieces: NDJSON parser, native re-exec mapping, and the no-patch toolUse round-trip store.
- `tests/provider-streaming.test.ts` - drives streamSimple with an injected fake driver (no agy) and asserts how pi's reasoning level maps onto the agy `--effort` tier (forward, clamp, omit).
- `tests/provider-digest.test.ts` - the G1 context digest builder: injects pi-side context without replaying agy's own history.
- `tests/patch-cleanup.test.ts` - legacy-patch detection and restore, real fs via tmpdirs, no mocks.
- `tests/mcp-server.test.ts` - the MCP tool bridge end-to-end against a real (port 0) server: capability gate, per-pid config lifecycle, shared-secret token gate, 1 MB body cap, protocol-version clamp. The provider owns the tool catalog and the round-trip; the server only ferries list/call.
- `tests/acp-jsonrpc.test.ts` - the JSON-RPC stdio session: id correlation, typed error results, server-to-client requests, notifications, line framing (partial frames buffered across chunk boundaries, garbage lines counted not fatal).
- `tests/acp-events.test.ts` - ACP session/update mapping onto pi activities (text, thought, tool cards) and the session/load replay suppression.
- `tests/acp-driver.test.ts` - the ACP driver over the fake server (`tests/helpers/fake-acp-server.mjs`, scenario-selected): happy flow, load-replay, permission auto-answer, Gate D abort (cancel probe, teardown, `cancelSupported` memory), the stale-exit race (a killed connection's late exit must not fail its replacement - `ACP_FAKE_SLOW_DEATH_MS`), auth errors, park/kickIdle timer pause with remaining budget.
- `tests/acp-config.test.ts` - engine selection narrowing (`AGY_ENGINE`/`config.engine`), acp block parsing.

## Module map

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and the engine internals (stream-json events, no-patch round-trip).
