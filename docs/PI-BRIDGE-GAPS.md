# pi-antigravity-bridge: capability gaps

Status of the MCP tool bridge between agy (Antigravity CLI, used as pi's Gemini
provider) and pi's extension/builtin tools. This doc tracks **open gaps only**.
Shipped work lives in `CHANGELOG.md` (most recently, 1.3.0: the stream-json
engine and the no-patch toolUse round-trip that replaced `pi.invokeTool`).
Ideas that were weighed and rejected are listed at the end under "Discarded
ideas".

## What the bridge already does

agy -> bridge MCP server `tools/call` -> the call parks in the provider's
round-trip store -> the provider ends the pi assistant message with a
`toolUse` stop reason for the real pi tool -> pi executes it in its own loop
(native cards, permissions, hooks) -> the `toolResult` completes the parked
MCP response on the next stream call. No pi patch. Verified end-to-end with
`memory_search` and `ask_user_question`. The bridge exposes pi's extension
tools (builtins are filtered out since agy has native equivalents;
`AskAntigravity` is filtered to avoid recursion).

What this means in practice: agy can read/write files, use memory, navigate
code with codegraph, search the web, post to Slack, create Asana tasks, spawn
subagents, prompt the user with `ask_user_question`, and delegate to peer
reviewers (Claude, Codex, Antigravity), all by going through pi's installed
tooling instead of its own. Tools run in pi's process with pi's own
credentials, so a secret never crosses the bridge, and a long call renders in
pi's native UI while it runs. agy's file edits surface as git-sourced diffs in
pi's thinking stream. A delta digest of pi-side context (compaction summaries,
other-provider turns) is available but OFF by default (`/agy digest on`): the
digest changes every turn and defeats agy's server-side prompt cache. The
reverse direction is on by default (`/agy system-prompt off` to disable):
pi's composed system prompt - its operating instructions plus the global
agent-dir `AGENTS.md` and ancestor `AGENTS.md`/`CLAUDE.md` files - is
prepended as a delimited block to the first prompt of each new agy
conversation, once, so the prompt cache keeps hitting (G10 in
`CHANGELOG.md`).

## Open gaps

Two gaps remain. Both now sit on the no-patch round-trip path, so closing them
means provider- or bridge-side work only; there is no pi dist patch to extend
anymore. Ordered by impact.

**Numbering note:** the G1/G2 labels below are this living doc's renumbered
open set, NOT the historical G-numbers. In the historical list (`CHANGELOG.md`
and the comments in `src/provider.ts`) G1 = conversation-history digest
(shipped 1.0.0, now opt-in via `config.digest`) and G9 = the no-patch toolUse
round-trip (shipped 1.3.0).

---

### G1. Expose pi's UI primitives [MEDIUM-HIGH IMPACT]

**Status:** Open
**Objective:** Let agy drive pi's native UI: confirm dialogs, toasts,
file/directory pickers, status/footer updates.

**Why:** agy can already `ask_user_question`. Missing: confirm/permission
dialog for destructive ops (agy falls back to its own out-of-theme dialog),
notification toast (for "task started" / "save ok"), native file picker
(replaced today by asking for a path in text), and status-bar updates
("Antigravity: working on X"). Note: this does NOT unlock a native diff viewer
for agy edits, that path is structurally closed (see G8 in `CHANGELOG.md`).

**Scope:**
- pi-side: confirm a public API surface for these primitives. The old plan of
  patching `AgentSession.ui` into pi's dist is dead; the bridge no longer
  patches pi.
- `src/mcp-server.ts`: wrappers for `pi_confirm`, `pi_notify`,
  `pi_select_file`, `pi_select_directory`, `pi_set_status`.

**Acceptance criteria:**
- [ ] `pi_confirm(message)` pops pi's native confirm UI and returns boolean.
- [ ] `pi_notify(message)` shows a toast.
- [ ] `pi_select_file`/`pi_select_directory` return chosen paths or null.
- [ ] `pi_set_status(text)` updates the footer; clears on empty string.
- [ ] Tests cover each primitive with a mocked `ui` seam.

**Effort:** Medium-large, gated on pi exposing the primitives without a patch.

