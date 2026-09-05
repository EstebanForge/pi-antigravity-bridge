# Changelog

All notable changes to this project will be documented in this file.

## [1.4.7] - 2026-09-05

### Added

- Daily debug log on disk, sorted by day: `~/.pi/extensions-data/estebanforge/pi-antigravity-bridge/logs/<YYYY-MM-DD>.ndjson`, one JSON record per line, 14-day retention. Built for support: when something breaks, the last days' files replay the failure (engine, session, bridge call, error) without reproducing it. Both engines and everything around them feed it: turn start/outcome with error text, driver failures (stall, abort, timeout, nonzero exit), ACP session load/new and connection exits, bridge tool calls and round-trip failures, AskAntigravity runs, `/agy` commands, ACP setup/self-heal/auth, and the login URL (query string stripped). Secret-shaped values (tokens, API keys, credentials, header blocks) are redacted; prompt text, tool arguments, and tool output never land in the log; an unwritable directory is skipped silently and retried. `/agy doctor` prints the directory.
- Two verbosity tiers keep the disk cost negligible: by default only the info/warn/error skeleton is written (a handful of records per turn). `AGY_DEBUG=1` (or `true`/`on`) restores the full per-event trail: spawn/exit, session load/new, unparks, recycle causes, raw bridge chatter. Turn it on to reproduce, then off.
- Pre-dispatch turn errors now reach the log (previously they only surfaced as a one-line pi error and were lost): driver start failures, stray tool results with no active turn, the ACP plan-mode refusal, and a miswired extension.
- The engine capabilities comparison table in the README: 20 rows comparing `stream-json` vs `acp` (thinking text, token usage, image/audio input, plan mode, slash-command handling, model/effort switching, process lifecycle, session resume, abort, bridge routing, edit diffs, permissions, digest and system-prompt delivery, auth, wire protocol, doctor diagnostics), peer-reviewed against the code and the live probes.

### Changed

- `/agy doctor` prints the log directory with a hint to attach recent days' files when reporting issues.
- README, architecture module map, and the regression-test list document the logger, its support flow, and the `AGY_DEBUG` gate.

## [1.4.6] - 2026-09-04

### Added

