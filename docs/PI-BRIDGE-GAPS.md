# pi-antigravity-bridge: capability gaps

Open capability gaps only — things the bridge cannot do today, each blocked
on something outside this repo. For how the bridge works (engines, G9
round-trip, digest), see [ARCHITECTURE.md](./ARCHITECTURE.md). For shipped
work, see `CHANGELOG.md`. Historical gap labels (G1 digest, G8 edit diffs,
G9 round-trip, G10 system prompt) live in the CHANGELOG and source comments;
they are closed and not used here.

## Open gaps

### pi UI primitives

**Status:** Open. **Blocked by:** pi exposing a public API surface for these
without a patch (the old plan of patching `AgentSession.ui` into pi's dist is
dead; the bridge no longer patches pi).

**Objective:** Let agy drive pi's native UI: confirm dialogs, toasts,
file/directory pickers, status/footer updates. agy can already
`ask_user_question`; missing are confirm/permission dialogs for destructive
ops, notification toasts, native file pickers, and status-bar updates. This
does NOT unlock a native diff viewer for agy edits — on stream-json that path
is closed (G8 renders diffs as thinking text); on ACP the server supplies
edit diffs in `tool_call content[]`, rendered the same way.

**Scope when unblocked:** wrappers in `src/mcp-server.ts`
(`pi_confirm`, `pi_notify`, `pi_select_file`, `pi_select_directory`,
`pi_set_status`), each parking through the provider round-trip; tests with a
mocked `ui` seam per primitive.

### Lifecycle event subscription

**Status:** Open. **Blocked by:** a confirmed real consumer.

**Objective:** Let a long-lived agy session observe pi events: `turn_start`,
`turn_end`, `tool_call`, `tool_result`, `compaction`. Today the bridge
handles only `session_start` and `session_shutdown`. Scope would be a
provider-side event tap plus a `pi_subscribe(event)` bridge tool with an SSE
channel.

**Caveat:** agy is request-response per turn even when the engine keeps a
process alive. Before building, confirm a consumer that can act on an async
event stream; otherwise this risks the same "no consumer" failure that sank
file-watching (see graveyard).

## Discarded ideas (graveyard)

Weighed and rejected; kept so they are not re-proposed.

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
  credentials, so agy already uses pi's creds for every tool; a
  credential never crosses the bridge. A `pi_get_setting` accessor was
  predicated on credential reuse that does not apply.
- **Image / binary content blocks over the bridge** — DONE (ACP engine).
  Reopened 2026-09-05: the prior verdict below was falsified. On the ACP
  engine, native `view_file` rejects real filesystem paths (artifact sandbox;
  the tool-priority note steers agy to bridge tools), and bridge `read`
  flattened pi's tool result with `blocksToText`, which drops the image block.
  agy received only the label text and fell back to shell + `mcp-cli-ent
  ai-vision`. Probe `scripts/probe-acp-image-result.mjs` (2026-09-05) proved
  the ACP server delivers MCP tool-result image content to the model (PASS:
  the model identified a two-tone PNG from the tool result alone, with no
  image in the prompt). Fix: image blocks in parked pi tool results now ride
  bridge results as MCP image content on the ACP engine (fast resolve path,
  escalation registry, and `bridge_poll_result`), so `read` on an image file
  gives agy real pixels. DONE on stream-json too (probe
  `scripts/probe-stream-json-image.mjs`, 2026-09-07: the CLI's MCP client
delivers tool-result image content to the model — two-tone PNG named from
the result alone, bridge tool called once, zero decoders in the frame
trail). Image blocks now ride parked pi tool results on both engines
(fast resolve path, escalation registry, and `bridge_poll_result`), so
`read` on an image file gives agy real pixels everywhere. Still
text-only, deliberately: the late-delivery prompt
(`buildLateResultPrompt`), and the stream-json prompt attachments.
  Superseded verdict (kept for the record): NOT NEEDED. pi shares the path to
  any image it produces (e.g. `/tmp/pi-clipboard-<uuid>.png`), and agy
  reaches and reads those files directly via the bridge's `read` tool, so
  returning image content blocks over the transport would duplicate a path
  that already works end-to-end. No agy transport change or pi patch
  required. Update (2026-09-04): user-provided image *attachments* now ride
  natively on the ACP engine as typed prompt content blocks (see README, Two
  engines); the stream-json CLI prompt stays text-only, and the bridge
  direction above is unchanged.
- **File-watching / live state** — DECLINED. agy is request-response
  per turn, not event-reactive; nothing consumes a file-watch SSE stream, and
  re-reads are cheap and correct. Watchers would add inotify/FSEvents handles,
  races, and cleanup for no gain.
