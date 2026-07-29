# PROJECT KNOWLEDGE BASE

**Generated:** 2026-07-27

## OVERVIEW
Project: **@estebanforge/pi-antigravity-bridge**
Stack: **TypeScript / Node.js (ESNext / ES2022, ESM module)** targeting Node.js 22+, built as a streaming Gemini provider extension for `pi` (`@earendil-works/pi-coding-agent`) interfacing with Google Antigravity CLI (`agy`) and SQLite database polling.

## STRUCTURE
*   `src/`: Core implementation modules
    *   `ask-tool.ts`: Implementation of tool invocation bridging and prompt handling.
    *   `config.ts`: Configuration defaults, directory resolution, and environment parsing.
    *   `diff-render.ts`: Git diff rendering and edit tracking for tool output summaries.
    *   `discovery.ts`: `agy` conversation database discovery and PID mapping.
    *   `mcp-server.ts`: Internal bridge HTTP/MCP server lifecycle and capability gating.
    *   `models.ts`: Antigravity model catalog loading and background cache refreshing.
    *   `patcher.ts`: Auto-applies the pi local patch to enable the MCP tool bridge.
    *   `poller.ts`: SQLite polling logic for tracking streaming steps in `agy` databases.
    *   `protobuf.ts`: Binary protobuf parser for decoding internal `agy` step messages.
    *   `provider.ts`: Main `pi` custom provider registration and streaming event loop.
    *   `runner.ts`: Execution helper spawning `agy` subprocesses.
    *   `sessions.ts`: Persisted mapping of `pi` session IDs to `agy` conversation IDs and step watermarks.
*   `extensions/`: `pi` extension entry point (`index.ts`).
*   `scripts/`: Utility scripts for development (`run-agy.ts`, `decode-db.ts`, `smoke-in-pi.sh`, `test-provider.ts`, `test-extension.ts`).
*   `tests/`: Test suite using Node.js native test runner (`node:test` via `tsx`).

## COMMANDS
| Action | Command |
|--------|---------|
| Install| `npm install` |
| Test   | `npm test` |
| Build  | `npm run build` |
| Run    | `npm run run-agy` |
| Decode | `npm run decode-db` |
| Smoke  | `npm run smoke:pi` |

## CODING STANDARDS
*   **Language**: TypeScript (Strict mode enabled, `noEmit: true`, module resolution `bundler`).
*   **Module System**: Native ES Modules (`"type": "module"` in `package.json`, `.js` extension imports).
*   **Style**: Functional & utility-oriented structure, explicit typing, early returns, native error propagation.
*   **Testing**: Native Node.js test runner invoked via `tsx --test tests/*.test.ts`.

## WHERE TO LOOK
*   **Source**: [src/](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src) & [extensions/](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/extensions)
*   **Tests**: [tests/](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/tests)
*   **Docs**: [README.md](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/README.md) & [docs/](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/docs)

## NOTES
*   **Architecture**: Intercepts `pi` model requests under `antigravity/*`, spawns `agy` CLI processes, and streams real-time updates back to `pi` by decoding SQLite WAL steps using custom Protobuf parser (`protobuf.ts`).
*   **Context Continuity**: Implements a turn digest mechanism in `provider.ts` to bridge `pi` context compacting and turn history into `agy` sessions without double-counting assistant turns.
