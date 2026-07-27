# pi-antigravity-bridge: capability gaps

Status of the MCP tool bridge between agy (Antigravity CLI, used as pi's Gemini
provider) and pi's extension/builtin tools. Written for assessment: each gap
below can be picked up, fixed, or declined.

## What the bridge already does

agy -> bridge MCP server -> `pi.invokeTool(name, args)` -> pi's tool registry
-> result returned through MCP -> agy model context. The chain was verified
end-to-end with `memory_search` and `ask_user_question`. The bridge exposes
nearly all extension and builtin tools (filtered: agy itself to avoid
recursion, agy's native duplicates so we don't double-up).

What this means: agy can now read/write files, use memory, navigate code with
codegraph, search the web, post to Slack, create Asana tasks, spawn
subagents, prompt the user with `ask_user_question`, and delegate to peer
reviewers (Claude, Codex, Antigravity), all by going through pi's installed
tooling instead of its own.

## Task list: what the bridge does NOT yet give agy

Ten actionable tasks (G1-G10). Order = G-number, not priority. Each entry
carries: objective, why it matters, scope (files), acceptance criteria
(test-first, verifiable), effort, and blockers. Status starts Open.

Tackle order is decided separately (see Triage). Current focus: **G1**.

---

### G1. Give agy conversation-history access [HIGH IMPACT]

**Status:** Open
**Objective:** Expose pi's `AgentSession.messages` and compaction state to agy
through three read-only bridge tools so agy can reference prior turns.

**Why:** agy is stateless across turns from pi's perspective. Each call gets
one prompt and no memory of what the user said before, what decisions were
made, what tool errors happened, or what pi summarized at compaction time.
For multi-turn work pi must re-stitch context; today it does not, so agy
answers in a vacuum.

**Scope:**
- Patch `docs/PI-INVOOKETOOL-PATCH.md`: add read accessors on
  `AgentSession` for messages, summary, and tool log.
- `src/mcp-server.ts`: wrap `pi_get_messages`, `pi_get_summary`,
  `pi_get_tool_log`.
- `tests/mcp-server.test.ts`: round-trip each new tool.

**Acceptance criteria:**
- [ ] `pi_get_messages(limit)` returns last N turns with role + content.
- [ ] `pi_get_summary()` returns pi's compaction summary (or empty if none).
- [ ] `pi_get_tool_log(limit)` returns recent tool calls and their results.
- [ ] All three return JSON; errors are surfaced, never swallowed.
- [ ] Unit tests cover happy path + empty-state + error path.
- [ ] Verified end-to-end: a real agy call retrieves a prior turn.

**Effort:** Medium. Small pi-side patch in `agent-session.js` plus three thin
bridge wrappers.

**Blocks:** None. **Blocked by:** None.

---

### G2. Stream progress for long tool calls [HIGH IMPACT]

**Status:** Open
**Objective:** Stop blocking on long tools (`web_research`, `librarian`,
`codegraph_explore` on big repos). Push partial output back to agy so pi's
UI shows live progress instead of a frozen spinner.

**Why:** Today the bridge blocks until the tool returns. The user has no
signal that work is happening. This is partly a pi-side gap (most long tools
do not emit progress) and partly a bridge-transport gap.

**Scope:**
- `docs/PI-INVOOKETOOL-PATCH.md`: expose pi's progress bus.
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

### G3. Expose pi's UI primitives [MEDIUM-HIGH IMPACT]

**Status:** Open
**Objective:** Let agy drive pi's native UI: confirm dialogs, toasts, file/
directory pickers, status/footer updates.

**Why:** agy can already `ask_user_question`. Missing: confirm/permission
dialog for destructive ops (agy falls back to its own out-of-theme dialog),
notification toast (for "task started" / "save ok"), native file picker
(replaced today by asking for a path in text), and status-bar updates
("Antigravity: working on X").

**Scope:**
- `docs/PI-INVOOKETOOL-PATCH.md`: expose `AgentSession.ui` helpers.
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

### G4. Expose pi's other MCP clients [MEDIUM IMPACT]

**Status:** Open
**Objective:** Optionally include pi's MCP-client tools in the bridge's
`tools/list` so agy's catalog matches pi's full catalog.

