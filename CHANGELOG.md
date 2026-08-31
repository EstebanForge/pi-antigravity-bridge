# Changelog

All notable changes to this project will be documented in this file.

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

## 1.3.0 - unreleased

### Changed

- Stream-json engine: one persistent `agy --input-format stream-json` process per provider; conversation binding from the `init` event (no more SQLite snapshot diffing), native tool-step events (no protobuf decoding), and token usage mapped onto pi's usage when agy reports it. `AGY_ENGINE=legacy-sqlite` keeps the old engine for one release.
- MCP tool bridge no longer patches pi. Bridge calls park in a round-trip store; the provider emits them as real pi `toolUse` turns, pi executes with native cards/permissions/hooks, and the toolResult completes the parked MCP response on the next stream call (mechanism credit: tianzuo/pi-antigravity). `bridgeTools` config selects the surface: `none` / `mcp` (default) / `all`.

### Added

- Native re-execution of agy read-only tools as real pi builtins (native cards, live output).
- Display-only `antigravity` wrapper tool: mutating agy steps land as real toolCall/toolResult pairs via recorded-output replay.
- Skills bridge: `activate_skill` tool exposing the pi Agent Skills catalog to agy, answered by the bridge directly.
- `/agy doctor`: engine, bridge, driver counters, and lifecycle tail, zero tokens.

### Removed

- `pi.invokeTool` patch: `src/patcher.ts`, the load-time consent prompt, `/agy patch` subcommands, `docs/PI-INVOKETOOL-PATCH.md`, and the `invokeToolPatchDeclined` config flag.
