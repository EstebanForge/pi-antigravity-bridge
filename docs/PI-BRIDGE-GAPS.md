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
reviewers (Claude, Codex, Antigravity) — all by going through pi's installed
tooling instead of its own.

## What the bridge does NOT yet give agy

Ten gaps, ordered roughly by impact.

### G1. No conversation-history access (high impact)

agy is **stateless across turns** from pi's perspective. Every agy call gets
one prompt; agy has no tool that lets it read prior turns, prior assistant
messages, prior tool results, or the user-message stream that pi has been
accumulating.

Why this hurts: agy cannot reference what the user said two turns ago, what
decisions were made, what tool errors happened, or what pi summarized at
context-compaction time. For multi-turn work, pi has to re-stitch context
into the prompt it sends agy. Today pi does not, so agy answers in a
vacuum.

Fix shape: add bridge tools `pi_get_messages` (last N turns, with role and
content), `pi_get_summary` (the compressed form pi holds), `pi_get_tool_log`
(what tools were called and their results). Source of truth: pi's
`AgentSession.messages` and compaction state. Requires extending the patch
in `agent-session.js` with read accessors.

### G2. No streaming progress for long tool calls (high impact)

When agy invokes `web_research`, `librarian`, `codegraph_explore` on a large
repo, or any tool that takes more than a second, the bridge **blocks** until
the tool returns. pi's UI sees a frozen spinner. The user has no signal that
work is happening.

Fix shape: switch the bridge from blocking `invokeTool` to a streaming RPC,
and use MCP `notifications/progress` (or a `pi_tool_progress` SSE channel)
to push partial output back to agy. pi-side: tool implementations would need
to emit progress events; pi already has a progress bus for its own tools, we
would need to expose it. Most long tools in the catalog do not currently
emit progress at all, so this is partly a pi-side gap and partly a
bridge-transport gap.

### G3. No access to pi's UI primitives (medium-high impact)

Bridge exposes `ask_user_question`. Missing primitives:

- **Confirmation / permission dialog** — agy cannot pop pi's confirm UI for
  destructive ops. It falls back to its own native confirmation, which the
  user sees as a different dialog (out of theme, different keybindings).
- **Notification toast** — agy cannot ping pi's notify system. Useful for
  "FYI, I started a 30-second task" or "FYI, the save succeeded."
- **File picker / directory picker** — agy cannot trigger pi's native
  `select_file` / `select_directory`. It has to ask the user for the path
  through text.
- **Status / footer updates** — agy cannot update pi's status bar to
  indicate "Antigravity: working on X." It can only emit thinking text.

Fix shape: add bridge tools that wrap pi's UI helpers. pi's
`AgentSession.ui` module is the right seam; we would need to extend the
patch to expose it.

### G4. No discovery of pi's other MCP servers (medium impact)

If you have MCP servers configured in pi's own config (e.g., a custom docs
server, a private registry), agy does **not** see those tools. The bridge
exposes only pi's extension and builtin tools, not pi's MCP-client tools.

This is by design today (we did not want to double-hop or risk circular
registration), but it means agy's tool catalog and pi's full tool catalog
diverge.

Fix shape: the bridge could optionally include pi's MCP-client tools in its
`tools/list` response. Risk: some MCP servers may not survive being
double-registered, and token-amplification on the agy side. Want a config
flag (`exposePiMcpClients: true`) before defaulting on.

### G5. No tool-list refresh mid-session (medium impact)

The bridge snapshots pi's tool registry once at `session_start` and
registers that frozen list with the MCP server. Tools loaded later in the
session (extensions that initialize lazily, dynamically registered tools)
do not appear to agy until the next pi session.

Fix shape: either (a) poll `pi.listTools()` on a heartbeat and push updates
through MCP `notifications/tools/list_changed`, or (b) re-check at every
agy request. Option (a) is the MCP-blessed pattern.

### G6. No hook / lifecycle event subscription (medium impact)

The bridge handles `session_start` and `session_shutdown` to start/stop the
MCP server. agy cannot subscribe to other lifecycle events (`turn_start`,
`turn_end`, `tool_call`, `tool_result`, `compaction`, etc.). For a
long-lived agy session that observes the user's workflow, this would be
valuable. Today agy is fire-and-forget per turn.

Fix shape: expose a `pi_subscribe(event)` tool that returns a stream id, and
an SSE channel the bridge pushes events into. Requires non-trivial pi-side
patching.

### G7. No access to pi's settings, env, secrets (medium impact)

agy cannot read `~/.pi/settings.json`, the user's model preferences,
extension config, or any pi-side secret. Each tool that needs a token
relies on its own env. For tools where pi has already authenticated
(Slack, Asana), agy could in principle reuse the credential — but the
bridge does not expose it.

Fix shape: add `pi_get_setting(key)` (with an allowlist; never expose raw
secrets through MCP). Or, simpler: have the bridge forward specific
well-known settings to tools that need them.

### G8. No diff visualization for file edits (low-medium impact)

When agy uses the bridge's `edit` or `write` tool, pi receives a plain text
result. pi's native `edit` tool renders a colored diff in the TUI. agy's
edits get the raw "wrote N bytes to X" output.

Fix shape: bridge could emit a synthetic "diff" content block alongside the
tool result, and pi could be taught to render it as a diff. Or: have the
bridge call pi's native `edit` (which is already in the registry) instead
of the extension `edit`. The latter is one-line.

### G9. No image / binary content (low impact)

Bridge tools return text/JSON. Any tool that wants to return an image
(screenshot from `agent-browser`, generated diagram) has to encode as
base64 or write to a path agy reads separately. pi's vision layer is
unreachable from agy.

Fix shape: extend the bridge's content-type handling to accept image blocks.
Likely small change in `mcp-server.ts`; the bigger constraint is agy's
ability to consume image content blocks, which is Gemini-dependent.

### G10. No file-watching / live state (low impact)

If a file changes while agy is running, agy does not get notified. It has
to re-read. This matches agy's native behavior, so it is mostly a
non-issue, but worth listing.

Fix shape: optional `pi_watch(path)` tool that emits change events. Low
priority.

## Triage

Easy wins (small change, big payoff):

- G8: route bridge `edit` calls through pi's native `edit` tool for diff UX.
- G4: add a `exposePiMcpClients` config flag, default off.
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

For each gap above, the shape is the same:

1. Identify the pi-side API to expose (or add).
2. Extend the patch in `docs/PI-INVOOKETOOL-PATCH.md` with a read accessor
   (or a write accessor for write-side gaps).
3. Add a bridge tool wrapper in `src/mcp-server.ts` that calls the patched
   API.
4. Register the tool name with the bridge (it will appear in agy's tool
   catalog on next session).
5. Add a test under `tests/mcp-server.test.ts` that round-trips a real
   call.

Most gaps do not require any change to agy — only to the bridge and to
pi's dist. The exception is G4 (double-registration of MCP servers) and
G9 (image content blocks), which touch the agy transport.

## Cross-references

- `docs/ARCHITECTURE.md` — bridge design and per-pid config layout.
- `docs/PI-INVOOKETOOL-PATCH.md` — the local patch to pi that this whole
  feature depends on.
- `docs/DEVELOPMENT.md` — how to run tests, rebuild, and iterate.
