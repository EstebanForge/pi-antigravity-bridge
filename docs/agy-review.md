# Architecture Review & Actionable Improvement Plan

This document details findings, potential edge-case issues, and concrete optimization opportunities in `pi-antigravity-bridge`. It is structured as an actionable guide so another developer or agent can implement these enhancements cleanly.

---

## 1. Conversation DB Discovery Under Concurrent Load

### Problem Statement
In [`src/discovery.ts:37-46`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/discovery.ts#L37-L46), `newConversationId()` snapshots existing SQLite `.db` filenames before spawning `agy -p` and diffs against disk during polling. 

If another `agy` process (or subagent) starts concurrently on the same machine, multiple new `.db` files appear in `~/.gemini/antigravity-cli/conversations/`. When `created.length > 1`, `newConversationId()` returns `null` due to ambiguity. This causes `runAgyTurn` to fail with the error:
> *"agy exited cleanly but its conversation database could not be bound."*

### Proposed Action Plan
1. Update `snapshotConversations()` in [`src/discovery.ts`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/discovery.ts) to record file creation/modification timestamps (`mtimeMs` or `birthtimeMs`) using `fs.statSync`.
2. When filtering newly created conversation IDs, check that `stat.mtimeMs >= turnStartTime`.
3. If multiple new DBs exist, sort candidate DBs by `mtimeMs` or inspect the `steps` table of candidate DBs to confirm which DB contains prompt text matching the current turn's initial user request.
4. Add unit tests for `newConversationId` handling multiple concurrent DB files.

---

## 2. Un-coalesced SQLite Queries in Streaming Poll Loop

### Problem Statement
In [`src/poller.ts:111-122`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/poller.ts#L111-L122), `hasChanged()` uses SQLite's `PRAGMA data_version` to avoid running `SELECT` queries when `agy` hasn't committed new transactions.

However, in [`src/runner.ts:188-201`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/runner.ts#L188-L201), `flushStreamStep()` calls `poller.readStepAt(streamIdx)` **before** `poller.poll()`. `readStepAt()` executes `SELECT idx, step_type, status, step_payload FROM steps WHERE idx = ?` directly, bypassing the `hasChanged()` check. As a result, an un-coalesced query executes every 200ms tick even when `agy` is idle.

### Proposed Action Plan
1. Move `flushStreamStep()` behind the `hasChanged()` guard in `ConversationPoller`, or expose a method `poller.hasChanged()` that `runner.ts` can query before calling `readStepAt()`.
2. Alternatively, integrate in-place step re-reading directly into `poller.poll()`, allowing `ConversationPoller` to track both new step inserts and updates to the current active step index in a single pass.
3. Benchmark poll loop CPU / I/O overhead to verify reduced SQLite query execution during idle thinking spans.

---

## 3. Refining Narration Filter Precision

### Problem Statement
In [`src/narration.ts:25-32`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/narration.ts#L25-L32), `isNarration()` evaluates text lines against prefixes (`"I will"`, `"I'll"`, `"I’ll"`). If every non-empty line starts with one of these prefixes, the chunk is flagged as narration and suppressed from pi's response stream.

This introduces two issues:
- **False Positives**: A real assistant answer that starts with `"I will..."` (e.g., `"I will explain the three main causes:"`) gets completely dropped.
- **Dangling Fragments**: When `agy` splits a narration line across multiple steps or ticks, partial line tails can leak into the output stream before the line buffer completes.

### Proposed Action Plan
1. Update `isNarration` to distinguish between tool-action intent lines (e.g. `"I will edit src/index.ts"`, `"I'll inspect the logs"`) and substantive answers by analyzing common action verbs vs explanations.
2. Ensure the line buffer in [`src/provider.ts`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/provider.ts#L153-L179) preserves complete multi-line block contexts before deciding whether to drop or push streaming text deltas.
3. Expand unit test suite in `tests/narration.test.ts` with real-world edge cases (code snippets, numbered lists, sentence continuations).

---

## 4. MCP Server Process Exit Handlers & Protocol Hygiene

### Problem Statement
In [`src/mcp-server.ts`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/mcp-server.ts), `startMcpServer()` writes a per-process config directory under `~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/`.

While `sweepStaleBridgeDirs()` cleans up orphaned directories from dead PIDs when a new session launches, sudden process terminations (`SIGINT`, `SIGTERM`, unhandled crashes) leave stale directories and temporary secret tokens sitting on disk until the next invocation.

Additionally, in [`src/mcp-server.ts:282-290`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/src/mcp-server.ts#L282-L290), `mcp-protocol-version` header rewriting mutates `req.rawHeaders` by stepping through array indices (`i += 2`). While effective, mutating Node core `rawHeaders` relies on internal HTTP parser structure.

### Proposed Action Plan
1. Register explicit process termination handlers (`process.once("exit")`, `process.once("SIGINT")`, `process.once("SIGTERM")`) in `startMcpServer()` to invoke `removeBridgeMcpConfig()` immediately upon process exit.
2. Refactor the header modification in `mcp-server.ts` to construct clean HTTP request/header wrappers before passing them to `@modelcontextprotocol/sdk` transport handlers.

---

## 5. Catalog Discovery Caching & Duplicate Subprocess Optimization

### Problem Statement
During extension load in [`extensions/index.ts:63-65`](file:///workspaces/8d30c9fa20088e4b/EstebanForge/pi-antigravity-bridge/extensions/index.ts#L63-L65), `spawnAgyModelsRaw(binary)` is executed to query `agy models`. 

If `agy` takes time to initialize or process OAuth checks, `spawnAgyModelsRaw` delays extension startup. Furthermore, model discovery results are not cached across session reloads within short time windows.

### Proposed Action Plan
1. Introduce a short TTL cache (e.g., 5 minutes) for `spawnAgyModelsRaw` output saved in `~/.pi/agent/antigravity-bridge/models-cache.json`.
2. Provide an asynchronous background refresh on load so the extension initializes instantly using cached model definitions while updating available models in the background.

## AskAntigravity Gap
One gap worth noting: AskAntigravity (src/ask-tool.ts) binds after agy exits, so its process is dead and the FD scan can't help — it keeps the legacy fail-safe null. Acceptable (one-shot tool, partial output returned), but if you want it covered too, say so.
Do it too in ../pi-ask-antigravity standalone extension.
