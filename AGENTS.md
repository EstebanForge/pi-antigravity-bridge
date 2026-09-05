Project: **@estebanforge/pi-antigravity-bridge**
Stack: **TypeScript / Node.js (ESNext / ES2022, ESM module)** targeting Node.js 22+, built as a streaming Gemini provider extension for `pi` (`@earendil-works/pi-coding-agent`) with TWO turn engines behind one contract: the default **stream-json engine** (persistent `agy` CLI process) and the opt-in **ACP engine** (`src/acp/*`, Google's official `agy_acp_server.par` over JSON-RPC stdio, disabled by default).

## STRUCTURE
*   `src/`: Core implementation modules
    *   `provider.ts`: Main `pi` custom provider: streaming event loop, G9 no-patch round-trip store, G1 context digest (off by default; inline on stream-json, `embeddedContext` resource block on ACP). Consumes the `TurnDriver` interface only; engine selection is per-call from config.
    *   `driver-types.ts`: Engine-agnostic `TurnDriver` contract (request/handle/snapshot types). Everything above the drivers depends on this only.
    *   `driver.ts`: Stream-json driver (DEFAULT engine): one persistent `agy --input-format stream-json --output-format stream-json` process, turn serialization, recycle on profile drift, conversation binding, idle/abort timers.
    *   `acp/jsonrpc.ts`: NDJSON JSON-RPC 2.0 framing: correlation map, typed error results, server-to-client requests, line buffering (partial stdio frames).
    *   `acp/connection.ts`: ACP server process + protocol: initialize, session/new+load (bridge `mcpServers` on both), prompt with image/resource blocks, `set_config_option`, cancel probing, `auto` permission answering.
    *   `acp/events.ts`: `session/update` → DriverActivity mapping (pure). Tool frames: args unwrap `arguments` envelope, name from `_meta.mcp.tool`, `content[]` text/diff extraction. Load-replay suppression lives in the connection.
    *   `acp/driver.ts`: `AcpDriver`: serialized turns, remaining-budget timer pause on parks, Gate D abort (cancel probe → -32601 → teardown+kill+reload), connection-scoped exit handling, engine-scoped snapshots (reconnects, agentInfo, cancelSupported).
    *   `native-tools.ts`: Stream-json only: maps agy read-only tool steps onto real pi builtins (`read`/`ls`/`grep`/`find`) for native re-execution. Not used on ACP turns (Gate C).
    *   `skills.ts`: `activate_skill` bridge exposing the pi Agent Skills catalog to agy, answered by the bridge directly.
    *   `patch-cleanup.ts`: Detects a leftover invokeTool patch from pre-1.3.0 installs; `/agy patch-cleanup` restores the original files from backup.
    *   `discovery.ts`: Conversation-id binding for the AskAntigravity one-shot tool (snapshot/diff + pid fd-scan; `agy -p` never prints the id). Scheduled for deletion in phase 4.
    *   `ask-tool.ts`: The `AskAntigravity` one-shot delegation tool (model/thinking defaults). Stays on `agy -p` until phase 4; `mode: "plan"` keeps that path permanently (ACP has no review-only mode).
    *   `config.ts`: Configuration defaults (engine, acp.bin, bridgeTools, askTool, digest, systemPrompt), directory resolution, and environment parsing.
    *   `diff-render.ts`: `stream-json` only: git-sourced edit diffs into pi's thinking stream. `formatInlineDiff` (no git) renders ACP's native diffs. ACP edits arrive as diffs in `tool_call content[]`.
    *   `mcp-server.ts`: Internal bridge HTTP/MCP server lifecycle and capability gating; `tools/call` parks into the provider round-trip. Shared-secret `x-bridge-token`; handle exposes `token` for ACP `mcpServers` headers.
    *   `models.ts`: Antigravity model catalog loading and background cache refreshing; `toPiModel(entry, input)` advertises text+image input only when the engine is `acp`.
    *   `sessions.ts`: Persisted mapping of `pi` session IDs to agy conversation/session IDs. Engine-scoped KEYS (`sid:<x>` streaming, `sid:<x>@acp`) so engine switches never cross conversations.
*   `extensions/`: `pi` extension entry point (`index.ts`): provider registration, dual-driver wiring, bridge `mcpServers` registration with the token header, `/agy` command (engine, auth, auth-manual, doctor), bridge lifecycle notices.
*   `scripts/`: Utility scripts for development (`smoke-in-pi.sh`, `smoke-stream-json.mjs`, `smoke-acp.mjs`, `smoke-acp-bridge.mjs`, `smoke-acp-image.mjs`, `parity-live.mjs`, `probe-acp-phase2.mjs`, `test-provider.ts`, `test-extension.ts`).
*   `tests/`: Test suite run by Vitest (168 tests). ACP suites: `acp-jsonrpc` (framing), `acp-events` (mapping incl. probe-frame regressions), `acp-driver` (fake server in `tests/helpers/fake-acp-server.mjs`), `acp-config` (engine narrowing).

## COMMANDS
| Action | Command |
|--------|---------|
| Install | `npm install` |
| Test | `npm test` |
| Build (typecheck) | `npm run build` |
| In-pi smoke | `npm run smoke:pi` |
| Live stream-json smoke | `AGY_LIVE=1 node --experimental-strip-types scripts/smoke-stream-json.mjs` (spends quota) |
| Live ACP smokes (bridge e2e, image) | `AGY_ACP_LIVE=1 AGY_ACP_BIN=~/.local/opt/agy-acp/current/agy_acp_server.par npx tsx scripts/smoke-acp-bridge.mjs` / `smoke-acp-image.mjs` |
| Live parity (both engines) | `AGY_ACP_LIVE=1 ... npx tsx scripts/parity-live.mjs` (7 scenarios × 2 engines) |

## CODING STANDARDS
*   **Language**: TypeScript (Strict mode enabled, `noEmit: true`, module resolution `bundler`).
*   **Module System**: Native ES Modules (`"type": "module"` in `package.json`, `.js` extension imports).
*   **Style**: Functional & utility-oriented structure, explicit typing, early returns, native error propagation.
*   **Testing**: Vitest (`vitest run`). ACP shapes are pinned against captures in `probe-logs/` (gitignored, local only).

## WHERE TO LOOK
*   **Source**: [src/](src) & [extensions/](extensions)
*   **Tests**: [tests/](tests)
*   **Docs**: [README.md](README.md) & [docs/](docs)
*   **ACP plan + protocol truth**: [docs/ACP-ADOPTION-PLAN.md](docs/ACP-ADOPTION-PLAN.md) & [docs/ACP-PROTOCOL-REFERENCE.md](docs/ACP-PROTOCOL-REFERENCE.md)

## NOTES
*   **Two engines**: default `stream-json` (persistent `agy` CLI process); `acp` opt-in via `config.engine` / `AGY_ENGINE` / `/agy engine acp` (requires restart). Both implement `TurnDriver`; the provider layer (G1 digest, G10 system prompt, G9 round-trips) is shared.
*   **ACP limitations (RC01)**: no usage fields (Gate B — stream-json stays default until upstream ships them), no `session/cancel` (Gate D teardown+reload abort), no review-only mode (modes are permission modes only; plan delegations keep `agy -p --mode plan`).
*   **ACP-only features**: pi image attachments ride as typed content blocks; the G1 digest ships as an `embeddedContext` resource block; edit diffs from `tool_call content[]` render in the thinking stream with no git subprocesses (native re-exec and wrapper replay are retired on ACP turns).
*   **Sessions**: engine-scoped keys (`sid:<x>` streaming, `sid:<x>@acp`) — engine switches never cross conversations and rollback preserves both bindings.
*   **Architecture**: The MCP tool bridge runs with no pi patch: bridge calls park in the provider's round-trip store and re-enter pi as real `toolUse` turns (native cards, permissions, hooks). The pre-1.3.0 spawn-and-poll SQLite engine was removed in 1.3.2 (issue #1).
*   **Context Continuity**: The G1 context digest is opt-in (`config.digest` / `AGY_DIGEST` / `/agy digest on`, default off): it changes every turn and defeats the server-side prompt cache. Delivery differs per engine (inline vs embeddedContext resource block).
