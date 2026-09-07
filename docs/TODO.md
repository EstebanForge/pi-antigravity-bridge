# TODO

Pending work, two streams. Evidence dates: 2026-09-05 (stream-json thread), 2026-09-07 (approval-gate probes).

## 1. Stream-json engine: bridge tools registration regression

**Status: blocked on explicit go.** Discovered 2026-09-05 while probing image support.

The stream-json engine registers **no bridge tools at all**. Nobody noticed because the daily engine is ACP, where `mcpServers` ride `session/new` and work. Stream-json image support stays unmeasured until tools register.

Context: this thread includes the 2026-09-05 working-tree incident (unguarded probe cleanup deleted the repo; recovered from remote + transcript; `tsc` clean, 248/248 tests verified then and re-verified 2026-09-07). The two untracked probe scripts (`scripts/probe-acp-image-result.mjs`, `scripts/probe-stream-json-image.mjs`) are the hazard-fixed reconstructions and belong to this thread.

Fix path, in order:

1. **Probe the supported mechanism.** `agy mcp add --type http -H "x-bridge-token: ..." pi-bridge-<pid> http://127.0.0.1:<port>/mcp` writes `~/.gemini/config/mcp_config.json`, a location the CLI demonstrably reads. One reg-check run, no quota. **BLOCKED**: touches a global user-visible file outside this repo; needs explicit go.
2. **If tools appear**: bridge start writes its per-pid entry, close removes it, stale sweep like the per-pid dirs. Re-run the image probe with frame-trail verification (no python decoders in the trail). On a genuine PASS, widen the engine gate to forward pixels on stream-json.
3. **If they do not**: stream-json stays description-based via pi-vision-handoff, and the registration regression goes upstream to the agy CLI.

---

## 2. Approval gate bridge: pi permissions over agy native tools

**Status: designed, not implemented.** This section is a cold-start specification. A future agent with no prior context should be able to implement from it. Two load-bearing verifications must run before coding the deny path (see 2.8).

### 2.1 Background: why this work exists

The bridge (`@estebanforge/pi-antigravity-bridge`) is a pi custom provider for Google Antigravity with two turn engines behind one `TurnDriver` contract: default `stream-json` (persistent `agy` CLI process) and opt-in `acp` (official `agy_acp_server.par` over JSON-RPC stdio). See `AGENTS.md`, `docs/ACP-PROTOCOL-REFERENCE.md`, `docs/ACP-ADOPTION-PLAN.md`.

Antigravity is not a plain model: it runs its own agent loop with its own native tools (`create_file`, `edit_file`, `replace_file_content`, `multi_replace_file_content`, `run_command`, `view_file`, `list_dir`, `grep_search`, `find_by_name`, ...). This creates a split:

- pi tools that agy calls travel through the bridge MCP server (G9 no-patch round-trip): the bridge parks the call, pi executes the REAL pi tool in pi's own loop, so pi's native cards, permissions, and extension gates all apply. See `docs/ARCHITECTURE.md` ("No-patch tool round-trip (G9)").
- agy's NATIVE tools execute inside agy's loop with no pi involvement. Pi is a spectator. Today nothing lets pi, the user, or a pi extension approve, deny, or even observe those calls before they happen.

This work closes that gap: agy native tool calls must pass through a pi-side approval gate, in a form that the existing pi permission-extension ecosystem gates with zero or near-zero changes.

### 2.2 Verified facts (evidence-dated)

All probes ran 2026-09-07 against `agy_acp_server_20260818_01_RC01` (registry id `antigravity-acp`), linux-x86_64, workspace `/home/esteban/tmp/acp-probe-ws`.

**F1 - ACP server fires workspace hooks.** With `.agents/hooks.json` present in the `cwd` passed to `session/new`, `PreToolUse` fired 6 times in one 3-prompt run (`list_directory`, `find_file`, `create_file`, ...). The stdin payload matches the documented CLI hook contract exactly: `toolCall.{name,args}`, `stepIdx`, `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`. Real captured payload (truncated):