**Blocks:** None. **Blocked by:** pi-side API availability.

---

### G2. Lifecycle event subscription [MEDIUM IMPACT]

**Status:** Open
**Objective:** Let a long-lived agy session observe pi events: `turn_start`,
`turn_end`, `tool_call`, `tool_result`, `compaction`.

**Why:** Today the bridge handles only `session_start` and `session_shutdown`.
Event subscription would enable a class of "observer" tooling.

**Caveat:** agy is still request-response per turn, even though the
stream-json engine keeps one process alive across turns. Before building,
confirm there is a real consumer that can act on an async event stream;
otherwise this risks the same "no consumer" failure that sank file-watching
(see Discarded ideas).

**Scope:**
- Provider-side event tap (no pi patch): relay pi event callbacks into the
  bridge.
- `src/mcp-server.ts`: `pi_subscribe(event)` returns a stream id; an SSE
  channel pushes events.

**Acceptance criteria:**
- [ ] `pi_subscribe("tool_call")` returns a stream id and subsequent tool calls
  arrive on the channel.
- [ ] Unsubscribe cleans up the stream (no leak).
- [ ] At least three event types supported at close.
- [ ] No perf regression on the event hot path.

**Effort:** Large.

**Blocks:** None. **Blocked by:** Confirm a real event-driven consumer exists.

---

## Closed by 1.3.0 (moved out of the open set)

- **Stream progress for long tool calls** (the former top open gap): closed by
  the no-patch round-trip. Bridged tools no longer block inside the MCP
  server; they execute as real pi tools in pi's own loop, so pi's native
  card/spinner UX shows progress while the call runs, and the result content
  is identical to the old blocking path.

## Discarded ideas (not worth it)

Weighed and rejected; kept here as a graveyard so they are not re-proposed. Full
reasoning is in project memory.

- **Expose pi's other MCP clients** — REMOVED. pi has no native
  MCP-client support and no MCP extension is in use, so there are no pi
  MCP-client tools to double-expose. The bridge already surfaces every tool pi
  actually registers.
- **Refresh tool list mid-session** — DECLINED. The bridge already
  re-queries `pi.getAllTools()` on every `tools/list` (stateless server), and
  agy reconnects and re-lists every turn (`-p`), so a tool registered
  mid-session appears next turn. The heartbeat would only help a long-lived
  client that caches the list, and there is none.
- **Settings, env, and secrets access** — DECLINED. Tools exposed via
  the bridge run in pi's process and self-authenticate with pi's own
  credentials, so agy already uses pi's creds for every tool; a credential
  never crosses the bridge. A `pi_get_setting` accessor was predicated on
  credential reuse that does not apply.
- **Image / binary content blocks** — NOT NEEDED. pi shares the
  path to any image it produces (e.g. `/tmp/pi-clipboard-<uuid>.png`), and agy
  reaches and reads those files directly via the bridge's `read` tool, so
  returning image content blocks over the transport would duplicate a path
  that already works end-to-end. No agy transport change or pi patch required.
- **File-watching / live state** — DECLINED. agy is request-response
  per turn, not event-reactive; nothing consumes a file-watch SSE stream, and
  re-reads are cheap and correct. Watchers would add inotify/FSEvents handles,
  races, and cleanup for no gain.

## How to close a gap

For each open gap, the default shape:

1. Identify the pi-side API (must be public; the bridge does not patch pi).
2. Add a bridge tool wrapper in `src/mcp-server.ts` that parks a call through
   the provider's round-trip store, or answers bridge-side when no pi tool is
   needed (see `src/skills.ts` for that pattern).
3. Register the tool name with the bridge (it appears in agy's tool catalog on
   the next turn).
4. Add a test under `tests/mcp-server.test.ts` that round-trips a real call.
5. Tick the gap's acceptance checkboxes.

Most need no change to agy, only the bridge or the provider.

## Cross-references

- `docs/ARCHITECTURE.md` — engine internals, round-trip design, per-pid config layout.
- `docs/DEVELOPMENT.md` — how to run tests, rebuild, and iterate.
- `CHANGELOG.md` — shipped work.
