# PROJECT KNOWLEDGE BASE

**Generated:** 2026-08-31

## OVERVIEW
Project: **@estebanforge/pi-antigravity-bridge**
Stack: **TypeScript / Node.js (ESNext / ES2022, ESM module)** targeting Node.js 22+, built as a streaming Gemini provider extension for `pi` (`@earendil-works/pi-coding-agent`) interfacing with the Google Antigravity CLI (`agy`) over its stream-json protocol (persistent process), with a legacy SQLite-polling fallback engine.

## STRUCTURE
*   `src/`: Core implementation modules
    *   `provider.ts`: Main `pi` custom provider: streaming event loop, G9 no-patch round-trip store, G1 context digest (off by default).
    *   `driver.ts`: Stream-json driver: one persistent `agy --input-format stream-json --output-format stream-json` process, turn serialization, conversation binding, idle/abort timers.
    *   `stream-events.ts`: agy NDJSON event parser (init / step_update / result) and usage mapping onto pi's Usage.
    *   `native-tools.ts`: Maps agy read-only tool steps onto real pi builtins (`read`/`ls`/`grep`/`find`) for native re-execution.
    *   `skills.ts`: `activate_skill` bridge exposing the pi Agent Skills catalog to agy, answered by the bridge directly.
    *   `patch-cleanup.ts`: Detects a leftover invokeTool patch from pre-1.3.0 installs; `/agy patch-cleanup` restores the original files from backup.
    *   `runner.ts`, `poller.ts`, `protobuf.ts`, `discovery.ts`: Legacy-sqlite engine (spawn `agy -p`, SQLite polling, protobuf decode, conversation discovery). Fallback only; scheduled for removal.
    *   `ask-tool.ts`: The `AskAntigravity` one-shot delegation tool (model/thinking defaults).
    *   `config.ts`: Configuration defaults (engine, bridgeTools, digest), directory resolution, and environment parsing.
    *   `diff-render.ts`: Git diff rendering and edit tracking for tool output summaries.
    *   `mcp-server.ts`: Internal bridge HTTP/MCP server lifecycle and capability gating; `tools/call` parks into the provider round-trip.
    *   `models.ts`: Antigravity model catalog loading and background cache refreshing.
    *   `sessions.ts`: Persisted mapping of `pi` session IDs to `agy` conversation IDs and step watermarks.
*   `extensions/`: `pi` extension entry point (`index.ts`): provider registration, `/agy` command, bridge lifecycle notices.
*   `scripts/`: Utility scripts for development (`run-agy.ts`, `decode-db.ts`, `smoke-in-pi.sh`, `smoke-stream-json.mjs`, `test-provider.ts`, `test-extension.ts`).
*   `tests/`: Test suite run by Vitest.

## COMMANDS
| Action | Command |
|--------|---------|
| Install| `npm install` |
| Test   | `npm test` |
| Build  | `npm run build` |
| Run    | `npm run run-agy` |
| Decode | `npm run decode-db` |
| Smoke  | `npm run smoke:pi` |
| Live stream-json smoke | `AGY_LIVE=1 node --experimental-strip-types scripts/smoke-stream-json.mjs` (spends quota) |

## CODING STANDARDS
*   **Language**: TypeScript (Strict mode enabled, `noEmit: true`, module resolution `bundler`).
*   **Module System**: Native ES Modules (`"type": "module"` in `package.json`, `.js` extension imports).
*   **Style**: Functional & utility-oriented structure, explicit typing, early returns, native error propagation.
*   **Testing**: Vitest (`vitest run`).

## WHERE TO LOOK
*   **Source**: [src/](src) & [extensions/](extensions)
*   **Tests**: [tests/](tests)
*   **Docs**: [README.md](README.md) & [docs/](docs)

## NOTES
*   **Architecture**: Intercepts `pi` model requests under `antigravity/*` and drives a persistent `agy` process over its stream-json protocol. The MCP tool bridge runs with no pi patch: bridge calls park in the provider's round-trip store and re-enter pi as real `toolUse` turns (native cards, permissions, hooks). `AGY_ENGINE=legacy-sqlite` keeps the pre-1.3.0 spawn-and-poll engine as a fallback, scheduled for removal once stream-json has burned in.
*   **Context Continuity**: The G1 context digest (compaction summaries, other-provider turns) is opt-in (`config.digest` / `AGY_DIGEST` / `/agy digest on`, default off): it changes every turn and defeats agy's server-side prompt cache.