```json
{"toolCall": {"name": "create_file", "args": {"CodeContent": "hello-hook", "Description": "Create hook-test.txt in the workspace root", "Overwrite": true, "TargetFile": "/home/esteban/tmp/acp-probe-ws/hook-test.txt"}}, "stepIdx": 5, "conversationId": "52402663-...", "workspacePaths": ["<session cwd>", "/home/<u>/.gemini/config/skills", "<ws>/.gemini/skills", "/home/<u>/.gemini/antigravity-cli/skills", "<ws>/.agents/skills"], "transcriptPath": "/home/<u>/.gemini/antigravity-acp/conversations/<sid>.db", "artifactDirectoryPath": "/home/<u>/.gemini/artifacts"}
```

**F2 - Observation mode works end-to-end.** Hook stdout `{}` did not block; `create_file` executed and wrote the file. One hook process ran per tool call, sequentially before execution.

**F3 - What the ACP server does NOT load.** Verified by model answers (`NO-RULE`, unrecognized slash commands) and by grepping the server's conversation SQLite store (`~/.gemini/antigravity-acp/conversations/<sid>.db`) for planted marker strings (zero hits): `.agents/rules/` text never reaches model context; `.agents/skills/` SKILL.md content is never loaded and skills do not compile into slash commands (server built-ins like `/plan` only). `Stop` hooks never fired (0 events across 3 turn ends). Conclusion: rules and skills remain the bridge's responsibility (G10 prompt composition, `activate_skill` bridge). Only `hooks.json` (`PreToolUse`) is the usable file-based seam on ACP.

**F4 - Every hook payload advertises the customization tree.** `workspacePaths` listed: the session `cwd`, `~/.gemini/config/skills`, `<ws>/.gemini/skills`, `~/.gemini/antigravity-cli/skills`, `<ws>/.agents/skills`. The server natively knows the standard Antigravity customization locations; expect broader loading in later builds.

**F5 - pi lets extension tools shadow builtins.** pi merges extension-registered tools AFTER base tools in `_refreshToolRegistry` (`/home/linuxbrew/.linuxbrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js`, ~line 2114): `definitionRegistry` is seeded from `_baseToolDefinitions`, then every custom tool does `definitionRegistry.set(tool.definition.name, ...)` (last-write-wins). `pi.registerTool({name: "bash", ...})` therefore replaces pi's builtin `bash` for dispatch. `registerTool` itself (`dist/core/extensions/loader.js` ~238) just writes into the extension's tool map; no duplicate check.

**F6 - pi's gate API is `pi.on("tool_call")`.** Documented in pi's `docs/extensions.md` (section "Tool Events / tool_call", ~line 778): fires after `tool_execution_start`, before execution; `event.toolName`, `event.toolCallId`; `event.input` is MUTABLE (mutations affect execution and later handlers); a handler returns `{block: true, reason?, terminate?}` to block. Shipped pi examples: `permission-gate.ts` (`on("tool_call")` + `ctx.ui.confirm`), `protected-paths.ts`. Human-ask API: `ctx.ui.confirm/select/input/editor/custom` with `{timeout, signal}` options; `ctx.hasUI` is false in `-p`/headless mode and MUST be guarded before dialogs.

**F7 - The permission-extension ecosystem keys on builtin names.** Audit of the 10 pi.dev "permissions" packages (2026-09-07, sources in `~/tmp/pi-perm-research/`, details in 2.4): a `tool_call` shaped `{"toolName":"bash","input":{command}}` gates ZERO-CHANGE in all 8 real codebases. `write`/`edit` + `input.path` gates in 7 of 8. Custom tool names are the worst case: most packages ignore or allow unknown names.

### 2.3 The Antigravity hooks surface (contract)

From `https://antigravity.google/docs/hooks/` (verified live for `PreToolUse` on ACP per F1/F2):

- Location: `hooks.json` in the workspace `.agents/` dir (the `cwd` passed to `session/new` on ACP) or global `~/.gemini/config/`. Plugin bundles can also carry it.
- Events: `PreToolUse` (regex `matcher` on tool name), `PostToolUse` (same matching; input includes `error`), `PreInvocation`/`PostInvocation` (no matcher; `injectSteps`), `Stop` (did not fire on ACP RC01, see F3).
- Handler: `{type: "command", command, timeout}`; runs as a shell command; input on stdin as JSON; output on stdout as JSON.
- `PreToolUse` stdout contract: `{"decision": "allow|deny|ask|force_ask|deny_unless_prior_grant", "reason": "...", "permissionOverrides": [...]}`. Empty object `{}` = observation (proceed).
- Design-critical: human-decision latency exceeds any sane handler `timeout` (docs default 30s). What agy does when a hook times out is UNVERIFIED on ACP (see 2.8 item V3).

