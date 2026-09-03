# ACP Adoption Plan: Official Google `antigravity-acp` Server

Status: PROPOSED. Phase 0 COMPLETE + Phase 1 BUILT (2026-09-03): ACP engine
implemented behind `config.engine` (default off), 153/153 tests, live smoke
PASS through the full stack. Gate F VERIFIED live (`scripts/smoke-acp-bridge.mjs`):
the real server lists bridge tools and completes a tool call through the
registered mcpServers entry. Phase-1 acceptance OPEN: live parity run,
README/DEVELOPMENT/CHANGELOG. Gates: A PASS, B ABSENT (managed — legacy
engine retained until upstream ships usage), C PASS, D FAIL on RC01
(kill+reload fallback VERIFIED), E PASS, F PASS (verified live 2026-09-03).
Verdicts in section 8.1; full captured protocol data in
[ACP-PROTOCOL-REFERENCE.md](./ACP-PROTOCOL-REFERENCE.md); raw traffic
gitignored in `probe-logs/`.
Peer review 1: Claude, 2026-09-03. Verdict PROCEED WITH CHANGES. Findings 1-6
integrated: third round-trip kind for permissions (P1), parked-overall-timer
pause (P1), cumulative-resend guard port, deferred-capability dispositions,
capability-posture prose, concurrency note.
Peer review 2: Antigravity (agy), 2026-09-03. Verdict PROCEED WITH CHANGES.
7 findings integrated: Gate A made a blocking gate for the default flip (the
ACP binary takes no model flags, so the recycle fallback could not carry a
model), sessions re-keyed per engine (`@acp` suffix) after the engine-field
design was shown to erase legacy bindings on rollback, parked-timer pause
changed to remaining-budget semantics, acp-permission plumbing specified
through a TurnDriver interface, session/cancel + session/close pulled into
phase 1, AskAntigravity migration moved from phase 3 to phase 4.

Adopt the official Google ACP server (`agy_acp_server.par`, registry id
`antigravity-acp`) as a second turn engine for the bridge, behind a config
switch. The existing stream-json engine stays the default until the ACP
engine proves parity. Every change is an improvement or a one-to-one
replacement. No functionality is removed until a later phase deletes the
legacy engine on purpose.

Cross-references: [ARCHITECTURE.md](./ARCHITECTURE.md),
[PI-BRIDGE-GAPS.md](./PI-BRIDGE-GAPS.md), [DEVELOPMENT.md](./DEVELOPMENT.md).

## 1. Decision summary

| Question | Answer |
| --- | --- |
| Adopt? | Yes, phased, behind `config.engine: "acp"` |
| Why | Protocol-native permissions, image prompts, thought text, graceful cancel, session resume/list, sanctioned auth path, stable public protocol |
| Why not a rewrite | The provider layer (G1 digest, G10 system prompt, G9 park/resume, pi event mapping) is engine-agnostic and already proven. The driver is the only engine-coupled part |
| Default flip | Phase 4, after a soak release with both engines |
| Regression guard | Parity checklist (section 6) must be all `[x]` before the default flips |

## 2. Verified evidence

All facts below were verified live on 2026-09-03, not taken from docs. Probe
artifacts live in `~/tmp/agy-acp-probe/` (binary, handshake transcripts).

### 2.1 The registry entry

Source: `agentclientprotocol/registry`, path `antigravity-acp/agent.json`
(folder contains only `agent.json` + `icon.svg`).

| Field | Value |
| --- | --- |
| id | `antigravity-acp` |
| name / publisher | Google Antigravity / Google LLC, proprietary |
| version | 1.0.0 |
| build | `agy_acp_server_20260818_01_RC01` |
| binaries | darwin-aarch64, linux-x86_64, linux-aarch64, windows-x86_64, windows-aarch64 |
| linux cmd | `./agy_acp_server.par`, registry args `["--uid="]` |
| flags | `--[no]debug`, `--[no]notices` only. No model/effort/conversation flags |

The registry README states agents are CI-verified to return valid
`authMethods` in the handshake, and the index is re-fetched hourly.

### 2.2 Live initialize response

Sent:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true},"terminal":false}}}
```

Got (abridged to capability names):

```json
{"protocolVersion":1,
 "agentCapabilities":{
   "loadSession":true,
   "promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},
   "mcpCapabilities":{"http":true,"sse":true},
   "sessionCapabilities":{"list":{},"resume":{}},
   "auth":{"logout":{}}},
 "authMethods":[
   {"id":"oauth-personal","name":"Log in with Google"},
   {"id":"oauth-business","name":"Log in with Gemini Enterprise"},
   {"id":"gemini-api-key","name":"Gemini API key"},
   {"id":"agent-platform","name":"Gemini Enterprise Agent Platform"}],
 "agentInfo":{"name":"antigravity-acp","title":"Google Antigravity",
   "version":"agy_acp_server_20260818_01_RC01"}}