**Why:** Today the bridge exposes only pi's extension and builtin tools, not
pi's MCP-client tools. By design (avoid double-hop / circular registration),
but it means the catalogs diverge.

**Scope:**
- Config flag `exposePiMcpClients` (default off) in the bridge config.
- `src/mcp-server.ts`: when flag is on, merge pi's MCP-client tools into
  `tools/list`, dedup by name.
- Risk check: confirm no MCP server breaks under double-registration.

**Acceptance criteria:**
- [ ] Flag off by default; behavior unchanged.
- [ ] Flag on: agy sees pi's MCP-client tools in its catalog.
- [ ] Dedup prevents name collisions with builtin tools.
- [ ] Doc note added on token-amplification tradeoff.

**Effort:** Small-medium. Mainly config + merge logic.

**Blocks:** None. **Blocked by:** None. (Touches agy transport: verify
double-registration safety.)

---

### G5. Refresh tool list mid-session [MEDIUM IMPACT]

**Status:** Open
**Objective:** Let agy see tools loaded after `session_start` (lazy
extensions, dynamically registered tools) without a full pi restart.

**Why:** The bridge snapshots the registry once at `session_start`. Tools
loaded later are invisible to agy until the next session.

**Scope:**
- `src/mcp-server.ts`: poll `pi.listTools()` on a heartbeat and push
  `notifications/tools/list_changed` (MCP-blessed pattern).
- Alternative considered: re-check on every agy request (rejected: too
  noisy).

**Acceptance criteria:**
- [ ] A tool registered after `session_start` appears to agy within one
  heartbeat.
- [ ] Removed tools disappear the same way.
- [ ] Heartbeat interval is configurable.
- [ ] No duplicate registrations on refresh.

**Effort:** Small-medium.

**Blocks:** None. **Blocked by:** None.

---

### G6. Lifecycle event subscription [MEDIUM IMPACT]

**Status:** Open
**Objective:** Let a long-lived agy session observe pi events: `turn_start`,
`turn_end`, `tool_call`, `tool_result`, `compaction`.

**Why:** Today the bridge handles only `session_start` and
`session_shutdown`. agy is fire-and-forget per turn. Event subscription
enables a class of "observer" tooling.

**Scope:**
- `docs/PI-INVOOKETOOL-PATCH.md`: add an event-emitter seam on
  `AgentSession`.
- `src/mcp-server.ts`: `pi_subscribe(event)` returns a stream id; an SSE
  channel pushes events.

**Acceptance criteria:**
- [ ] `pi_subscribe("tool_call")` returns a stream id and subsequent tool
  calls arrive on the channel.
- [ ] Unsubscribe cleans up the stream (no leak).
- [ ] At least three event types supported at close.
- [ ] No perf regression on the event hot path.

**Effort:** Large. Non-trivial pi-side patching.

**Blocks:** None. **Blocked by:** None.

---

### G7. Settings, env, and secrets access [MEDIUM IMPACT]

**Status:** Open
**Objective:** Let agy read well-known pi settings (model prefs, extension
config) through an allowlisted accessor. Never raw secrets.

**Why:** agy cannot read `~/.pi/settings.json`. Each tool relies on its own
env. For tools where pi has already authenticated (Slack, Asana), agy could
reuse the credential, but the bridge does not expose it.

**Scope:**
- `docs/PI-INVOOKETOOL-PATCH.md`: read accessor for settings with an
  allowlist.
- `src/mcp-server.ts`: `pi_get_setting(key)`. Reject keys outside the
  allowlist. Alternatively: forward specific well-known settings to the
  tools that need them.

**Acceptance criteria:**
- [ ] Allowlist lives in one place; non-allowlisted keys return an error.
- [ ] No secret is ever returned in plaintext through MCP.
- [ ] Model preferences and extension config are readable.
- [ ] Test confirms a denylisted key is rejected.

**Effort:** Medium.

**Blocks:** None. **Blocked by:** None.

---

### G8. Diff visualization for file edits [LOW-MEDIUM IMPACT]

**Status:** Open
**Objective:** Make agy edits render as colored diffs in pi's TUI, like pi's
native `edit` tool does.