### 2.4 Permission-extension audit (what we must be compatible with)

Packages from the user's list, ranked by weekly npm downloads at audit time. Sources extracted under `~/tmp/pi-perm-research/`. Two fork pairs: `@xzzpig/pi-permission-system` is an earlier fork of `@gotgenes/pi-permission-system`; `pi-permission-system` is an earlier fork of `@monroewilliams/pi-permission-system`. So 10 packages, 8 real codebases.

| Package | dl/wk | Hook | Matching | Unknown tool name | Headless ask |
|---|---|---|---|---|---|
| @gotgenes/pi-permission-system | 11580 | `tool_call`, fail-closed | `bash`+`input.command` (full lexer, chain split, wrapper floor), path tools (`read/write/edit/find/grep/ls`), `mcp`, `skill`, any name via config; surfaces map `allow`/`ask`/`deny` with `*` wildcards, command prefixes (`"git *": "ask"`), `~` expansion, yoloMode, session-scope persistence | keyed by name; unmatched -> `"*"` default ask | prompt if UI, else block |
| @zhushanwen/pi-permission | 440 | `tool_call` | bash-only rules (wildcards + danger regexes); modes yolo (default, pass) / approve / auto | non-bash -> ask | n/a (select UI) |
| pi-permission-system | 386 | fork of monroewilliams | see monroewilliams | | |
| @xzzpig/pi-permission-system | 208 | fork of gotgenes, earlier rev | | | |
| @diegopetrucci/pi-permission-gate | 192 | `tool_call` | hard names only: `bash`/`powershell` (danger regex + rm tokenizer), `write`/`edit` (protected paths; requires well-formed `content`/`edits` input) | ignore/allow | block |
| pi-permission-modes | 145 | sandbox, not a rule gate | modes default/plan/build/yolo over real bash exec; network tool headless denied | untouched | denied |
| @inobit/pi-permission | 84 | `tool_call` | `bash`/`powershell` + hard-coded `exec_command` when `input.command` is a string; `write`/`edit` via `input.path`; env files deny; modes plan/build/yolo | no-path input -> silent allow | deny |
| @thurstonsand/pi-permissions | 76 | `tool_call` + user hook modules | typed `{toolName:"bash", command}` / `{toolName, input, path}`; hooks may rewrite the command | no matching hook -> skip | block |
| @monroewilliams/pi-permission-system | 30 | `tool_call` | blocks UNREGISTERED tool names outright (checks `pi.getAllTools()`); bash command lexer with redirect analysis; policy objects `bash:{"git *":"ask"}`; review log | unregistered -> block; registered generic -> default ask | block |
| @rhedbull/pi-permissions | 16 | `tool_call` | `GATED_TOOLS = {write, edit, bash}`; Claude modes `default|acceptEdits|fullAuto|bypassPermissions`; catastrophic/protected/dangerous patterns; session allow sets | ignore | block |

Cross-cutting conclusions:

- Universal trigger: `toolName:"bash"` + `input.command` string. Second: `write`/`edit` + `input.path`.
- Decision vocabularies differ (`allow/ask/deny`, `forbid/confirm`) but all reduce to proceed vs `{block, reason}`.
- Every package fails closed or blocks when a headless ask cannot be shown. Our fallback must deny headless.
- Two packages impose input requirements (diegopetrucci: well-formed `content`/`edits`; monroewilliams: name must be registered). Shadow tools must keep schemas field-exact and stay registered.

### 2.5 Design (v2: builtin-shaped shadow tools)

Principle: do not invent a new approval bus. Emit the approval as a NATIVE-SHAPED pi tool call so pi's existing `tool_call` gate surface (F6) and the whole extension ecosystem (F7) apply unchanged.

End-to-end flow:

```text
agy native tool call (e.g. run_command "npm test")
  | (1) ACP server fires .agents/hooks.json PreToolUse            (F1)
  v
hook script (bundled by the bridge, absolute path)
  | (2) POST stdin JSON -> http://127.0.0.1:<port>/approval (token)
  v
bridge src/mcp-server.ts
  | (3) park the request (same semantics family as G9)
  v
provider src/provider.ts
  | (4) end current assistant message with toolUse stop reason for a
  |     SHADOW tool, e.g. name "bash", input {command, cwd, __agyGate: true}
  v
pi core
  | (5) fires tool_call -> every permission extension gates it (F6/F7)
  |     block {reason} -> (8) as deny
  |     no block      -> shadow execute() runs
  v
shadow tool execute() (pi.registerTool, F5)
  | (6) input.__agyGate true  -> DO NOT EXECUTE; return synthetic result
  |     input.__agyGate absent -> delegate to captured real builtin
  v
provider
  | (7) tool result completes the parked /approval response
  v
hook script
    (8) stdout {"decision":"allow"} or {"decision":"deny","reason":"..."}
        -> agy enforces; reason reaches agy's model
```