- Tool-priority note in the system prompt block (`systemPrompt` setting, on by default): agy runs embedded in pi, so its native interactive tools (the live example was `ask_question` vs the bridge's `ask_user_question`) never reach the user. The note tells agy to always prefer the Pi Bridge tool when one covers the same purpose. The old preamble sentence that allowed "your own tools or the pi tool bridge" is gone, since that ambiguity was the cause.

### Fixed

- `/agy auth` reports a distinct failure instead of a false "Signed in." when the server accepts the sign-in but `acp_token.json` never appears within the 5 s post-authenticate grace window (peer-review find; the poll result was never read).
- Test-infra: the fake ACP server's request log was lost on SIGTERM (buffered write stream + Gate D teardown), which flaked the Gate D abort test ~1-in-3 suite runs; the log now appends synchronously.

### Changed

- The sign-in URL toast fences the URL with blank lines so it stays readable and copyable next to the ssh port-forward hint.

## [1.4.5] - 2026-09-04

### Added

- Tool-priority note in the system prompt block (`systemPrompt` setting, on by default): agy runs embedded in pi, so its native interactive tools (the live example was `ask_question` vs the bridge's `ask_user_question`) never reach the user. The note tells agy to always prefer the Pi Bridge tool when one covers the same purpose. The old preamble sentence that allowed "your own tools or the pi tool bridge" is gone, since that ambiguity was the cause.

- `/agy auth` subcommand: runs the antigravity-acp sign-in on demand (spawns the server, sends `authenticate`, waits for the browser round-trip to complete; minutes-scale). Signing in no longer rides the first Antigravity message, and both login-pending moments now point at `/agy auth`. The sign-in URL toast (and its ssh port-forward hint) fires during `/agy auth` exactly as it does during turns, and a second concurrent `/agy auth` fails fast instead of racing the token write.

### Changed

- `/agy acp-auth` renamed to `/agy auth-manual` (no alias): it prints the manual credential setup for those who want it. Auth-error remediation, MANUAL_SETUP, README, and docs now point at `/agy auth` / `/agy auth-manual`, and the stale first-message login wording is gone from the manual steps.

## [1.4.4] - 2026-09-04

### Added

- The Google sign-in URL now surfaces in pi. The ACP server hands the OAuth URL only to the browser-open call (nothing on stdout/stderr, headless or not), so a `BROWSER` wrapper script records the URL and forwards to the real opener; the connection watches the record file and logs it as an `auth-url` event. The extension toasts it at warning level with the ssh port-forward command for the redirect port, so logins work from SSH sessions on remote machines; local users keep the automatic browser open and get the URL as a fallback. An existing `BROWSER` setting is chained, not replaced.

### Fixed

- ACP login pending was reported only at the moment setup wrote `settings.json`, so after the restart, with `settings.json` in place but the browser login never completed, every check went silent: no toast, no hint, while the first ACP message had no token to use. `needsLogin` now tracks the token file (stat only, never read): `oauth-personal` without `acp_token.json` is login-pending, so the switch-time toast, the picker, and the `session_start` self-heal keep saying so on every start until the login is done.

### Changed

- Engine switching is command-only now: `/agy engine stream-json|acp`. The bare-`/agy` settings picker no longer carries an Engine row (nor the post-save setup run), so the switch surface cannot be hit accidentally; `/agy engine acp` keeps the self-service setup (binary + auth) and the login warning. The picker's plan+acp (RC01) guard stays in a narrower form: the mode row alone can still produce `plan` while the engine is `acp`.
- ACP login-pending messages rewritten for end users: what happens (the server opens the Google sign-in page in your browser on the first Antigravity message), when (after the restart or immediately, per moment), and which account (your Antigravity subscription, the same Google account as the `agy` CLI). No URL to open manually. All remaining moments (engine switch, session start) now toast at warning level so the pending action stands out.
- The "Turn engine" wording became "Engine" in the README env table, the config comment, and the architecture doc heading; the picker row itself is gone (engine switching is command-only, see above).

## [1.4.3] - 2026-09-04

### Added

- AskAntigravity tool toggle: `/agy ask on|off`, an "AskAntigravity tool" row in the bare-`/agy` picker, and the `askTool` config key (env `AGY_ASK_TOOL`). Default on; `off` skips registering the AskAntigravity one-shot delegation tool entirely, for users who want only the provider and its models and no delegation tool in the model's window context. When the separate pi-ask-antigravity package is also installed, `off` means no delegation tool from either package (no fallback). Takes effect on the next pi start (or /reload); `/agy status` shows the state.

### Changed
### Changed

- The bare-`/agy` settings picker gains a Turn engine row (`stream-json`/`acp`). Saving `acp` persists the switch, then runs the same self-service setup as `/agy engine acp` (binary install + auth bootstrap, `acp.bin` updated). The plan+acp RC01 guard now evaluates the effective engine AND mode after the save, so a config already in `plan` plus a fresh `acp` pick is refused instead of persisting an invalid combination (peer-review find).
- "Tool default model/thinking" renamed to "AskAntigravity model/thinking" across the picker, `/agy status`, and toasts; descriptions and README now state the values are fallbacks that callers may override per call.
- All ACP login-pending messages share one wording that names the antigravity-acp server and its place in Google's Antigravity suite (agy desktop, agy editor, agy cli, agy acp), and clarifies the login: same Google account as the agy CLI, separate login with its own token file.

## [1.4.2] - 2026-09-04

### Changed

- `bridgeTools` now defaults to `all` (every registered non-builtin pi tool) instead of `mcp`. The `mcp` surface filters to pi-mcp-adapter tools and serves an empty catalog on installs without that adapter, which left the bridge registered but tool-less from the model's point of view. `none` still opts out entirely; explicit `"bridgeTools": "mcp"` in an existing config keeps pinning the narrow surface.
- Skill discovery now mirrors pi's directory-based scan (docs/skills.md): global `~/.pi/agent/skills` AND `~/.agents/skills`, project `.pi/skills` plus `.agents/skills` in cwd and ancestors up to the git root (project dirs only when pi has trusted the project, same gate pi applies), recursive SKILL.md discovery with grouping folders, per-style root/`.md` rules, hidden entries skipped, and description-less skills dropped. Pi's other skill sources (`skills` settings array, `package.json`, `--skill`) are not mirrored. Previously only one flat level of two directories was scanned, and `~/.agents/skills` (where pi actually reads most skills) was missing entirely, so `activate_skill` never appeared.
- `/agy` now exposes the full runtime config surface: new `/agy bridge all|mcp|none` (which pi tools the MCP bridge hands to agy) and `/agy acp-bin <path|auto>` (target a specific ACP server binary; applies on the next ACP turn), plus Bridge tools, Context digest, and System prompt rows in the bare `/agy` settings picker. Usage strings and `/agy status` list every knob.

## [1.4.1] - 2026-09-04

### Added

- Self-service ACP setup (`src/acp/setup.ts`): `/agy engine acp` now prepares the whole engine instead of printing instructions. It installs the official server binary from the antigravity-acp registry entry (`agentclientprotocol/registry`) into the pinned layout `~/.local/opt/agy-acp/<build>/` with a `current` symlink and the zip sha256 recorded (no upstream checksums exist; plan §12), points `acp.bin` at it, and prepares the login: `oauth-personal` by default, which is the user's own Antigravity subscription (the same Google account and plan as the `agy` CLI; the server opens the browser on the first ACP message, tokens persist). Credential values are never read or written (`acp_token.json` is only stat()ed); `gemini-api-key` stays a manual headless option, never the default. A `session_start` self-heal repeats the check silently when everything is ready and surfaces the manual steps only on failure; `AcpDriverOptions.bin` accepts a resolver so a mid-session install is picked up by the next turn without a restart; `/agy doctor` shows binary source and auth type. Tests inject the registry, archive, and unpacker, so the suite stays offline.

### Fixed

- Stream-json frames split across pipe chunks are now reassembled instead of dropped: `AgyDriver` buffers the trailing partial stdout line (the scheme `JsonRpcSession.feed` already used on the ACP engine). Previously a large `tool` frame or the `result` frame split by a pipe boundary was lost whole, which could turn a successful turn into a bogus "agy exited with status 0" error. Regression test drives a fake agy whose reply is deliberately split mid-line.
- Both drivers attach an `'error'` listener on the child's stdin: an async pipe failure (EPIPE when agy/the ACP server dies mid-write) now fails the turn (ACP: tears the connection down) instead of escaping as an uncaught exception that kills the whole pi process.
- ACP permission answering is fail-closed: `session/request_permission` selects the first reject option unless the turn runs with `skipPermissions`. Previously every request was auto-approved regardless of the `permissions` setting shown by `/agy status`. The unsupported `engine=acp` + `mode=plan` combination is now refused at `/agy engine`, `/agy mode`, and the settings picker, and fails the turn with a visible error instead of silently running non-plan (ACP has no review-only mode in RC01).
- Startup-log fix hardening: four genuine ACP failure events (`session-load-failed-creating-fresh`, `connection-exited`, `cancel-failed`, `unsupported-server-request`) surface again; the dead MCP entries (`capability-missing`, `self-patch-error`) are gone; `call-tool-fail` no longer toasts for the routine fail-all on turn end / session shutdown.
- Startup log leaks: the ACP driver log sink now forwards only genuine failures (`start-failed`, `spawn-error`, `parse-error`, `write-failed`, `mode-apply-failed`, `timeout`, `stall`, `auth-required`) to stderr; routine lifecycle (`driver-created`, spawn, session new/load) stays in the `#lifecycle` ring buffer under `/agy doctor`. The MCP bridge logger no longer toasts (or headless-stderr-logs) normal startup/teardown events (`listening`, `bridge-config-written`, `bridge-config-removed`, `closed`); only failures surface, as warning toasts. The stream-json engine already had no terminal sink.

## [1.4.0] - 2026-09-04

### Added

- The official-server ACP engine as a second turn engine behind `config.engine` (env `AGY_ENGINE`, `/agy engine acp|stream-json`), default off: the tested stream-json engine stays default until upstream ships usage fields. New modules: `src/acp/jsonrpc.ts` (NDJSON JSON-RPC session with line buffering - stdio chunks are not newline-aligned), `src/acp/connection.ts` (initialize, session/new and load, config options, in-connection auto permissions, cancel probing), `src/acp/events.ts` (update mapping), `src/acp/driver.ts` (AcpDriver over the shared `TurnDriver` contract in `src/driver-types.ts`). Sessions are engine-scoped (`sid:<id>@acp`) so switching engines never crosses conversations.
- `/agy engine acp|stream-json` command and `/agy acp-auth` (one-time credential setup for the ACP server, which keeps its own auth state). `/agy doctor` is engine-aware.
- `scripts/smoke-acp.mjs` (live ACP smoke), `scripts/smoke-acp-bridge.mjs` (live Gate F bridge e2e), `scripts/parity-live.mjs` (live parity run: 7 scenarios through BOTH engines). All quota-gated via `AGY_ACP_LIVE=1`.
- `docs/ACP-ADOPTION-PLAN.md` (adoption plan, gates, progress tracking) and `docs/ACP-PROTOCOL-REFERENCE.md` (captured wire shapes of the ACP server).
- Image prompt support on the ACP engine: pi image attachments ride as typed content blocks (`DriverTurnRequest.images`, forwarded by `connection.prompt` ahead of the text block). Models advertise `input: ["text","image"]` only when the engine is `acp` (read at extension load; engine switches require a restart), so the text-only legacy CLI never offers an attach button it cannot honor. Verified live: a 64x64 two-tone PNG answered correctly through the full driver stack (`scripts/smoke-acp-image.mjs`, quota-gated) and in the phase-2 probe (`scripts/probe-acp-phase2.mjs`).
- `scripts/probe-acp-phase2.mjs`: live probe capturing thought-chunk sparsity, image end-to-end, full tool_call/tool_call_update frames, and the `/plan` command flow (raw frames in `probe-logs/`).

### Changed

- `McpServerHandle` exposes the shared-secret token (`token`), and `TOKEN_HEADER` is exported: engines other than the stream-json discovery file need the header to reach the bridge (the ACP registration was silently sending no header and would have been 403'd).
- Driver exit handling is connection-scoped in `AcpDriver`: a killed connection's late exit (the current ACP build intercepts SIGTERM and can outlive its replacement) no longer clobbers the live connection or fails the recovery turn.
- `tool_call_update` display: the completed call's output now prefers the `content[]` text over `rawOutput`, which the server fills with a display title ("Call bridge_echo") rather than the result. The result itself reaches the model out-of-band; only the activity display was wrong.
- Tool-frame mapping fixes from the phase-2 probe: MCP `rawInput` args unwrap the `arguments` envelope, and the tool name prefers `_meta.mcp.tool` over the "<server>_<tool>" title.
- Gate C consolidation on the ACP engine: `native-tools.ts` re-exec and `WrapperReplay` parking are retired for ACP turns (tool steps render as thinking labels; `bridge_call` round-trips unaffected); ACP-native edit diffs from `tool_call` `content[]` render directly into the thinking stream via the new in-memory `formatInlineDiff` (same line-numbered format, zero git subprocesses). The git-sourced `diff-render.ts` path remains solely for the `stream-json` engine.
- G1 digest delivery split by engine: on ACP the digest ships as a native `embeddedContext` resource block in the prompt array (`promptCapabilities.embeddedContext` verified live: a resource block with a secret word was read and answered correctly); `stream-json` keeps the inline text default.
- `/agy doctor` (ACP): shows server reconnects (connections beyond the first = Gate D kills + replacements) and the handshake `agentInfo` name/title next to the server version.

### Fixed

- `tool_call_update` failed frames whose `rawOutput` matches the RC01
  approved-but-never-executed sentinel are dropped instead of rendering as a
  bogus tool error next to a successful edit (run 6, finding 7).
- `AcpDriver` kills a leaked server process when the initialize handshake
  fails (spawn succeeded, init timed out) - the detached process would
  otherwise outlive pi.
- `AcpDriver` snapshot prefers the active session id over the last settled
  one, so `/agy doctor` during a live turn shows the correct session.
- Text dedupe guard: the cumulative-mode flip now requires a respectable
  accumulation (32+ chars), and a cumulative frame that stops extending the
  accumulator falls back to append mode - a short markdown opener (`**`,
  `#`) followed by an ordinary delta no longer corrupts the remaining output
  (round-7 review, applies to both engines).

- No usage fields anywhere: token display shows zero (Gate B; the stream-json engine stays default until upstream ships usage).
- No `session/cancel` (-32601): abort tears the connection down and reloads on the next turn; `cancelSupported` is probed once and shown in `/agy doctor`.
- `tool_call` activity output shows the server's display string, not the MCP result content (the model receives the result out-of-band; only the activity display lacks it).
- `agent_thought_chunk` is sparse on RC01 (a step-by-step prompt produced zero; reasoning ships as plain message text). The thinking pipeline handles deltas when they occur.
- ACP has NO review-only mode: the three modes are permission modes only, and the server-intercepted `/plan` command writes its artifact under auto policy. Plan delegations keep the legacy `agy -p --mode plan` path (committed exception).

## [1.3.3] - 2026-09-01

### Added

- pi system prompt injection (G10): pi's composed system prompt - operating instructions plus the global agent-dir `AGENTS.md` and ancestor `AGENTS.md`/`CLAUDE.md` files - is prepended as a delimited block to the first prompt of each NEW agy conversation. agy has no system-prompt flag, so the prompt text is the only delivery path; the block is sent once per conversation and stays byte-identical afterwards, so agy's server-side prompt cache keeps hitting (unlike the per-turn G1 digest, which stays off by default for that reason). On by default (`config.systemPrompt`, `AGY_SYSTEM_PROMPT`, `/agy system-prompt on|off`); existing conversations keep the version they started with.

## [1.3.2] - 2026-09-01

### Removed

- The `legacy-sqlite` fallback engine: `src/runner.ts`, `src/poller.ts`, `src/protobuf.ts`, the `run-agy` and `decode-db` scripts, and the `engine` config key / `AGY_ENGINE` env var. agy 1.1.18 changed step-row storage to a two-phase write (a placeholder row first, grown in place later); the polling engine read each row once as an empty placeholder and never re-read it, so turns completed with the full reply in the database and zero text in pi (issue #1). The engine decoded an undocumented storage format, so every agy storage change risked repeating that failure silently. The stream-json engine shares none of that code path; verified live against agy 1.1.18-era storage (1.1.23 installed). A stale `engine` value in an existing `config.json` is ignored.
  Reported by @imatimba in #1. Thanks for the exact repro and the root-cause analysis; the report drove this removal.

### Changed

- `scripts/test-provider.ts` wires the stream-json driver explicitly (it exercised the legacy path implicitly before).
- `tests/provider-streaming.test.ts` covers effort mapping against a fake driver. The legacy event-mapping tests died with the engine; stream-json event coverage lives in `tests/stream-roundtrip.test.ts`.

## [1.3.1] - 2026-08-31

### Changed

- Docs-only release. README and package description now describe the 1.3.0 reality: `stream-json` engine as default, no-patch tool bridge, `/agy doctor` + `/agy patch-cleanup`, live token usage. The 1.3.0 tarball shipped the pre-rewrite README, so npm and the pi.dev package gallery still showed the patch-era docs; this republish refreshes the registry metadata.


## [1.3.0] - 2026-08-31

### Added

- Stream-json engine: one persistent `agy --input-format stream-json` process per provider; conversation binding from the `init` event (no more SQLite snapshot diffing), native tool-step events (no protobuf decoding), and token usage mapped onto pi's usage when agy reports it. `AGY_ENGINE=legacy-sqlite` keeps the old engine for one release.
- No-patch MCP tool bridge: bridge calls park in a round-trip store; the provider emits them as real pi `toolUse` turns, pi executes with native cards/permissions/hooks, and the toolResult completes the parked MCP response on the next stream call. `bridgeTools` config selects the surface: `none` / `mcp` (default) / `all`.
- Native re-execution of agy read-only tools as real pi builtins (native cards, live output).
- Display-only `antigravity` wrapper tool: mutating agy steps land as real toolCall/toolResult pairs via recorded-output replay.
- Skills bridge: `activate_skill` tool exposing the pi Agent Skills catalog to agy, answered by the bridge directly.
- `/agy doctor`: engine, bridge, driver counters, and lifecycle tail, zero tokens.
- Legacy patch cleanup: `src/patch-cleanup.ts` detects a leftover invokeTool patch, one-time notice on session start, and `/agy patch-cleanup` restores the original files from the versioned backup.

### Changed

- The MCP tool bridge no longer patches pi. The `pi.invokeTool` round-trip is replaced by the provider-owned park/emit/resolve flow above.

### Fixed

- Live stream-json protocol shapes against real agy: terminal status is `SUCCESS` (not `OK`) and agent text arrives as `text_delta`. The first burn-in turn failed on both; both are pinned by a regression test.
- Native re-exec tool calls include the `reasoning` argument pi requires on read/edit-class builtins; without it pi rejected every native `read` card at validation.
- Peer-review round 2 (engine): parked bridge calls suspend the stdout idle timer (a >5-minute permission prompt no longer kills the turn); turn lifetimes are serialized (a second `run()` can no longer orphan an open turn); the cumulative-text guard points the right direction; a settled turn fails round-trips parked against it.
- Peer-review round 2 (cleanup): backup selection prefers an exact version match over newest-by-mtime (stacked multi-version backups made legitimate restores refuse); `WrapperReplay` entries are single-use (no unbounded growth, no enumerable stale outputs); `rt`-kind round-trips are removed on turn death; the one-time leftover-patch notice is headless-safe (`ctx.hasUI` gate with stderr fallback) and set after surfacing, not before.

### Removed

- `pi.invokeTool` patch: `src/patcher.ts`, the load-time consent prompt, `/agy patch` subcommands, `docs/PI-INVOKETOOL-PATCH.md`, and the `invokeToolPatchDeclined` config flag.


## [1.2.6] - 2026-08-28

### Changed

- **Offline fallback Flash bumped to Gemini 3.7.** `FALLBACK_MODELS`
  (served only when `agy models` fails or is unauthenticated at load) now
  offers `gemini-3.7-flash` instead of `gemini-3.6-flash`. Live discovery
  always overrides the fallback, so this only affects the picker when agy
  is missing or broken.

## [1.2.5] - 2026-08-24

### Fixed

- **Patch updated for pi 0.84.3's bundled runtime.** Two upstream changes
  broke the `pi.invokeTool` patch. First, the `core/extensions/loader.js`
  facade was refactored (`runtime.assertActive()` became a local
  `assertActive()` guard), so the sixth site no longer matched and the
  two-phase apply aborted (fail-closed, no files written). Second, pi's `bin`
  now launches `dist/bundle/cli.js`, a bundled runtime with its own embedded
  core, so patching `dist/core/` could never affect a running pi. The patcher
  now also replaces `dist/bundle/cli.js` with a shim that loads the modular
  `dist/cli.js`, making the six sites live again; `findPiRoot` understands
  the `dist/bundle` argv layout. Tradeoff: pi starts via the modular runtime
  (the bundle's faster startup is forfeited while the patch is applied).
  After upgrading, re-apply via `/agy patch apply` and fully restart pi.
- **Patcher hardening (peer-reviewed).** Atomic writes now preserve the
  destination's permission bits. Without this, every apply stripped the
  execute bit from `dist/bundle/cli.js` (pi's bin target) and broke the `pi`
  command. The entry redirect is never written after any write error, so a
  failed run can no longer silently switch pi to the modular runtime. Backups
  copy forward from the previous same-version backup, so a repair run after a
  partial patch keeps backups complete and restore still reverts the entry
  redirect; an already-redirected entry with no surviving original now warns
  loudly instead of failing silently later.

## [1.2.4] - 2026-08-13

### Added

- **Model, thinking tier, and mode shown next to the tool name.** The
  `AskAntigravity` tool now renders
  `AskAntigravity [model=gemini-3.6-flash, thinking=high]` with a prompt
  preview while a delegation runs, plus a tidy result row
  (`✓ AskAntigravity 12.3s`) with an expandable body. Built on pi's
  `renderCall`/`renderResult` hooks; the values shown are the resolved
  config defaults (model alias + tier), not just the args the caller passed.
  `AgyDetails` gained a `thinking` field.
- **Opt-in full-context delegation (`includeContext`).** New boolean param
  (default `false`, isolated one-shot unchanged). When `true`, the current pi
  conversation is exported as resolved markdown to
  `~/.pi/extensions-data/estebanforge/pi-antigravity-bridge/` and the prompt
  tells agy to read it first. The run passes `--add-dir` for that folder so
  the sandbox can read it; the temp file is removed after the run.

## [1.2.3] - 2026-08-10

### Fixed

- **Model parsing now handles agy's real two-column output.** `agy models`
  prints `<slug>  <display label>` per line, and `--model` accepts only the
  slug. `entriesFromRaw` (provider path) applied its slug regex to the whole
  line, so every real line was rejected and the provider always fell back to
  the hardcoded catalog; it now splits column 1 and requires a hyphen, which
  also drops banner words split out of column 1. The AskAntigravity resolver
  swallowed slug + label into `--model`, which agy rejected; it now returns a
  `{model, effort?}` shape that sends Gemini-family bases' base slug to
  `--model` and their tier to `--effort`, while fixed-thinking families
  (Claude, GPT-OSS) keep the exact slug with no `--effort` (agy rejects it for
  them). Matches the provider's collapse + clamping path. Tests rewritten to
  the verified live `agy models` fixture.

## [1.1.2] - 2026-08-10

### Fixed

- **MCP bridge startup messages no longer pin above the input.** pi's TUI
captures extension stderr and pins it above the editor for the whole session,
which left the `[antigravity-bridge mcp] bridge-config-written` and
`listening` lines stuck on screen. The lifecycle logger now routes through
`ctx.ui.notify` (an ephemeral toast that fades); headless print/json modes
fall back to stderr. Error and diagnostic events use the same channel, so
they no longer pin either.

## [1.1.1] - 2026-08-06

### Changed
- **Dependencies updated.** Raised the `pi-coding-agent`, `pi-ai`, `pi-tui` dev pins to `^0.84.0`. Audited against the pi v0.84.0 breaking changes; the custom `streamSimple` provider still matches pi-ai 0.84.0's stream-event contract, and `tsc --noEmit` passes.

## [1.1.0] - 2026-07-31

### Added

- **Full agy catalog in the picker, grouped like agy's own.** Gemini models
  collapse to base entries (gemini-3.6-flash, gemini-3.1-pro) with a
  thinking-effort toggle; Claude (Sonnet/Opus) and GPT-OSS appear as fixed
  entries with no toggle, since their thinking cannot be changed. The earlier
  Gemini-only filter is gone. Google's Antigravity subscription bills all of
  these through agy, so routing Claude here uses the agy quota you already pay
  for (if you also run pi-claude-bridge you will simply see two Claude
  entries).
- **Reasoning-effort bridging (`agy --effort`).** For an effort-driven Gemini
  base, pi's thinking-effort toggle drives agy's `--effort` (agy 1.1.5+), and
  the toggle only offers the tiers that base actually accepts (Flash:
  low/medium/high; Pro: low/high), so it can never request a tier agy rejects.
  The level is clamped to the base's supported tiers and always passed (a base
  slug is invalid on its own). Fixed models never receive `--effort` (agy
  rejects it for them). Behavior verified by local experiments against agy
  1.1.9.

### Changed

- **Breaking: Gemini model ids changed shape.** Effort is no longer part of the
  model id (`antigravity/gemini-3-6-flash-medium` →
  `antigravity/gemini-3-6-flash`); it is now chosen via pi's thinking-effort
  toggle. A persisted default model, a `--model antigravity/...` flag, or a
  scoped-model pattern set before upgrading will need re-selection.
  Claude/GPT-OSS ids keep their qualified shape (e.g.
  `antigravity/claude-sonnet-4-6`).
- **Requires agy >= 1.1.5.** Base slugs and the `--effort` flag landed there;
  older agy rejects every Gemini entry with a flag error.

### Fixed

- **AskAntigravity model resolution** now parses agy's stable-slug catalog
  (`gemini-3.6-flash-high`, `claude-sonnet-4-6`) instead of the legacy human
  names. The `sonnet`/`opus`/`gpt-oss` aliases and the `/agy thinking` tier had
  silently resolved to invalid `--model` values since agy switched to slugs;
  they now resolve to exact valid slugs.

## [1.0.0] - 2026-07-29

First release. A streaming Gemini model provider for pi, built on Google's
`agy` CLI, plus an MCP tool bridge that lets agy use pi's installed tools
(memory, codegraph, Slack, Asana, web, peer delegation, etc.) instead of its
own. Registers `antigravity/*` models in pi's `/model` picker and streams
responses by polling the SQLite database agy writes and decoding its
protobuf step payloads. No generated protobuf code, no native SQLite
dependency.

### Added

#### Streaming provider

- **Gemini provider for pi.** `antigravity/gemini-*` models appear in pi's
  `/model` picker, discovered live from `agy models` (with a fallback catalog
  when discovery fails). Picking one routes each turn through the provider.
- **Real streaming.** A concurrent poll loop (250ms, `PRAGMA data_version`
  coalescing) reads agy's conversation DB while agy is still running, so text
  and tool activity arrive during the turn, not replayed at exit. Three
  trailing polls catch the final flush; abort skips them for prompt cancel.
- **Hand-rolled protobuf decoder** for agy's `step_payload` blobs: agent text
  at field 20.1, tool calls at field 5.4 (name@2/9, input@3), title at 30.4.
  Field numbers verified against real agy 1.1.7 databases and cross-checked
  against the shindgew/agy-acp and shubzkothekar/antigravity-acp decoders.
  Unknown fields are skipped per protobuf wire rules.
- **Multi-turn conversations.** A pi session is bound to an agy conversation
  id (persisted at `~/.pi/agent/antigravity-bridge/sessions.json`) and
  resumed via `--conversation <id>`. agy keeps its own history; only the latest
  user message is sent each turn. Atomic, dirty-key-merged writes survive
  concurrent pi processes.
- **`/agy` slash command** with status, an interactive picker (mode,
  permissions), and direct subcommands. Settings persist to
  `~/.pi/agent/antigravity-bridge/config.json`.
- **Configurable execution mode** (`accept-edits` default, or `plan`) and
  permissions, overridable by `AGY_MODE` /
  `AGY_SKIP_PERMISSIONS` env vars.
- **`--dangerously-skip-permissions` passed by default.** Technically
  required: `accept-edits` auto-approves file edits but not shell commands,
  so a `run_command` would otherwise hang on an unanswerable `y/n` prompt in
  non-interactive `-p` mode (upstream google-antigravity/antigravity-cli#318).
  Consistent with pi's own no-confirmation-gate design.
- **Conversation-id discovery** by snapshot/diff of agy's conversations dir
  (agy `-p` never prints the id). Refuses to bind on ambiguity.
- **Tool-activity visibility.** agy's closed tool loop surfaces in pi's
  thinking panel as `[agy tool: <name>]`. agy edits/commands land on disk;
  pi's tools never fire (architectural wall, documented).
- **Cross-turn context continuity.** agy keeps its own history, but it now
  also receives pi-side context it wasn't spawned for (compaction summaries,
  turns from other providers or pi's own tools) as a brief digest with the
  prompt each turn, so multi-turn work and provider switches stay coherent.
- **Edit diffs in the thinking stream.** When agy writes a file, pi's thinking
  panel shows a line-numbered diff of the change as it lands. Works across
  nested repos, submodules, and multi-repo workspaces; degrades cleanly for
  binary, off-repo, or unchanged files.
- **Tests.** Unit tests for the protobuf decoder; a
  deterministic fake-agy test that asserts events stream during the run and
  that abort returns promptly (guards the "provider did not actually stream"
  regression class).

#### MCP tool bridge (agy -> pi tools)

- **`AskAntigravity` tool** is now provided by this extension (ported from
  `pi-ask-antigravity` v1.1.0). The bridge ships BOTH the streaming
  antigravity provider AND the one-shot delegation tool - the same combined
  shape as `pi-claude-bridge`. Model aliases (flash/pro/gemini, tier/version
  qualifiers), one-shot vs continued-conversation modes, and the `mode`/
  `digest` params are all preserved.
- **Cross-extension clash avoidance.** When both this bridge and
  `pi-ask-antigravity` are installed, the bridge wins and
  `pi-ask-antigravity` silently registers nothing (it detects the bridge via
  package resolution, order-independent). The `AskAntigravity` tool is never
  duplicated.
- **`/agy` gains `model` and `thinking` subcommands + picker rows** for the
  tool's defaults (alias flash/pro/gemini; tier low/medium/high). Persisted
  alongside the provider settings in `config.json`.
- **MCP tool bridge.** agy runs as pi's Gemini provider; the bridge exposes
  pi's installed tools to agy over a Streamable HTTP MCP server so agy can
  call them (memory, codegraph, Slack, Asana, web, peer delegation, etc.)
  instead of doing the work itself. Per-pid config directory at
  `~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/`, written into agy's
  `--add-dir` path so agy reads `.agents/mcp_config.json` from there.
  Global agy config is never touched.
- **Capability gate.** The bridge checks for `pi.invokeTool` at startup and
  silently no-ops the MCP server if the patch is absent (clean pi reinstall
  drops the patch; bridge still runs as a provider).
- **Tool filtering.** Builtin tools that agy already has natively (read,
  write, edit, bash, ls, grep, find) are filtered out so agy does not double
  up on its own equivalents; `AskAntigravity` is filtered to avoid recursion.
  Every other registered tool is exposed.
- **Security.** Shared-secret `x-bridge-token` header, request body size cap,
  per-call `AbortController` so agy can cancel in-flight tool calls, full
  request handler `try/catch`, rawHeaders rewrite for Hono's protocol clamp.

#### Documentation

- `docs/ARCHITECTURE.md` - bridge design and per-pid config layout.
- `docs/DEVELOPMENT.md` - how to run tests, rebuild, and iterate.
- `docs/PI-INVOKETOOL-PATCH.md` - the local patch to pi's dist that the
  bridge depends on.
- `docs/PI-BRIDGE-GAPS.md` - capability gaps, as actionable tasks (G1-G10).
  G1 (conversation history) and G8 (edit diffs) are closed via no-patch,
  provider/decode-side work; the rest (streaming progress, UI primitives,
  MCP-server double-exposure, etc.) remain open, triaged by effort and payoff.

### Fixed

- **Protocol-version clamp for the MCP bridge.** agy negotiates a protocol
  version newer than the SDK this bridge ships: `@modelcontextprotocol/sdk`
  1.29.0 tops out at `2025-11-25`, but agy sends `2026-07-28`. `initialize` is
  exempt from the transport's header check and the SDK downgrades its body
  version itself, yet every follow-up (`tools/list`, `tools/call`,
  `notifications/initialized`) is validated against the `MCP-Protocol-Version`
  header and rejected with `400 Bad Request: Unsupported protocol version`,
  surfaced as a `transport-error` on every turn. The bridge now rewrites any
  unsupported header value to `LATEST_PROTOCOL_VERSION` before the transport
  sees it. The server is stateless (a fresh transport per request), so it
  cannot track the negotiated version across requests; clamping to LATEST is
  the correct downgrade. Hono's Node->Web conversion reads `req.rawHeaders`,
  not the parsed `req.headers` object, so the value is rewritten in the raw
  array (and mirrored on `req.headers` for other readers).
