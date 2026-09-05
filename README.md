# pi-antigravity-bridge

A Gemini model provider **and** the `AskAntigravity` delegation tool for [pi](https://github.com/earendil-works/pi-coding-agent), built on Google's official Antigravity binaries: the `agy` CLI by default, or **Google's official ACP server** (opt-in). It registers `antigravity/gemini-*` models in pi's `/model` picker (streaming), and provides the `AskAntigravity` tool for one-shot delegation - the same combined shape as `pi-claude-bridge`.

<img width="2566" height="1723" alt="SCR-20260903-sefo" src="https://github.com/user-attachments/assets/20f0c04c-d622-4b11-962a-3478f64570c2" align="center"/>

<br/><br/>

<img width="1272" height="842" alt="SCR-20260903-sfcu" src="https://github.com/user-attachments/assets/c483613b-10ff-4d2f-9893-027d84130ac6" align="center" />

If you also have [`@estebanforge/pi-ask-antigravity`](https://github.com/EstebanForge/pi-ask-antigravity) installed, this bridge takes over: pi-ask-antigravity detects the bridge and registers nothing, so the `AskAntigravity` tool is never duplicated.

## What it does

You pick a Gemini model in pi's `/model` picker. pi routes each turn through this provider. A single persistent `agy` process runs in your workspace; pi feeds it each turn, parses its stream-json events, and streams the agent text back into pi token by token. Token usage is live.

Multi-turn works. The provider binds a pi session to an agy conversation id (persisted under `~/.pi/agent/antigravity-bridge/sessions.json`) and resumes it on the next turn via `--conversation <id>`. agy keeps its own history, so only the latest user message is sent each turn.

### Two engines

Turns run through one of two engines behind the same provider surface (`config.engine`, default `stream-json`):

- **stream-json** (default): the persistent `agy` CLI process. The tested default; live token usage; conversation resume via `--conversation`.
- **acp**: Google's official ACP server (`agy_acp_server.par`), JSON-RPC 2.0 over stdio. Opt-in while it matures: the current build (RC01) ships no usage fields (token display shows zero) and no cancel (abort tears the server down and reloads it next turn). Everything else is parity-verified live - text streaming, multi-turn resume via `session/load`, bridge tools, effort switching, serialization, abort recovery - see `scripts/parity-live.mjs`.

Engine-dependent features: pi image attachments ride natively only on the ACP engine (the picker offers image attach automatically when `config.engine` is `acp`; the stream-json CLI prompt is text-only). With the optional G1 digest enabled, its delivery also differs: ACP ships it as a native `embeddedContext` resource block, stream-json prepends it to the prompt text. The `AskAntigravity` delegation tool is unaffected by `config.engine` and runs the `stream-json` CLI (`agy -p`) across both configurations.

| Capability | `stream-json` (default) | `acp` |
| --- | --- | --- |
| Show thinking text | No (token count only, floor 64, no text body) | Yes (streams thought text via `agent_thought_chunk`; sparse on RC01 where reasoning often arrives in message text) |
| Live token usage | Yes (live metrics from CLI step events) | No (absent in RC01, displays zero tokens) |
| Image prompt input | No (CLI prompt is text-only; images dropped) | Yes (native image blocks forwarded to server) |
| Audio prompt input | No (dropped) | Protocol advertised (`promptCapabilities.audio: true`) |
| Review-only plan mode | Yes (`--mode plan` review-only via `/agy mode plan`) | No (RC01 modes are permission levels; plan mode refused) |
| Leading slash commands in prompt | Disabled via `--disable-slash-commands` (sent as plain text) | Server intercepts recognized commands (e.g. `/plan`) and executes them under the active policy |
| Dynamic model / effort switch | Recycles process on model or effort change | Dynamic per-turn via `session/set_config_option` (no restart) |
| Process lifecycle | 1 persistent `agy` process per provider; recycles on drift | 1 persistent server process hosting N sessions concurrently |
| Session resume & persistence | Client-side map in `sessions.json` via `--conversation <id>` | Server-side session store via `session/load` and `session/new` |
| Turn cancel / abort | Kills process group; in-flight turn terminates | Teardown, kill, and auto-reload on RC01 (-32601 fallback) |
| MCP tool bridge routing | Injected filesystem config via `--add-dir` | Direct `mcpServers` param in `session/new` and `session/load` |
| Tool execution & visibility | Native re-exec (read-only) + wrapper replay (mutating) | Server executes tools natively; events stream with content |
| Inline file edit diffs | Sourced from git working tree in thinking block | Sourced from `tool_call content[]` or disk vs git HEAD |
| Permission handling | `--dangerously-skip-permissions` (unattended CLI requirement) | Protocol-native `session/request_permission` (auto-approve when `skipPermissions` is on; auto-deny when off) |
| Context digest delivery (G1) | Prepend plain text inline in prompt | Native `embeddedContext` resource block |
| System prompt delivery (G10) | Prepend to first prompt of conversation | Prepend to first prompt of conversation |
| Authentication methods | Inherits existing `agy` CLI OAuth state | 4 methods: `oauth-personal`, `oauth-business`, `gemini-api-key`, `agent-platform` |
| Wire protocol | Undocumented CLI NDJSON stream format | Versioned JSON-RPC 2.0 over stdio (`protocolVersion: 1`) |
| Diagnostics (`/agy doctor`) | Child PID, state, process spawns, recycles, queue stats | Server version, agentInfo, session counts, reconnect count, cancel support |
| Integration channel | Spawns internal CLI stream-json dialect | Official Google first-party ACP server binary |

Switch with `/agy engine acp|stream-json` (takes effect on restart). Setup is automatic: switching to `acp` installs Google's official ACP server binary from the [antigravity-acp registry entry](https://github.com/agentclientprotocol/registry) (`~/.local/opt/agy-acp/<build>/` + a `current` symlink, zip sha256 recorded; layout and pinning in [docs/ACP-ADOPTION-PLAN.md](docs/ACP-ADOPTION-PLAN.md)) and prepares the login. The login is your Antigravity subscription: the same account and plan you use for the Antigravity CLI (`agy`). Sign in explicitly with `/agy auth` (engine `acp` selected): it opens the Google login in your browser and completes when you finish it. If no browser is available (an SSH session on a remote machine), pi shows the sign-in URL to copy, plus the ssh port-forward command for the login redirect. It is no different from logging into the CLI; the server just keeps its own token file on your machine, like any Google tool, and this extension never sees your credentials. If you also export `GEMINI_API_KEY`, it is ignored: the server uses the auth type in settings.json, and setup always writes `oauth-personal`. A session start self-heals the same way, silently when everything is ready. Manual instructions (`/agy auth-manual`) surface only when a step fails. Sessions are engine-scoped, so switching engines never crosses conversations.

## What it cannot do

agy runs its own closed tool loop (`read_file`, `write_file`, `edit_file`, `run_command`) against `--add-dir`. Its read-only steps (`view_file`, `list_dir`, `grep_search`, `find_by_name`) re-run as real pi builtins (`read`, `ls`, `grep`, `find`) so their cards render natively; mutating steps never execute in pi - they replay through a display-only `antigravity` wrapper tool. What used to be a hard wall for pi's other tools is bridgeable; see [MCP tool bridge](#mcp-tool-bridge-agy-uses-pis-tools) below.

Residual limits (with or without the bridge):

- agy's own edits still land directly on disk; pi's inline diff review does not engage for them.
- agy commands run without per-action approval, same as every other tool in pi. See [Permissions](#permissions) below.
- No cost accounting: cost stays zero because agy runs on your subscription quota. Token usage is live.

## MCP tool bridge (agy uses pi's tools)

While agy is the active model it normally cannot see pi's universe of extensions: agentmemory, codegraph, web search, slack/asana, the `Ask*` delegations, and any other installed pi tool. This extension optionally bridges that gap.

The bridge starts a localhost MCP server inside pi's process. `tools/list` returns pi's registered tools (built-in file/shell tools and `AskAntigravity` are filtered out), and a `tools/call` routes into pi's own tool loop via the round-trip described below. agy discovers the server through a per-invocation config: the bridge writes `.agents/mcp_config.json` into a bridge-controlled dir (`~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/`) and the provider passes that dir as an extra `--add-dir` when it spawns agy. The user's global agy config (`~/.gemini/config/mcp_config.json`) is never touched, so standalone agy outside pi is unaffected.

**No patch required.** Bridge calls park in the provider's round-trip store; the provider ends the pi assistant message with a `toolUse` stop reason for the real pi tool, pi executes it in its own loop (native cards, permissions, hooks), and the toolResult completes the parked MCP response on the next stream call. This is the same mechanism tianzuo/pi-antigravity uses; upstream pi APIs only.

**Recursion safety.** Only the provider's agy receives the extra `--add-dir`. The `AskAntigravity` tool spawns its own agy with just the workspace, so that inner agy starts plain (no pi tools) and cannot re-enter. `AskAntigravity` is also filtered from the exposed tool list. Standalone agy is unaffected because nothing is written to its global config.

**Cost / fan-out.** Every registered pi tool except builtins (and `AskAntigravity`) is exposed, including other delegation tools like `AskClaude`/`AskCodex`. agy can therefore chain into other models via the bridge, which is a new cost/time fan-out vector that did not exist before this feature.

**Security.** The MCP server binds to `127.0.0.1` only and requires a per-session shared-secret header (`x-bridge-token`) that agy sends from the bridge config; browsers cannot set custom headers on a simple cross-origin POST, so this blocks web CSRF against the loopback server. Request bodies are size-capped. This is intended for single-user developer machines: any local process running as the same user can read the token from the per-pid config and call the exposed tools, so do not run it on a shared host where you do not trust other same-user processes.

### Native cards, wrapper replay, and skills

Read-only agy steps (view_file, list_dir, grep_search, find_by_name) re-run as
real pi builtins (`read`, `ls`, `grep`, `find`) when those builtins are active,
so their cards render with pi's own renderers. Mutating and agy-specialty steps
render through a display-only `antigravity` wrapper tool: its `execute()`
replays the output agy already recorded, so the transcript gets proper
toolCall/toolResult pairs without any double execution. Neither path re-runs
anything with side effects.

When the bridge is on, agy also gets one `activate_skill` tool whose enum is
your pi Agent Skills catalog; calling it returns the SKILL.md body. The bridge
answers it directly, no pi round-trip. `/agy doctor` prints driver counters,
bridge port, and the last lifecycle events without spending tokens.

## Install

> **No patch required.** The bridge runs on pi's public APIs only; the extension never edits your pi install. If an older version of this extension patched your pi (adding `pi.invokeTool()`), the leftover is inert and a pi update removes it. The extension detects it once and offers `/agy patch-cleanup` to restore the original files from the backup immediately.

Install with pi's package manager:

```bash
pi install npm:@estebanforge/pi-antigravity-bridge
```

Requires the **`agy` CLI** installed and authenticated. If you don't have it, follow Google's [official install guide](https://antigravity.google/docs/cli/install) for your platform, then run `agy` once to complete Google OAuth. The extension resolves `agy` on `$PATH`, or via the `AGY_BIN` environment variable.

## Usage

Pick a model and talk to pi as usual:

```
/model
```

Look for the models namespaced as: antigravity

Or specify a model directly:

```
/model antigravity/gemini-3-6-flash-medium
```

Model ids are slugified from the `agy models` output (`Gemini 3.6 Flash (Medium)` becomes `gemini-3-6-flash-medium`). Discovery runs once at extension load. Run `/reload` after an `agy update` to refresh the list.

If `agy models` fails at load (binary missing, auth not done, network stall), a fallback catalog still populates the picker so you get a clear runtime error instead of an empty list.

### Bridge surface

`config.json` selects the bridge surface:

| Key | Values | Default |
| --- | --- | --- |
| `askTool` | `on` (register the AskAntigravity delegation tool), `off` (no delegation tool; provider and models only) | `on` |
| `bridgeTools` | `none` (bridge off), `all` (every non-builtin tool, incl. other `Ask*` delegations), `mcp` (pi-mcp-adapter tools + skills bridge only) | `all` |
| `digest` | `off` (stable prompts; agy's prompt cache hits) or `on` (inject a delta of pi-side context - compaction summaries, other-provider turns - into each agy prompt; the delta changes every turn, so agy re-bills the full context). Enable for mixed-provider sessions where agy must see pi-side context | `off` |
| `systemPrompt` | `on` (prepend pi's system prompt - operating instructions plus the global agent-dir `AGENTS.md` and ancestor `AGENTS.md`/`CLAUDE.md` - to the first prompt of each new agy conversation, plus a tool-priority note: Pi Bridge tools win over agy's native interactive ones, which never reach the user) or `off` (agy-native behavior) | `on` |

Env overrides: `AGY_BRIDGE_TOOLS`, `AGY_ASK_TOOL`, `AGY_DIGEST`, `AGY_SYSTEM_PROMPT`. Env wins over the file, so while `AGY_DIGEST` or `AGY_SYSTEM_PROMPT` is set, the matching `/agy digest` or `/agy system-prompt` toggle persists a value that never takes effect.

The `activate_skill` catalog mirrors pi's directory-based skill discovery: the two global dirs plus project dirs, the latter only when pi has trusted the project (same gate pi itself applies). Pi's other skill sources - the `skills` settings array, `package.json` entries, and `--skill` CLI paths - are not mirrored and won't appear in the catalog.

### The /agy command

`/agy` configures the provider at runtime. Settings persist to `~/.pi/agent/antigravity-bridge/config.json` and take effect on the next turn.

```
/agy                      status, or open the full settings picker (TUI)
/agy status               print current settings + session counts
/agy doctor               bridge state, driver counters, bridge port, last lifecycle events
/agy auth                 run the antigravity-acp sign-in now (engine acp): opens the Google login in your browser, shows the URL when no browser opens
/agy mode plan            review-only: agy plans but writes nothing
/agy mode accept-edits    agy applies edits directly (default)
/agy permissions on|off   auto-approve / prompt for tool calls (see warning)
/agy ask on|off           register the AskAntigravity delegation tool (default on; off keeps only the provider and models, even with pi-ask-antigravity installed)
/agy model flash|pro|gemini   fallback model for the AskAntigravity tool; callers may override per call
/agy thinking low|medium|high fallback thinking tier for the AskAntigravity tool; callers may override per call
/agy digest on|off        inject pi-side context into agy prompts (default off; see table above)
/agy system-prompt on|off send pi's system prompt + AGENTS.md + the Pi Bridge tool-priority note to new agy conversations (default on)
/agy bridge all|mcp|none  which pi tools the MCP bridge exposes to agy (default all; none = bridge off)
/agy acp-bin <path|auto>  point the ACP engine at a specific server binary (auto = setup installs, or AGY_ACP_BIN; applies on the next ACP turn)
/agy engine acp|stream-json   switch the turn engine (restart to apply; default stream-json; acp runs self-service setup: binary install + auth bootstrap)
/agy auth-manual             manual ACP credential setup (fallback; auto-setup normally covers this; default login = your Antigravity subscription, same account as the agy CLI)
/agy patch-cleanup        restore the original pi files if an older version patched them
/agy clear                drop all session bindings (force fresh conversations)
```

### Permissions

pi itself has no built-in approval gate. Unlike codex, claude, or agy running interactively, pi does not prompt you to confirm each tool action before it runs. That is the host environment this extension lives in.

Because agy runs non-interactively under this provider (nothing can answer a `y/n` prompt), this extension passes `--dangerously-skip-permissions` by default. It is technically necessary: `accept-edits` auto-approves file edits but not shell commands, so a `run_command` would otherwise hang forever waiting for a prompt nothing can answer (upstream [google-antigravity/antigravity-cli#318](https://github.com/google-antigravity/antigravity-cli/issues/318)). The net effect is that agy executes commands the same way pi already executes your other tools: without per-action review.

If you want agy to execute nothing, use `/agy mode plan`. Do not combine `--sandbox` with skip-permissions ([#36](https://github.com/google-antigravity/antigravity-cli/issues/36)).

### Run pi inside a sandbox

For isolation when running any agent that executes commands without a confirmation gate, run pi inside [**construct-cli**](https://github.com/EstebanForge/construct-cli) - EstebanForge's sandbox for AI agents. Isolated container, no path escape, ephemeral filesystem, `strict` / `offline` network modes, secret redaction. The blast radius of a bad command stays in the container, not your host. Install and usage instructions are in that repo.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AGY_BIN` | Path to the agy binary. Defaults to `agy` on PATH. |
| `AGY_ENGINE` | Engine: `stream-json` (default) or `acp`. Wins over the config file. |
| `AGY_ACP_BIN` | Path to the ACP server binary (`agy_acp_server.par`). Defaults to `agy_acp_server.par` on PATH. Wins over `config.acp.bin`. When neither points at a binary, auto-setup installs one. |
| `AGY_EXTRA_ARGS` | Extra args appended to every invocation. Whitespace-split. |
| `AGY_CONVERSATIONS_DIR` | Override the conversations DB directory. |
| `AGY_MODE` | Override execution mode: `plan` (review-only) or `accept-edits` (default). Wins over the config file. |
| `AGY_SKIP_PERMISSIONS` | `1`/`true` (default) to pass `--dangerously-skip-permissions` so commands don't hang on an unanswerable prompt in `-p` mode. `0`/`false` to prompt (hangs any `run_command` non-interactively). Wins over the config file. |
| `AGY_DEFAULT_MODEL` | Default model alias for the `AskAntigravity` tool (`flash`/`pro`/`gemini`, or a tier/version qualifier). Wins over the config file. |
| `AGY_DEFAULT_THINKING` | Default thinking tier for the `AskAntigravity` tool: `low`/`medium`/`high`. Anything else falls back to `medium`. Wins over the config file. |

## Development

Build, test, and debug instructions live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). For the internal architecture (engines, bridge round-trips, conversation discovery) see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Terms of Service notice

Google's [Antigravity ToS](https://antigravity.google/terms) (Section 6) prohibits accessing the service "in connection with products not provided by us", and names as its example using tools like Hermes/OpenClaw with Antigravity OAuth. That targets reusing your credentials in a non-Google harness that calls Google's backend directly.

This extension does not do that. It spawns official, unmodified Google binaries as subprocesses - the `agy` CLI, or the official ACP server when enabled - which perform their own OAuth and make their own calls to Google. This code never sees, extracts, or reuses your token, and never contacts Antigravity's backend. It only reads what the binary itself produces locally: its stream-json output, or its ACP JSON-RPC messages. From Google's server-side view there is no signal that distinguishes "agy launched by pi" from "agy launched by a terminal, an IDE task runner, or cron": same signed binaries, same authenticated calls.

Google's reported enforcement to date (the February 2026 suspensions) targeted token-reuse tools, not spawning the official CLI.

pi-antigravity-bridge practical risk is low, near zero. But not zero: the "in connection with" wording is broad, and Google can suspend accounts at its discretion regardless of whether a breach is provable. Grey area. Safe for now. You should read "news" about this online from time to time.

This is engineering analysis, not legal advice. Use against your own Antigravity account at your own risk; I am not responsible for any consequence to your account.

## License

MIT.