Component notes:

- **Staging** (`src/approval-hook.ts`, new): writes `.agents/hooks.json` into the workspace when approvals are enabled. Merge-safe: if the file exists, merge our named hook group (`pi-bridge-gate`) into it; never clobber without a timestamped backup (the 2026-09-05 incident is the reason every destructive path here needs guards). Matcher over agy mutating tool names only.
- **Hook script**: small bundled script; reads stdin, POSTs to the bridge, long-polls the terminal decision, prints it. Human latency exceeds any sane hook `timeout` (docs default 30s), so use the early-ack pattern proven in the G9 round-trip store: POST returns a ticket immediately; script polls until terminal or its own deadline.
- **Park** (`src/mcp-server.ts`): `POST /approval` (token-authed, same shared-secret header as G9) parks with an id; `GET /approval/<id>` polls. Timeouts reuse G9 park semantics and the `AcpDriver` budget pause (overall timer paused while parked, per-park timeout, escalation-aware early-ack).
- **Shadow tools**: register `bash`, `write`, `edit` via `pi.registerTool` with builtin-identical schemas (F5). Capture real definitions first (`pi.getAllTools()` before registering); delegate in `execute()` when the marker is absent. Marker branch returns a synthetic result; NOTHING executes twice.
- **Decision mapping**: `tool_call` block `{reason}` -> deny with that reason. Tool error -> deny with error text (fail-closed). Synthetic success -> allow. Park/poll timeout -> deny (fail-closed). Optional later: `permissionOverrides` passthrough.
- **Input mutation caveat**: permission extensions may rewrite `event.input` (documented pi behavior). The gate then applies to the rewritten command, which is correct; the synthetic result must reflect the post-mutation input.
- **Fallback policy** (no permission extension installed): `approvals.mode: ask | allow | deny`. `ask` uses `ctx.ui.confirm` guarded by `ctx.hasUI`. Headless (`hasUI` false) = deny, fail-closed, matching every audited package.

Tool mapping (agy native -> shadow surface):

| agy native tool | Shadow tool | Input fields |
|---|---|---|
| `run_command` | `bash` | `{command, cwd}` from `CommandLine`, `Cwd` |
| `write_to_file`, `create_file` | `write` | `{path, content}` from `TargetFile`, `CodeContent` |
| `replace_file_content`, `multi_replace_file_content`, `edit_file` | `edit` | `{path, edits}` from `TargetFile`, `ReplacementContent`/`ReplacementChunks` |
| `view_file`, `list_dir`, `grep_search`, `find_by_name` (read-only) | ungated | leave out of the hooks matcher |

Config (add to `src/config.ts`): `approvals.gateMode: "shadow" | "dedicated" | "off"` (default `off` until verified; `shadow` is the recommended end state) and `approvals.mode: "ask" | "allow" | "deny"` (fallback policy). `dedicated` mode = single registered tool `antigravity_approve` with input `{toolName, args}`, for setups that prefer explicit names (gotgenes `shellTools` alias). Sample gate extension snippet to ship in docs:

```typescript
export default function (pi) {
  pi.on("tool_call", async (event) => {
    if (event.input?.__agyGate && event.input.command?.startsWith("rm ")) {
      return { block: true, reason: "rm is not allowed through the agy gate" };
    }
  });
}
```

Scope notes:

- Works on BOTH engines: hooks are a workspace-level Antigravity feature; the stream-json CLI fires them per Google docs. ACP firing is live-verified (F1); stream-json firing is docs-attested, verify opportunistically.
- Read-only agy tools stay ungated (low risk, keeps latency down).
- Gate B (usage tokens absent on ACP RC01) remains the ONLY default-flip condition for the engine default. This work neither helps nor blocks it.

### 2.6 Data shapes

