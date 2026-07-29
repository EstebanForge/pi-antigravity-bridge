# pi-antigravity-bridge: capability gaps

Status of the MCP tool bridge between agy (Antigravity CLI, used as pi's Gemini
provider) and pi's extension/builtin tools. This doc tracks **open gaps only**.
Shipped work lives in `CHANGELOG.md` (most recently: a conversation-history
delta digest, and git-sourced edit diffs). Ideas that were weighed and rejected
are listed at the end under "Discarded ideas".

## What the bridge already does

agy -> bridge MCP server -> `pi.invokeTool(name, args)` -> pi's tool registry
-> result returned through MCP -> agy model context. The chain was verified
end-to-end with `memory_search` and `ask_user_question`. The bridge exposes
pi's extension tools (builtins are filtered out since agy has native
equivalents; `AskAntigravity` is filtered to avoid recursion).

What this means in practice: agy can read/write files, use memory, navigate
code with codegraph, search the web, post to Slack, create Asana tasks, spawn
subagents, prompt the user with `ask_user_question`, and delegate to peer
reviewers (Claude, Codex, Antigravity), all by going through pi's installed
tooling instead of its own. Tools run in pi's process with pi's own credentials,
so a secret never crosses the bridge. agy's file edits surface as git-sourced
diffs in pi's thinking stream, and each turn agy receives a delta digest of
pi-side context (compaction summaries, other-provider turns) it was not spawned
for.

## Open gaps

Three gaps remain. Every one either needs a pi dist patch (the maintenance cost
the shipped gaps deliberately avoided) or a verify-before-build step. Ordered by
former G-number.

---

### G1. Stream progress for long tool calls [HIGH IMPACT]

**Status:** Open
**Objective:** Stop blocking on long tools (`web_research`, `librarian`,
`codegraph_explore` on big repos). Push partial output back to agy so pi's UI
shows live progress instead of a frozen spinner.

**Why:** Today the bridge blocks until the tool returns. The user has no signal
that work is happening. This is partly a pi-side gap (most long tools do not
emit progress) and partly a bridge-transport gap.

**Scope:**
- `docs/PI-INVOKETOOL-PATCH.md`: expose pi's progress bus.
- `src/mcp-server.ts`: switch from blocking `invokeTool` to a streaming RPC
  using MCP `notifications/progress` (or a `pi_tool_progress` SSE channel).
- pi-side: audit long tools and add progress emission where missing.

**Acceptance criteria:**
- [ ] A tool that runs >1s emits at least one progress notification.
- [ ] pi's TUI spinner updates during the call, not only on completion.
- [ ] Result content is identical to the blocking path (no data loss).
- [ ] Fallback: if a tool does not emit progress, behavior matches today.

**Effort:** Large. Touches pi's progress bus and the MCP transport.

**Blocks:** None. **Blocked by:** None.

---

### G2. Expose pi's UI primitives [MEDIUM-HIGH IMPACT]

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
- `docs/PI-INVOKETOOL-PATCH.md`: expose `AgentSession.ui` helpers.
- `src/mcp-server.ts`: wrappers for `pi_confirm`, `pi_notify`,
  `pi_select_file`, `pi_select_directory`, `pi_set_status`.

**Acceptance criteria:**
- [ ] `pi_confirm(message)` pops pi's native confirm UI and returns boolean.
- [ ] `pi_notify(message)` shows a toast.
- [ ] `pi_select_file`/`pi_select_directory` return chosen paths or null.
- [ ] `pi_set_status(text)` updates the footer; clears on empty string.
- [ ] Tests cover each primitive with a mocked `ui` seam.

**Effort:** Medium-large. Each primitive is a small pi patch plus a wrapper.

**Blocks:** None. **Blocked by:** None.

---

### G3. Lifecycle event subscription [MEDIUM IMPACT]

**Status:** Open
**Objective:** Let a long-lived agy session observe pi events: `turn_start`,
`turn_end`, `tool_call`, `tool_result`, `compaction`.

**Why:** Today the bridge handles only `session_start` and `session_shutdown`.
agy is fire-and-forget per turn. Event subscription would enable a class of
"observer" tooling.

**Caveat:** agy is request-response per turn (`-p`), not event-reactive. Before
building, confirm there is a real consumer that can act on an async event
stream; otherwise this risks the same "no consumer" failure that sank
file-watching (see Discarded ideas).

**Scope:**
- `docs/PI-INVOKETOOL-PATCH.md`: add an event-emitter seam on `AgentSession`.
- `src/mcp-server.ts`: `pi_subscribe(event)` returns a stream id; an SSE
  channel pushes events.

**Acceptance criteria:**
- [ ] `pi_subscribe("tool_call")` returns a stream id and subsequent tool calls
  arrive on the channel.
- [ ] Unsubscribe cleans up the stream (no leak).
- [ ] At least three event types supported at close.
- [ ] No perf regression on the event hot path.

**Effort:** Large. Non-trivial pi-side patching.

**Blocks:** None. **Blocked by:** Confirm a real event-driven consumer exists.

---

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
  the bridge run in pi's process (`pi.invokeTool` -> `tool.execute`) and
  self-authenticate with pi's own credentials, so agy already uses pi's creds
  for every tool; a credential never crosses the bridge. A `pi_get_setting`
  accessor was predicated on credential reuse that does not apply.
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

1. Identify the pi-side API to expose (or add).
2. Extend the patch in `docs/PI-INVOKETOOL-PATCH.md` with a read (or write)
   accessor.
3. Add a bridge tool wrapper in `src/mcp-server.ts` that calls the patched API.
4. Register the tool name with the bridge (it appears in agy's tool catalog on
   the next session).
5. Add a test under `tests/mcp-server.test.ts` that round-trips a real call.
6. Tick the gap's acceptance checkboxes.

Most need no change to agy, only the bridge (and, for some, pi's dist). Note:
the two shipped gaps were closed without any pi dist patch or new MCP tool, by
working provider/decode-side (`src/provider.ts`, `src/diff-render.ts`); the
shape above is a default, not a requirement.

## Cross-references

- `docs/ARCHITECTURE.md` — bridge design and per-pid config layout.
- `docs/PI-INVOKETOOL-PATCH.md` — the local patch to pi that this whole
  feature depends on.
- `docs/DEVELOPMENT.md` — how to run tests, rebuild, and iterate.
- `CHANGELOG.md` — shipped work (conversation-history digest, edit diffs).