```

### 2.3 Unauthenticated session/new

`session/new` returned `-32000 Authentication required` with the full recipe:
call `authenticate`, or set `auth.type` in
`~/.gemini/antigravity-acp/settings.json`. Accepted settings types:
`oauth-personal`, `gemini-api-key` (reads `GEMINI_API_KEY`), `oauth-business`
(needs `gcp.project` + `gcp.location`), `agent-platform` (ADC or
`GOOGLE_API_KEY`, project/location from `GOOGLE_CLOUD_PROJECT` /
`GOOGLE_CLOUD_LOCATION`). Confirmed by the official Zed setup page
(`antigravity.google/docs/ide/extensions/zed/`), which publishes exactly these
`settings.json` shapes.

### 2.4 Binary

1,529,513,909 bytes ELF x86-64, plus a 117 MB `localharness_external`
sibling. Cold start measured at a few seconds on this machine (handshake
answered well inside the probe timeout).

### 2.5 ACP v1 method surface

From `agentclientprotocol/agent-client-protocol` schema source (`v1/agent.rs`,
`v1/client.rs`):

- Client to agent: `initialize`, `authenticate`, `session/new`, `session/load`,
  `session/prompt`, `session/cancel`, `session/list`, `session/resume`,
  `session/fork`, `session/close`, `session/delete`, `session/set_mode`,
  `session/set_config_option`.
- Agent to client (requests): `session/request_permission`,
  `fs/read_text_file`, `fs/write_text_file`, `terminal/create`, `terminal/kill`,
  `terminal/output`, `terminal/release`, `terminal/wait_for_exit`.
- Agent to client (notifications): `session/update`.
- Extension namespace observed in schema: `nes/*` (IDE edit surfaces). Ignore
  for this plan.

### 2.6 Governance

`zed-industries/zed#57221` records the chain: Zed maintainers declined a
standalone SDK integration, waited for Google, and Google shipped the official
server. The same thread documents the Antigravity FAQ position that
third-party access to an Antigravity login violates ToS. The community
adapters carry that risk. Google's own server is the sanctioned client
channel. Our undocumented stream-json driver carries the same class of risk
today. Adoption retires it.

Also dated in that thread: Gemini CLI / Code Assist stop serving 2026-06-18.
`agy` is the only first-party CLI going forward, and its stream-json dialect
is an unmaintained contract. ACP is the maintained one.

## 3. Current architecture inventory and disposition

| Module | Role today | Disposition under ACP |
| --- | --- | --- |
| `src/provider.ts` | streamSimple: pi Context to agy turn to pi events; G9 round-trips; G1 digest; G10 system prompt | KEEP unchanged (additive thought-delta `if` only). Engine-agnostic by contract |
| `src/driver.ts` | persistent stream-json process, turn queue, recycle, timers | KEEP as legacy engine. DELETE in phase 4 |
| `src/stream-events.ts` | NDJSON parser + usage mapping | KEEP as legacy. DELETE in phase 4 |
| `src/sessions.ts` | pi session to agy conversation store | KEEP. Add `engine` tag (section 9.4) |
| `src/config.ts` | runtime config | KEEP. Add engine + acp block (section 9.5) |
| `src/models.ts` | `agy models` to pi Model projection | KEEP. Catalog source stays the CLI until ACP exposes one (probe A.6) |
| `src/mcp-server.ts` | bridge HTTP MCP server; G9 park | KEEP unchanged. Registered via `mcpServers` under ACP |
| `src/skills.ts` | `activate_skill` bridge | KEEP unchanged |
| `src/native-tools.ts` | agy read-only steps to pi builtins | KEEP through phase 2. Phase 3 re-evaluates against `tool_call` content (gate C) |
| `WrapperReplay` (provider.ts) | display-only `antigravity` wrapper tool | Same: re-evaluate in phase 3 (gate C) |
| `src/diff-render.ts` | git-sourced diffs for agy edits | KEEP while agy self-executes edits (our fs capabilities off) |
| `src/ask-tool.ts` | AskAntigravity one-shot via `agy -p` | MIGRATE to ACP one-shot in phase 3 |
| `src/discovery.ts` | snapshot-diff + `/proc` fd-scan conversation binding | DELETE in phase 3 (ACP returns real session ids) |
| `src/patch-cleanup.ts` | pre-1.3.0 patch cleanup | KEEP unrelated |
| `extensions/index.ts` | registration, `/agy` command, notices | EXTEND: engine switch, acp auth command, doctor rebuild |

## 4. Capability matrix

Verdicts: IMPROVEMENT (strictly better), PARITY (equal), RISK (may regress,
mitigation required). Originally assessed pre-probe; verdict column SYNCED to
the Phase 0 results (§8.1, 2026-09-03). Pre-probe reasoning for any row lives
in git history.

| Dimension | Bridge today (stream-json) | Official ACP | Verdict |
| --- | --- | --- | --- |
| Wire contract | Undocumented NDJSON, shapes captured live, cumulative-resend heuristic, `OK`/`SUCCESS` mapping | Public versioned protocol, negotiated handshake | IMPROVEMENT |
| Text streaming | `text_delta` + dedupe guard | `agent_message_chunk` deltas, native | PARITY |
| Thinking | Token count only, floor 64, no text body | `agent_thought_chunk` carries text | IMPROVEMENT |
| Tool call visibility | start/done/error + native re-exec + wrapper replay | `tool_call` / `tool_call_update` with kind, status, content, locations, rawInput/output | IMPROVEMENT (VERIFIED: diffs arrive in content; Gate C PASS — machinery retirement confirmed for phase 3) |
| Permissions | `skipPermissions: true` default, `--dangerously-skip-permissions`, commands run unreviewed | `session/request_permission` flows to the client | PARITY under adoption (`auto` policy, 9.3). The primitive exists for whoever gates later; per-tool gating stays extension-owned via G9 |
| Images in prompt | Dropped in `extractUserPrompt` | `promptCapabilities.image: true` | IMPROVEMENT (VERIFIED end-to-end, run 6: "Red") |
| Audio | Dropped | `promptCapabilities.audio: true` | IMPROVEMENT (low priority) |
| Session resume | `sessions.json` + `--conversation` flag, per pi session only | `session/load`, `list`, `resume`, server-side | IMPROVEMENT (load VERIFIED across restart, run 6; full-text replay rules in 9.2) |
| Cancel | Kill process group; in-flight turn dies | `session/cancel` to `stopReason: cancelled`, process survives | **REGRESSION-MANAGED (Gate D FAIL on RC01): cancel NOT implemented.** Fallback kill + `session/load` VERIFIED; re-check per build |
| Process lifecycle | One agy child per provider; recycle on model/effort/mode/cwd/conversation drift | One server hosts N sessions | IMPROVEMENT |
| Model + effort selection | CLI flags + recycle | `session/set_config_option` (`configId`) | PASS (VERIFIED live, Gate A): per-session switching, no recycle |
| Usage tokens | `toPiUsage` from step events | Not in any payload (Gate B FINAL) | **ABSENT on RC01.** Zero-usage documented; stream-json retained as secondary engine; phase-4 deletion conditioned on Gate B lift |
| MCP tools (G9) | Our HTTP bridge server via `--add-dir` config | `mcpServers` param (`{name,type:"http",url,headers:[]}`) | PARITY at shape level (verified). Phase-1 acceptance: bridge `tools/list`+`tools/call` end-to-end |
| Skills | `--disable-slash-commands`; bridge owns skills | Unknown slash behavior; `available_commands_update` exists | PARITY. Keep our bridge; probe F.7 |
| G1 digest, G10 system prompt | Provider-side prompt assembly | Same (we compose the prompt either way) | PARITY. `embeddedContext` is a later enhancement |
| Diagnostics | `/agy doctor`: snapshot, lifecycle, recycle stats | Nothing equivalent | PARITY work: rebuild on ACP events (section 10) |
| Auth | Piggybacks `agy` CLI login state | First-class: 4 methods, `authenticate`, `logout`, settings.json | IMPROVEMENT. One-time re-login cost |
| One-shot delegation (AskAntigravity) | `agy -p` + snapshot-diff + `/proc` fd-scan | `session/new` + `prompt`, real ids | IMPROVEMENT. Deletes discovery.ts |
| ToS exposure | Undocumented CLI driving | Sanctioned Google client channel | IMPROVEMENT |

## 5. Improvements in detail

1. **Permission flow.** Today any agy `run_command` executes unreviewed; the
   config comment says so in plain words. ACP makes approval a protocol
   primitive (`session/request_permission`, verified live). Under the single
   `auto` policy (9.3) adoption is parity; the primitive is in place for
   whoever wants to gate later.
2. **Thought text.** `agent_thought_chunk` delivers the model's actual
   thinking text. Today pi renders `[thinking]` labels and token counts only.
   Provider change is additive: extend the `thought` activity with an optional
   `delta` field (9.2).
3. **Images.** `promptCapabilities.image` lets us forward pi image blocks as
   ACP image content instead of dropping them in `extractUserPrompt`.
   Community reports say the `agy` CLI itself had broken image upload, so the
   live probe (A.4) verifies end-to-end delivery before we claim this.
4. **Graceful cancel.** `session/cancel` converts to a clean
   `stopReason: cancelled` prompt response. Today abort kills the process
   group and orphans the turn. Maps onto pi's `aborted` stop reason.
5. **Server-side sessions.** `session/load` restores a conversation after a
   pi restart without our store being the source of truth, and
   `session/list` / `session/resume` make `/agy conversations`-style tooling
   possible later. Sessions outlive the process; no recycle on drift.
6. **Protocol stability.** `initialize` negotiates `protocolVersion`. Unknown
   fields degrade instead of silently misparsing (compare: the 1.3.2 sqlite
   incident, issue #1).
7. **Sanctioned channel.** Section 2.6. Risk of account action and of silent
   dialect drift both drop.
8. **One-shot cleanup.** `discovery.ts` exists only because `agy -p` never
   prints its conversation id. ACP returns real session ids. The
   snapshot-diff + `/proc` fd-scan machinery and its ambiguity heuristics get
   deleted.
9. **Enterprise auth.** `oauth-business` / `agent-platform` bring VPC-SC and
   data-residency posture the CLI path never exposed to us.
10. **Deferred, deliberately.** `session/fork` (future multi-branch feature),
   `session/close` / `session/delete` (candidates for a later
   `/agy conversations` cleanup command), `terminal/*` and client-side `fs/*`
   delegation declined: agy keeps executing its own commands and file ops as
   today (parity), and answering them would put execution inside our process
   for no parity gain; our terminal and fs client capabilities stay false.
   `nes/*` IDE-edit extension (ignore), `audio` prompts (phase 2, optional).

## 6. Parity contract (no-regression checklist)

Every box must be `[x]` on the ACP engine before phase 4 flips the default.
Tested with the parity suite (section 11).

- [ ] Text streams token-adjacent to legacy (no full-text re-sends)
- [ ] Multi-turn conversation continuity via `session/load` or our store
- [ ] Turn serialization: two concurrent streamSimple calls never interleave
- [ ] Bridge tool round-trip (G9) works: bridge MCP `tools/call` parks, pi
      executes, `toolResult` resumes the same agy turn
- [ ] Idle timer suspends while a G9 park is open, resumes on `kickIdle`
- [ ] Overall turn timeout (10m) and inactivity timeout (5m) still fire and
      fail the turn visibly
- [ ] Abort: pi user abort produces `aborted`, the server process survives,
      the next turn on the session works
- [ ] pi session restart resumes the right conversation (engine-tagged)
- [ ] Engine rollback preserves the other engine's conversation bindings
      (engine-scoped keys, 9.4)
- [ ] Model catalog: same `antigravity/*` model ids and effort tiers resolve
- [ ] Model/effort switch takes effect (gate A mechanism)
- [ ] G1 digest and G10 system prompt reach the prompt identically
- [ ] Skills `activate_skill` answered by the bridge as today
- [ ] Usage counters: present (mapped) or documented-absent (zero-usage), per
      gate B
- [ ] `/agy doctor` shows connection state, session id, prompt/session stats,
      lifecycle log
- [ ] Error paths: spawn failure, auth failure, protocol error all surface as
      visible turn errors, never as silent empty messages
- [ ] `ask-tool` one-shot returns text, duration, abort/timeout states, and a
      resumable session id
- [ ] Overall-turn timer pauses while any round-trip is parked; a slow human
      permission decision cannot kill the turn
- [ ] Cumulative-resend defensive guard on message chunks (port of
      `isCumulativeResend`), with a fake-server test. Note: provably inert
      on live RC01 (run-5 stress showed pure mid-token deltas); the fake
      server is the only surface that can exercise it

## 7. Regression risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Usage tokens absent (CONFIRMED, Gate B) | Cost/token display zeros on ACP | Zero-usage documented; stream-json retained as SECONDARY engine until upstream ships usage — phase-4 deletion is conditioned on Gate B lifting (review 4, finding 2) |
| ~~No model/effort switch per session~~ RESOLVED: Gate A PASS | — | `session/set_config_option` verified live; per-session switching, no recycle |
| Slash commands expanded server-side | Could double-expand with our prompt assembly | Probe F.7. If present: keep our prefixes out of command-looking lines, or ignore server command list |
| `request_permission` with no pi-side permission UI | Cannot render a native dialog | Single `auto` policy (parity with `skipPermissions: true`); per-tool gating for pi tools belongs to the tools/extensions and is preserved end-to-end by G9 (9.3). Never hang |
| Human decision latency on parked G9 tool round-trips exceeds the 10m overall-turn cap | Turn killed mid-wait | `AcpDriver` pauses the overall timer while parked, re-armed with REMAINING budget; every park carries its own timeout (9.3) |
| Binary size (1.5 GB + 117 MB) | Disk + update churn | Pinned install layout (section 12), registry pin by build id |
| aarch64 TCMalloc startup failure (forum report, Chromebook) | arch-specific | x86_64 unaffected; gate install per-arch, link the forum issue in README |
| Separate auth state from `agy` CLI | First-run auth friction | `/agy acp-auth` prints exact instructions; `gemini-api-key` path works headless via `GEMINI_API_KEY`. The agent never writes credentials |
| Thought text changes rendering volume | Noisy transcript | Route through the existing thinking block pipeline, close-on-switch unchanged; no new block types |
| Two engines drift on behavior | Confusing support surface | Shared provider layer + shared parity suite run against both engines in CI |

## 8. Phase 0: probes and decision gates

One authenticated live session answers every UNKNOWN. No product code in this
phase. Deliverable: findings appended to this doc as section 8.1 (or
`docs/ACP-PROBE-NOTES.md`), and each gate marked PASS / FALLBACK.

Probe scripts (JSON-RPC over stdio, one object per line):

```jsonc
// P1 handshake with MINIMAL client capabilities (our phase-1 posture)
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}

// P2 auth (pick one; api-key path is headless)
//   export GEMINI_API_KEY=... first
{"jsonrpc":"2.0","id":1,"method":"authenticate","params":{"method":"gemini-api-key"}}

// P3 session + bridge registration (exact mcpServers param shape is itself a probe item)
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/abs/cwd","mcpServers":[{"name":"pi-bridge","type":"http","url":"http://127.0.0.1:<port><path>","headers":[]}]}}

// P4 model/effort switch attempts, in order until one works
{"jsonrpc":"2.0","id":3,"method":"session/set_config_option","params":{"sessionId":"<sid>","configOptionId":"model","value":"<slug>"}}
{"jsonrpc":"2.0","id":4,"method":"session/set_config_option","params":{"sessionId":"<sid>","configOptionId":"effort","value":"high"}}
{"jsonrpc":"2.0","id":5,"method":"session/set_mode","params":{"sessionId":"<sid>","modeId":"<id>"}}

// P5 prompt: stream a simple prompt; capture every session/update verbatim
{"jsonrpc":"2.0","id":6,"method":"session/prompt","params":{"sessionId":"<sid>","prompt":[{"type":"text","text":"Say hello and list the files in this directory."}]}}

// P6 mid-stream cancel: send during P5, observe prompt response stopReason
{"jsonrpc":"2.0","id":7,"method":"session/cancel","params":{"sessionId":"<sid>"}}

// P7 image prompt (small png data URL), verify the model actually sees it
{"jsonrpc":"2.0","id":8,"method":"session/prompt","params":{"sessionId":"<sid>","prompt":[{"type":"image","data":"<base64>","mimeType":"image/png"},{"type":"text","text":"What does this image show?"}]}}

// P8 session lifecycle: list, resume, load across server restart
{"jsonrpc":"2.0","id":9,"method":"session/list"}
{"jsonrpc":"2.0","id":10,"method":"session/resume","params":{"sessionId":"<sid>","cwd":"/abs/cwd"}}

// P9 tool exercise: prompt that forces an edit + a command run; capture
// tool_call / tool_call_update shapes and any session/request_permission
```

As executed, live param corrections were applied against these planned
scripts: `methodId` (not `method`), `configId` (not `configOptionId`), and
mcpServers http entries require `headers: []` (a LIST). See 8.1 and the
reference doc.

Capability posture, fixed for phases 1-3 and for every probe: `fs` false,
`terminal` false in the initialize client capabilities. Rationale (corrected
during the skeptical re-check of the peer review): parity, not philosophy.
agy keeps executing its own tools exactly as it does today; answering `fs/*`
or `terminal/*` would put file and process execution inside our process (new
machinery to build, secure, and hold at parity with agy's native behavior)
for no phase-1 gain. Diff-render and the permission surface stay meaningful.
This is a decision, not a default; revisit only as a phase 3+ enhancement
with its own design pass.

Concurrency note: the driver design is one active turn per connection (the
`#active` singleton). No probe exercises a second concurrent session while a
permission request is pending. Unverified by design, not by omission.

What to record for each gate:

| Gate | Question | PASS means | FALLBACK (still parity) |
| --- | --- | --- | --- |
| A | Model + effort switch per session? | `set_config_option` (or equivalent) switches both; next prompt uses them | NONE viable: the ACP binary takes no model flags, so respawn-per-switch cannot carry a model; a settings.json rewrite per switch is the only theoretical path and is rejected (unproven, racy). Gate A FAIL blocks the phase 4 default flip; ACP stays opt-in; the gap goes upstream |
| B | Usage anywhere? | Any update or `_meta` carries token counts | Zero-usage documented; README notes it |
| C | `tool_call` content richness | rawInput/output/locations enough to retire WrapperReplay + native-tools | Keep current replay machinery unchanged |
| D | Cancel latency + state | `stopReason: cancelled` within ~2s; session reusable after | Keep kill semantics on legacy; on ACP keep kill as escalation path |
| E | Startup cost | Cold start < 5s, steady RSS sane for a long-lived process | Spawn per turn-group only (like legacy recycle cadence) |
| F | MCP `mcpServers` registration | Bridge `tools/list` visible to the agent mid-turn | Keep bridge wired some other protocol-sanctioned way; if none, G9 parking breaks and phase 1 is BLOCKED |
| F.7 | Slash behavior | Commands not auto-expanded against our prompt text | Prefix-safe prompt assembly unchanged |

Also verify in P5 whether permission requests arrive at all with `auto`
capabilities off, and whether `fs/write_text_file` requests appear for edits
(they should NOT, with our fs capabilities false; if they do, we answer them
with real local writes, same trust domain).

### 8.1 Phase 0 findings (COMPLETE, 2026-09-03)

Auth completed live: oauth-personal via the BROWSER-capture trick plus an
`ssh -L` loopback tunnel (the server never surfaces the URL headless; full
flow documented in [ACP-PROTOCOL-REFERENCE.md](./ACP-PROTOCOL-REFERENCE.md)).
Run 5 (authenticated, P1-P6) and run 6 (post-restart: load, tools, image,
Gate F) complete. Raw traffic: `probe-logs/acp-traffic-run5.jsonl` (600
JSONL lines) and `acp-traffic-run6-restart-load-tools.jsonl` (28 lines);
conversation store snapshot + schema: `probe-logs/acp-server-conversations/`.

| Gate | Verdict | Evidence |
| --- | --- | --- |
| A: model/effort switch | **PASS (live)** | `session/set_config_option` `{configId:"model", value:"gemini-3.8-flash-low"}` changed `currentValue`. Effort baked into full slugs; full catalog + default (`gemini-3.7-flash-high`) ships in `session/new` — the `agy models` CLI is not needed on the ACP engine |
| B: usage | **ABSENT on RC01** | zero token fields in every payload across both runs, including tool flows. Accept zero-usage (existing documented fallback); re-check per build |
| C: tool_call content | **PASS** | `tool_call`/`tool_call_update` carry kind, status lifecycle, `content` with `{type:"diff", path, newText}` (edits arrive AS DIFFS), `locations`, `rawInput`, optional `rawOutput`. Enough to retire wrapper-replay rendering in phase 3 |
| D: cancel | **FAIL on RC01** | `session/cancel` → `-32601 Method not found` (verified). Abort fallback **kill + `session/load` VERIFIED WORKING** (run 6): session restored with full history after process death |
| E: startup cost | **PASS** | initialize ~5-6 s cold (three runs); steady RSS ~327 MB (5 min mixed load) |
| F: bridge via mcpServers | **PASS (shape)** | `{name, type:"http", url, headers:[]}` accepted; dead URL tolerated at creation (lazy connect). Phase-1 TODO: real bridge `tools/list`+`tools/call` end-to-end (G9) |

Additional live-verified facts (details in the reference doc): token
persistence across restart PASS; `session/load` replays history as FULL-TEXT
chunks (driver must treat as replay, not live); config does NOT persist
across restart (driver re-applies model/effort/mode after every restart);
`session/request_permission` flow verified (options `allow`/`deny`,
kinds `allow_once`/`reject_once`; answer `{outcome:{outcome:"selected",
optionId}}`); image prompts PASS end-to-end; `set_mode` and per-session
`session/close` work; approved tool call may be superseded by another
toolCallId (track effects, not ids).

Schema corrections captured live (all in the reference doc): `authenticate`
takes `methodId` (not `method`); `set_config_option` takes `configId` (not
`configOptionId`); `settings.json` is read at server STARTUP only; -32602
error bodies carry `data.errors[].loc` field paths (use as correction
oracle). Streaming is pure-delta on live prompts (mid-token chunk splits; no
cumulative resends). Modes `default`/`auto_edit`/`yolo` map to our
`mode`/`skipPermissions`. The ACP conversation store is per-session SQLite
with opaque `steps.step_payload` blobs — same two-phase-write family as
legacy issue #1; never poll these DBs (re-validated decision).

Probe list CLOSED. Phase 0 go/no-go: GO for phase 1, with Gate D's kill+
reload abort path and the Gate F bridge end-to-end check as phase-1
acceptance items.

## 9. Target architecture

### 9.1 New modules

```
src/acp/jsonrpc.ts     newline-delimited JSON-RPC 2.0 framing: request/response
                       correlation map, concurrent requests, error responses,
                       notification + server-request dispatch, malformed-line
                       tolerance. Pure transport, no agy knowledge.
src/acp/connection.ts  process lifecycle: spawn AGY_ACP_BIN, initialize
                       handshake, authenticate detection (-32000), session/new
                       / load / prompt / cancel / set_config_option, client-side
                       method handlers (request_permission policy, fs, terminal),
                       outbound event queue.
src/acp/driver.ts      AcpDriver: implements the AgyDriver surface (section 9.2)
                       so provider.ts keeps working unchanged. State machine,
                       timers, parks, snapshot, close.
src/acp/events.ts      session/update to DriverActivity mapping + stopReason
                       mapping. Pure functions, unit-tested against captured
                       probe transcripts.
scripts/smoke-acp.mjs  live smoke, gated by AGY_ACP_LIVE=1 (spends quota),
                       mirrors smoke-stream-json.mjs.
```

### 9.2 Driver contract (unchanged surface, additive only)

`AcpDriver` matches the existing `AgyDriver` public surface: `state`,
`activeHandle`, `run()`, `reentry()`, `kickIdle()`, `set onTurnEnd()`,
`snapshot()`, `close()`. `DriverActivity` gains one additive variant; the
legacy engine never emits it:

```ts
// stream-events/driver today:            { type: "thought"; tokens: number }
// ACP addition:
| { type: "thought"; tokens?: number; delta?: string }
```

`provider.ts` change: when `delta` is present call `appendThinking`, else keep
the current token-count behavior. One `if`, additive, legacy untouched.

Interface extraction (review 2, finding 7): `provider.ts` imports the
concrete `AgyDriver` class today; deleting `driver.ts` in phase 4 would break
the import. Phase 1 extracts a `TurnDriver` interface into a neutral module
(`src/driver-types.ts`); both drivers implement it; `provider.ts` and
`ToolRoundTrips` depend on the interface only. `/agy engine` changes require
a pi restart (driver wiring happens at extension load); a live engine router
is explicitly deferred as speculative.

Teardown contract (review 3, finding 1 — the Gate D kill+reload path needs
an explicit answer for in-flight JSON-RPC state): when the connection dies
or is killed, `AcpConnection.abortAll()` rejects every outstanding
correlation-map entry (the pending `session/prompt` request, any unanswered
client-side requests), the driver settles the turn outcome as
`ERROR`/`aborted` (never left pending), and `onTurnEnd` fires so the
provider's `roundTrips.failAll()` fails parked round-trips exactly as the
legacy driver's `failTurn` path does. Nothing is ever written to a dead
socket; no promise survives the kill. Mirrors `ToolRoundTrips.failAll()`.

Event mapping (`src/acp/events.ts`):

| ACP | DriverActivity | pi mapping (provider.ts, existing) |
| --- | --- | --- |
| `agent_message_chunk` | `{type:"text", delta}` | text block deltas |
| `agent_thought_chunk` | `{type:"thought", delta}` | thinking block deltas |
| `tool_call` (first) | `{type:"tool_start", name, args}` | buffered; render on completion |
| `tool_call_update` completed | `{type:"tool_done", name, args, output}` | thinking label / native re-exec / wrapper (gate C) |
| `tool_call_update` failed | `{type:"tool_error", name, message}` | thinking label |
| `plan` | (phase 2+) thinking label `[agy plan]` | no pi plan block exists yet |
| `available_commands_update` | snapshot field only | `/agy doctor` |
| usage (if found, gate B) | `{type:"usage", usage}` | `toPiUsage` |
| prompt response `end_turn` | TurnOutcome OK | `stopReason: "stop"` |
| `cancelled` | TurnOutcome aborted | `stopReason: "aborted"` |
| `refusal` / `max_turn_requests` / `max_tokens` | TurnOutcome ERROR / OK+note | `error` / `stop` + `errorMessage` |
| `user_message_chunk` (during `session/load` only) | suppressed (history replay) | never emitted to pi as live text |

Defensive guard ported from the legacy engine: if an `agent_message_chunk`
repeats the full accumulated text instead of a delta, detect and slice (the
`isCumulativeResend` lesson; same agy binary lineage, same quirk class).
Guard plus test ship in phase 1. Honest labeling: the ACP spec defines chunks
as deltas, so on a compliant server the guard stays inert; it earns its ten
lines because this exact failure mode was observed in the wild on the same
backend's private protocol, and its steady-state cost is one prefix
comparison per chunk.

Load-replay rules (run 6, verified): `session/load` replays the full
conversation as `user_message_chunk`/`agent_message_chunk` PAIRS carrying
FULL TEXT, not the original deltas. `AcpDriver` marks replay chunks as
history and swallows them; none reach pi as live generation. Two more
restart rules: config does NOT persist across restart (model/effort/mode are
re-applied via `set_config_option` after every restart/load), and
`session/load` takes the same `mcpServers` param as `session/new` — the
bridge registration is passed on both.

### 9.3 Permission policy (simplified per decision 2026-09-03)

pi has no native permission-gate concept; extensions that want gating
implement it inside their own tools. G9 preserves that end-to-end: a pi tool
called by agy executes in pi's loop, where the tool's own gating runs. The
bridge-side `bridge` policy (routing `request_permission` through
`ask_user_question` with a third round-trip kind and a decision cache) was
REJECTED by decision: it built permission UX pi does not have, for agy-native
tools, at real complexity cost. The full design lives in review-3 history if
upstream ever ships allow-always kinds and the calculus changes.

One policy ships:

- `auto`: answer `session/request_permission` in-connection with the allow
  option. Byte-for-byte parity with today's `skipPermissions: true`. No
  round-trip, no provider involvement, no third kind; the once-only options
  quirk (run 6) is irrelevant under auto. Hard rule unchanged: the handler
  never hangs and never blocks the `session/prompt` response path.

Consequence: `provider.ts` is truly UNCHANGED by adoption (its only additive
line is the thought-delta `if`). Gate D teardown (9.2) still applies: on
connection death the unanswered permission request dies with the socket and
`abortAll()` settles everything.

Timer interaction (reviews 1-2, design retained; scope narrowed by the 9.3
decision to G9 tool parks): the overall-turn timer is armed once per turn and
only the idle timer pauses while a round-trip is parked. A human answer
through a parked pi tool (e.g. `ask_user_question`) can legitimately outrun
10 minutes. `AcpDriver` pauses the overall timer while any round-trip is
parked and, on settle, re-arms it with the REMAINING budget (`deadline -
now`), never a fresh cap: the overall timer is a turn DEADLINE, not an
inactivity guard. Every park carries its own timeout (`BRIDGE_TIMEOUT_MS`),
so a paused deadline cannot hang forever. Driver-local (AcpDriver only);
legacy behavior untouched; ships in phase 1.

### 9.4 Sessions schema (engine-scoped keys)

The first design (a per-entry `engine` field) was rejected in review 2:
`set()` overwrites the single `sid:<pi-session>` key, so one ACP turn ERASES
the legacy conversation binding, and a rollback loses continuity, breaking
the section 13 guarantee. Engines scope at the KEY level instead:

```jsonc
// ~/.pi/agent/antigravity-bridge/sessions.json
{
  "sid:<pi-session>":     { "conversationId": "<legacy id>", "lastStepIdx": -1, "lastMessageCount": 42 },
  "sid:<pi-session>@acp": { "conversationId": "<ACP sessionId>", "lastStepIdx": -1, "lastMessageCount": 42 }
}
```

- Un-suffixed keys belong to the legacy engine, byte-compatible with every
  persisted store; ACP keys carry an `@acp` suffix appended by
  `sessionKey()` when `config.engine === "acp"`.
- Engines never touch each other's keys: rollback keeps both continuations,
  `narrowStoreMap` needs no change (keys pass through untouched), and no
  migration runs.
- Under ACP the stored id is the ACP sessionId; `session/load` is attempted
  first on resume, our store only remembers which id to load.

### 9.5 Config schema

```jsonc
// ~/.pi/agent/antigravity-bridge/config.json (additive)
{
  "engine": "stream-json",            // "stream-json" | "acp"; default stream-json
  "acp": {
    "bin": "",                        // path to agy_acp_server.par; empty = resolve
    "permissions": "auto"             // auto-approve request_permission; single policy (9.3)
  }
}
```

- Env: `AGY_ENGINE`, `AGY_ACP_BIN`, `AGY_ACP_PERMISSIONS` (file < env, the
  documented precedence pattern).
- History note: an `engine` key existed before 1.3.2 (sqlite engine) and was
  removed; stale values in old config files are already dropped by narrowing.
  Values narrow to `"stream-json" | "acp"`, anything else falls back to the
  default. The sqlite engine is not coming back.
- Binary resolution order: `AGY_ACP_BIN` > `acp.bin` > `agy_acp_server.par`
  on PATH > install layout default (section 12). Resolution failure is a
  visible turn error naming what was tried.

## 10. Phase plan

### Phase 0: probes, gates, install, auth (no product code) — ✅ COMPLETE (2026-09-03)

- [x] Run probes P1-P9 (section 8). Gate verdicts recorded in 8.1; captured
      protocol in ACP-PROTOCOL-REFERENCE.md; raw traffic in `probe-logs/`.
- [x] Install layout + pin (section 12): binary at
      `~/.local/opt/agy-acp/<build>/` + `current` symlink + zip.sha256.
- [x] Auth onboarded: oauth-personal (token persisted, survives restart —
      verified run 6).
- [x] Deliverable: gates marked — A PASS, B ABSENT (managed), C PASS,
      D FAIL + fallback VERIFIED, E PASS, F PASS-shape. GO for phase 1.

### Phase 1: ACP transport engine, parity only — 🔨 BUILT (2026-09-03), acceptance open

Files: new `src/acp/*`, `src/config.ts` (engine + acp block), `src/sessions.ts`
(engine tag → shipped as engine-scoped KEYS, see 9.4), `extensions/index.ts`
(engine selection + doctor additions), `src/provider.ts` (driver injection
point; `createStreamSimple` already takes the driver as a dep; no other
provider change).

- [x] `jsonrpc.ts` + `connection.ts` + `events.ts` + `driver.ts` as specified
      (+ `TurnDriver` extraction to `src/driver-types.ts`).
- [x] `extractUserPrompt` unchanged (text only in phase 1; images in phase 2).
- [x] `mcpServers` registration of the bridge server at `session/new` AND
      `session/load` (run 6: load takes the same param; resumed sessions must
      keep bridge access). REGISTERED — live end-to-end still pending, see
      acceptance below.
- [x] Permission policy locked to `auto` (single policy; no bridge policy, see
      9.3).
- [x] `session/cancel` wired to pi abort and `session/close` sent on shutdown
      (pulled up from phase 2 by review 2, finding 6: abort must not kill the
      server process, and shutdown should not leak session state server-side).
      RC01 has no cancel: probe-once → -32601 → teardown+kill+reload, probed
      state shown in doctor.
- [x] Overall-turn timer pause while parked, REMAINING-budget semantics
      (9.3), covered by tests (park/kickIdle deadline test).
- [x] Fake-server suites: jsonrpc framing (incl. partial-line buffer), events
      mapping, driver flows (happy, load-replay suppression, permission auto,
      Gate D abort, auth error), engine config narrowing — 153/153 green.
- [x] `/agy engine acp|stream-json` command + `/agy doctor` shows engine,
      server version, session counts, cancel support.
- [x] Live smoke through the full stack (`scripts/smoke-acp.mjs`, quota-
      gated): PASS.
- [x] Round-5 implementation review (agy): P0 framing buffer + 3 P1 + 3 P2
      all fixed.

Open acceptance (blocking "phase 1 done"):

- [x] Bridge `tools/list` + `tools/call` end-to-end on the ACP engine (Gate F
      live) — VERIFIED 2026-09-03, `scripts/smoke-acp-bridge.mjs`, 3/3 runs:
      real server accepted the registration, listed the bridge catalog, called
      `bridge_echo`, and finished its turn with the result (`ECHO:BRIDGE-E2E-777`).
      The check also found and fixed a real defect: the bridge 403s any request
      without the `x-bridge-token` shared secret, but the ACP registration sent
      `headers: []`. Fix: `McpServerHandle` now exposes `token` (and
      `TOKEN_HEADER` is exported); the extension builds the registration headers
      from the handle. Known cosmetic gap (phase 2): `tool_done.output` carries
      agy's tool title ("Bridge echo call"), not the result content — the model
      DID receive the result; only the activity display lacks it. The pi-side G9
      park/resume is engine-independent (proven live on stream-json); the smoke
      answers deps directly to isolate the agy-side HTTP client, the only part
      no fake server could stand in for.
- [ ] §6 parity checklist executed LIVE on both engines (fake-server suites
      are green; live parity run pending).
- [ ] README / DEVELOPMENT / CHANGELOG updates.

Acceptance gate: every section 6 box `[x]` on the ACP engine, or explicitly
marked with its gate fallback.

### Phase 2: protocol-native wins

- `permissions: "bridge"` policy: REMOVED by decision 2026-09-03 (pi has no
  native permission concept; per-tool gating belongs to the tools themselves
  and is preserved by G9; see 9.3). Phase 2 instead probes plan-mode
  equivalence (ACP modes are permission modes; the CLI's `--mode plan` has
  no confirmed mapping) before any mode-dependent feature ships.
- Image (and optionally audio) prompt blocks forwarded from pi content.
- Thought text deltas through the existing thinking pipeline.
- `session/cancel` moved to phase 1; phase 2 keeps the parity test that an
  aborted turn leaves the server process alive and reusable.
- Model/effort switching via the gate A mechanism; on gate A FAIL the flip
  is blocked (see section 8), not worked around.
- Plan updates rendered as thinking labels.
- Acceptance: no parity regression; cancel probe; image probe end-to-end.

### Phase 3: consolidation

- AskAntigravity stays on the legacy one-shot path through phase 3 (review 2,
  finding 5: migrating it while `stream-json` is still the default breaks
  legacy-only users who never onboarded ACP auth, and legacy conversation
  ids cannot resume under ACP). Migration moves to phase 4, simultaneous
  with the legacy deletion.
- Gate C evaluation: if `tool_call` content suffices, retire
  `native-tools.ts` + `WrapperReplay` on the ACP engine (keep for legacy
  engine until phase 4). `diff-render.ts` retires with them only if ACP
  surfaces edit diffs equivalently; otherwise keep and note.
- `/agy doctor` rebuilt on connection events: state, session ids, prompt
  count, reconnects, lifecycle log, server version from `agentInfo`.
- Optional: G1 digest via `embeddedContext` resource blocks instead of inline
  text (keep the inline default; the digest churns the cache the same way
  either way).
- Acceptance: one-shot parity (text, abort, timeout, resumable id), doctor
  parity, deleted-code census committed.

### Phase 4: default flip and legacy deletion

- Gate A verdict PASS is a precondition for the flip (section 8). On FAIL
  the default stays `stream-json` and the flip waits for upstream.
- `engine` default becomes `"acp"` after one full release cycle with both
  engines shipping. CHANGELOG announcement, README rewrite of the engine
  section, `docs/ARCHITECTURE.md` engine section rewritten.
- AskAntigravity migrates to the ACP one-shot (moved here from phase 3 by
  review 2, finding 5): spawn/attach server, `session/new` +
  `session/prompt`, real resumable ids. `discovery.ts` and its `/proc`
  fd-scan delete together with the legacy engine. COMMITTED EXCEPTION
  (review 4, finding 4): `mode: "plan"` delegations keep the legacy
  `agy -p --mode plan` path unless the phase-2 equivalence probe proves an
  ACP route; under `auto` policy a plan delegation on ACP could write.
- Legacy deletion is CONDITIONED on Gate B lifting (review 4, finding 2):
  `stream-json` stays as a secondary `config.engine` option until upstream
  ships usage fields. Deleting it while ACP reports zero-usage would be a
  permanent observability regression, violating the binding constraint. All
  legacy-only code with no ACP dependency (e.g. `discovery.ts`) deletes on
  schedule.
- One release later (and only once Gate B lifted): delete `src/driver.ts`,
  `src/stream-events.ts`, the legacy paths in tests, and `agy`-CLI-coupled
  code that ACP replaced. No
  backward-compat shim (house rule).
- Acceptance: default-flip release ships with the parity suite as its
  acceptance evidence; deletion release has zero references to the removed
  modules.

## 11. Test strategy

- **Framing** (`jsonrpc.ts`): correlation, concurrency, error responses,
  notifications vs requests, malformed lines, backpressure. Pure unit tests.
- **Mapping** (`events.ts`): every session/update variant from captured probe
  transcripts to DriverActivity; stopReason table; unknown-variant tolerance
  (the `parseAgyLine` lesson, re-applied).
- **Driver** (`driver.ts`): scripted fake ACP server (a tiny stdio JSON-RPC
  node script under `tests/helpers/`) covering: handshake, session/new fail
  auth, streaming prompt, park suspends idle timer, kickIdle rearm, cancel
  mid-stream, connection death mid-turn, recycle fallback path.
- **Provider**: the existing `provider-streaming` / `provider-digest` /
  `provider-sysprompt` suites run against both engines via the shared driver
  contract. New case: thought delta path.
- **Sessions**: engine-tag matching, legacy-file compatibility (no tag),
  cross-engine miss starts fresh.
- **Config**: narrowing of stale/garbage `engine` values, env precedence.
- **Parity suite**: the section 6 checklist encoded as an integration run
  against the fake server for both engines; live parity runs stay
  `AGY_ACP_LIVE=1` gated (quota).

## 12. Binary management, pinning, auth onboarding

Install layout:

```
~/.local/opt/agy-acp/<build>/
  agy_acp_server.par
  localharness_external
~/.local/opt/agy-acp/current -> <build>     # symlink; AGY_ACP_BIN default
```

- Pin by build-stamped registry URL (`...20260818_01_RC01-...zip`), not by
  the moving registry index. The registry updates hourly; a float could
  change the engine under a running install mid-release.
- The registry publishes no checksums. Record the zip SHA-256 at install time
  in the install dir for drift detection. Propose an upstream checksum
  request (issue) once we depend on this.
- `--uid=` from the linux registry entry: the server ran without it here.
  Treat as a launcher artifact; revisit if a future build refuses to start.
- Auth onboarding: `/agy acp-auth` prints the four methods with exact
  `settings.json` shapes (source: official Zed docs, section 2.3). Headless
  path: `GEMINI_API_KEY` + `auth.type: "gemini-api-key"`. The agent NEVER
  writes or reads credentials; it prints instructions and verifies by
  re-running `session/new` until the error clears.

## 13. Rollback

At any phase: `AGY_ENGINE=stream-json` (or `/agy engine stream-json`) returns
to the legacy engine. Sessions are keyed per engine (9.4), so the legacy
engine resumes its own conversations untouched. The legacy engine is only deleted in
phase 4, one release after the flip, so rollback stays possible throughout.

## 14. Documentation updates

| Doc | Change | Phase |
| --- | --- | --- |
| `README.md` | engine section, binary install, auth, arch note | 1, 4 |
| `docs/ARCHITECTURE.md` | ACP engine section alongside stream-json | 1 |
| `docs/DEVELOPMENT.md` | smoke-acp, fake server, probe workflow | 1 |
| `docs/ACP-ADOPTION-PLAN.md` | this file; gate results appended | 0 |
| `docs/PI-BRIDGE-GAPS.md` | G1 note: per-tool gating stays extension-owned; G9 preserves it under ACP | 1 |
| `CHANGELOG.md` | per phase, house style | each |

## 15. Risk register

| # | Risk | L | I | Response |
| --- | --- | --- | --- | --- |
| R1 | Gate A fails (no model switch) | M | H | default flip blocked; ACP stays opt-in; escalate upstream. No ship-anyway: model switching is not optional |
| R2 | Gate F fails (bridge not registrable) | L | H | BLOCKS phase 1; escalate upstream, keep legacy |
| R3 | Usage absent (CONFIRMED, Gate B) | H | M | zero-usage documented on ACP; stream-json retained as secondary engine; phase-4 deletion conditioned on Gate B lift (review 4) |
| R4 | Binary churn (hourly registry, RC builds) | M | M | pin by build id, record sha256 |
| R5 | Server rejects second simultaneous session | L | M | one session per connection (today's model), N connections instead |
| R6 | Thought text floods transcript | M | L | thinking pipeline unchanged, same close-on-switch |
| R7 | ToS posture shifts again | L | H | official channel is Google's own; monitor registry + FAQ |
| R8 | aarch64 breakage | L | L | per-arch gating |
| R9 | ~~`bridge` permission throughput~~ removed with the bridge policy (9.3) | - | - | n/a |

## 16. Open questions

CLOSED 2026-09-03 — every item was answered by the Phase 0 probes (section
8.1, [ACP-PROTOCOL-REFERENCE.md](./ACP-PROTOCOL-REFERENCE.md)). Notable
answers: model catalog ships in `session/new` (CLI catalog unnecessary on
ACP); edits surface as diffs inside `tool_call` content even with fs
capabilities off; no usage fields anywhere; available_commands_update carries
`plan` and `logout`; cold start ~5-6 s, steady RSS ~327 MB.