Bridge park: `POST /approval`, header `x-bridge-token`, body = the hook stdin JSON verbatim. Immediate response: `{"ticket":"<id>"}`. Poll: `GET /approval/<id>` -> `{"status":"pending"}` until terminal `{"decision":"allow"}` or `{"decision":"deny","reason":"..."}`.

Shadow toolUse (composed by provider): `{toolUse: {id: <callId>, name: "bash", input: {command: "<CommandLine>", cwd: "<Cwd>", __agyGate: true, __agyTicket: "<id>", __agyTool: "run_command"}}}`. Underscore-prefixed fields are marker/context; audited extensions match only their known fields and ignore unknown ones.

Hook stdout (terminal): `{"decision":"allow"}` or `{"decision":"deny","reason":"<text>"}`. `reason` MUST be present on deny: it is the only feedback agy's model gets.

### 2.7 Audit trail

Every parked approval writes to `src/daily-log.ts`: timestamp, engine, conversationId, agy tool name, shadow name, command/path summary (redacted per existing rules), decision, source (extension block vs fallback policy vs timeout), latency. Timeout-sourced denies log at warning level.

### 2.8 Work items, in order

Verification first (cheap and load-bearing):

- [ ] **V1 - Shadowing pin test.** Unit-test the shadow factory: marker branch returns the synthetic result without executing; non-marker delegates to the captured builtin; schema passes through unchanged. Plus a manual smoke in pi: register a trivial `bash` shadow via a scratch extension; confirm builtin behavior survives for normal calls.
- [ ] **V2 - ACP deny-semantics probe.** Copy `~/tmp/pi-antigravity-bridge-probes/probe-acp-customizations.mjs`; change the hook to return `{"decision":"deny","reason":"gate-test"}` on `create_file`; run one live turn asking agy to create a file. PASS = file NOT created AND `reason` visible to the model (response text / conversation DB). Run the timeout case (V3) in the same harness.
- [ ] **V3 - Hook timeout behavior.** Hook sleeps past its `timeout`; observe what agy/ACP does (proceed, deny, or error surface). The early-ack/poll design must be validated against the observed behavior.

Implementation:

- [ ] `src/approval-hook.ts`: hooks.json staging (merge-safe, backup-on-clobber), hook script bundling, cleanup on disable.
- [ ] `POST /approval` + `GET /approval/<id>` in `src/mcp-server.ts` (token auth, ticket park, early-ack).
- [ ] Shadow tool factory + registration (`bash`, `write`, `edit`), builtin capture + delegation, `__agyGate` branch.
- [ ] Provider wiring: parked approval -> toolUse turn -> result -> park completion (mirror the G9 park plumbing).
- [ ] Config plumbing (`approvals.gateMode`, `approvals.mode`) in `src/config.ts`.
- [ ] `daily-log.ts` audit entries (2.7).
- [ ] Tests on the fake ACP server harness (`tests/helpers/fake-acp-server.mjs`): PreToolUse-shaped frames, park/toolUse/decision round-trip, extension-block path, timeout-deny path.
- [ ] Docs: README user section + sample gate extension snippet (2.5).

### 2.9 Artifacts and references (2026-09-07 session)

- ACP customization probe script: `~/tmp/pi-antigravity-bridge-probes/probe-acp-customizations.mjs` (kept out of the repo on purpose; the repo stays clean of probe scaffolding until this work lands). Traffic: gitignored `probe-logs/acp-customizations-traffic.jsonl`. Probe workspace: `~/tmp/acp-probe-ws` (keep for V2/V3).
- Permission package sources: `~/tmp/pi-perm-research/` (10 packages). General top-10 extension audit: `~/tmp/pi-ext-research/`.
- pi source references: `dist/core/agent-session.js` `_refreshToolRegistry` (~2114), `dist/core/extensions/loader.js` `registerTool` (~238), `docs/extensions.md` tool_call section (~778) and examples (`permission-gate.ts`, `protected-paths.ts`).
- Antigravity docs: `antigravity.google/docs/hooks/`, `/docs/plugins/`, `/docs/cli/headless/`. Upstream headless bugs to track: `google-antigravity/antigravity-cli` #548 (print mode ignores allow rules AND hook allows; deny honored) and #794 (auto-denied tool still exits 0 with `status: SUCCESS`).
- Findings mirrored in agentmemory (search: "approval-gate DESIGN v2", "PROBED LIVE 2026-09-07").
