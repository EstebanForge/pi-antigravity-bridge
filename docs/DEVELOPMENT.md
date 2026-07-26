# Development & Debugging

How to build, test, and debug this extension outside pi.

## Build, test, typecheck

```bash
npm install
npm test          # unit tests (protobuf decoder, narration, runner streaming/abort)
npm run build     # tsc --noEmit type check
```

The integration scripts below spawn a real `agy` process and need a logged-in account. The unit tests (`npm test`) need neither.

## Standalone scripts

These exercise the pipeline without pi. Useful for isolating where a bug lives (decoder? poller? provider? pi loader?).

```bash
# Decode any conversation DB and print agent text + tool calls.
# Accepts a UUID (resolved against ~/.gemini/antigravity-cli/conversations/)
# or an absolute path. Fastest way to check the protobuf decoder against
# real data. No agy spawn, no network.
npm run decode-db -- <uuid-or-path>

# Spawn agy and stream decoded events to stdout with timestamps. Proves the
# concurrent poll loop actually streams (events arrive during the run, not
# only at exit). Use this to reproduce a hang or a missing-event bug.
npm run run-agy -- "Say hello"
npm run run-agy -- --model "Gemini 3.6 Flash (Medium)" --mode plan "Review src/protobuf.ts"
npm run run-agy -- --conversation <uuid> "follow up"   # resume a turn

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
```

## Debugging a hang or "stuck" turn

Most "stuck" reports trace to one of:

1. **agy blocked on a permission prompt.** `accept-edits` auto-approves file edits but NOT shell commands. Any `run_command` prompts `y/n`, which hangs forever in non-interactive `-p` mode. The provider passes `--dangerously-skip-permissions` by default to avoid this. If you turned it off (`/agy permissions off`), that is why. See the README Permissions section.
2. **agy never started.** Check `AGY_BIN` is on PATH (or set explicitly). The runner swallows spawn ENOENT into the result's stderr, surfaced by the provider as an error event.
3. **Conversation id never bound.** The snapshot/diff discovery refuses to bind if more than one new `.db` appears (ambiguous). `scripts/decode-db.ts` against the suspected DB confirms agy wrote steps.
4. **Print-mode environmental hang.** `pi -p` can hang with zero output in some containers (upstream [google-antigravity/antigravity-cli#318](https://github.com/google-antigravity/antigravity-cli/issues/318)). It affects built-in providers too, not this extension. Validate the turn with `scripts/test-provider.ts` instead.

## Regression tests worth knowing

- `tests/protobuf.test.ts` - pure decoder math (varint, field walking, nested submessages).
- `tests/narration.test.ts` - the narration-prefix filter.
- `tests/runner-streaming.test.ts` - a fake agy writes rows on a delay; asserts events arrive DURING the run (not all at exit) and that abort returns promptly. This is the test that guards the "provider did not actually stream" class of bug.

## Module map

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the module map and the decode-pipeline / polling internals.