**Why:** agy edits via the bridge get a plain "wrote N bytes" result. pi's
native `edit` renders a colored diff. UX is inconsistent.

**Scope:**
- Preferred (one-line): route bridge `edit`/`write` calls through pi's
  native `edit` tool already in the registry.
- Fallback: bridge emits a synthetic diff content block and pi learns to
  render it.

**Acceptance criteria:**
- [ ] agy `edit` shows a colored diff in pi's TUI.
- [ ] No change to the bytes written to disk.
- [ ] Existing edit tests still pass.

**Effort:** Small (preferred path).

**Blocks:** None. **Blocked by:** None.

---

### G9. Image / binary content support [LOW IMPACT]

**Status:** Open
**Objective:** Let bridge tools return image content blocks (screenshots,
generated diagrams) instead of forcing base64 or out-of-band file reads.

**Why:** Bridge tools return text/JSON today. pi's vision layer is
unreachable from agy. Main constraint is agy/Gemini's ability to consume
image content blocks.

**Scope:**
- `src/mcp-server.ts` (and possibly `mcp-server.ts` transport): accept and
  forward image content blocks.
- Verify agy/Gemini consumes image blocks; gate on that.

**Acceptance criteria:**
- [ ] A tool returning an image block reaches agy intact.
- [ ] Text/JSON path unchanged.
- [ ] Fallback to base64 if agy rejects image blocks (documented).

**Effort:** Small-medium, but gated on agy transport support.

**Blocks:** None. **Blocked by:** Confirm agy can consume image content
blocks.

---

### G10. File-watching / live state [LOW PRIORITY]

**Status:** Open
**Objective:** Optionally notify agy when a watched file changes, so it does
not have to re-read blindly.

**Why:** Today agy gets no change notification. This matches agy's native
behavior, so it is mostly a non-issue, but worth listing.

**Scope:**
- `src/mcp-server.ts`: optional `pi_watch(path)` tool that emits change
  events on an SSE channel.

**Acceptance criteria:**
- [ ] `pi_watch(path)` emits on file change.
- [ ] Unwatch cleans up.
- [ ] No leak when paths are removed.

**Effort:** Small. **Priority:** Low.

**Blocks:** None. **Blocked by:** None.

---

## Triage

Easy wins (small change, big payoff):

- G8: route bridge `edit` calls through pi's native `edit` tool for diff UX.
- G4: add an `exposePiMcpClients` config flag, default off.
- G5: poll `pi.listTools()` on a heartbeat and push
  `notifications/tools/list_changed`.

Medium effort, high payoff:

- G1: bridge tools for `pi_get_messages`, `pi_get_summary`,
  `pi_get_tool_log`. Requires a small patch in pi's `agent-session.js`.
- G7: `pi_get_setting` with an allowlist.

Larger effort, situational payoff:

- G2: streaming progress for long tools. Touches pi's progress bus and the
  MCP transport.
- G3: expose pi's UI primitives (confirm, notify, picker, status) through
  the bridge. Each is its own small patch in pi plus a bridge wrapper.
- G6: lifecycle-event subscription. Non-trivial but enables a new class of
  "long-lived agy session" tooling.

Low priority:

- G9, G10.

## How to close a gap

For each task above, the shape is the same:

1. Identify the pi-side API to expose (or add).
2. Extend the patch in `docs/PI-INVOOKETOOL-PATCH.md` with a read accessor
   (or a write accessor for write-side gaps).
3. Add a bridge tool wrapper in `src/mcp-server.ts` that calls the patched
   API.
4. Register the tool name with the bridge (it will appear in agy's tool
   catalog on next session).
5. Add a test under `tests/mcp-server.test.ts` that round-trips a real
   call.
6. Tick the task's acceptance checkboxes in this doc.

Most tasks do not require any change to agy, only to the bridge and to
pi's dist. The exceptions are G4 (double-registration of MCP servers) and
G9 (image content blocks), which touch the agy transport.

## Cross-references

- `docs/ARCHITECTURE.md` — bridge design and per-pid config layout.
- `docs/PI-INVOOKETOOL-PATCH.md` — the local patch to pi that this whole
  feature depends on.
- `docs/DEVELOPMENT.md` — how to run tests, rebuild, and iterate.
