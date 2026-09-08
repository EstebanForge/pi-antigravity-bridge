# Engines

Turns run through one of two engines behind the same provider surface (`config.engine`, default `stream-json`). The choice of engine is left to the user: a first-run picker explains the trade-offs and asks once, and `/agy engine` (no arguments, TUI) reopens the same modal anytime. Direct switches work too: `/agy engine acp|stream-json`.

- **stream-json** (default): the persistent `agy` CLI process. The tested default; live token usage; conversation resume via `--conversation`.
- **acp** (beta): Google's official ACP server (`agy_acp_server.par`), JSON-RPC 2.0 over stdio. Beta: parity-verified live against the current build (RC01) - text streaming, multi-turn resume via `session/load`, bridge tools, effort switching, serialization, abort recovery (see `scripts/parity-live.mjs`). Two known RC01 gaps remain: no usage fields (token display shows client-side ESTIMATES until Google ships usage; `acp.usageEstimate` off to keep zeros) and no cancel (abort tears the server down and reloads it next turn).

## First run

On a fresh install (no `config.json` yet), the first interactive pi start opens a picker modal that explains both engines - stream-json needs the `agy` CLI installed and authenticated; ACP needs a second Google sign-in plus a ~1.5 GB server binary downloaded from Google. stream-json is preselected (the default); `esc` decides later (nothing is written, the modal reappears on the next start).

Picking **acp** starts the server download immediately (progress in the status bar, milestones in the chat), then opens the Google sign-in; a restart applies the engine. Picking **stream-json** persists and toasts; while that engine is active and the `agy` binary is missing, pi warns on every start with the install link until the binary shows up.

## Capabilities

| Capability | `stream-json` (default) | `acp` (beta) |
| --- | --- | --- |
| Show thinking text | No (token count only, floor 64, no text body) | Yes (streams thought text via `agent_thought_chunk`; sparse on RC01 where reasoning often arrives in message text) |
| Live token usage | Yes (live metrics from CLI step events) | Estimated client-side (absent in RC01; `acp.usageEstimate`, default on) |
| Image prompt input | No (CLI prompt is text-only; images dropped) | Yes (native image blocks forwarded to server) |
| Image tool results | Yes (bridge tool results carry pixels; probe-verified 2026-09-07) | Yes (probe-verified 2026-09-05) |
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

## Engine-dependent features

pi image attachments ride natively only on the ACP engine (the picker offers image attach automatically when `config.engine` is `acp`; the stream-json CLI prompt is text-only). With the optional G1 digest enabled, its delivery also differs: ACP ships it as a native `embeddedContext` resource block, stream-json prepends it to the prompt text. The `AskAntigravity` delegation tool is unaffected by `config.engine` and runs the `stream-json` CLI (`agy -p`) across both configurations.

## Switching and setup

Switch with `/agy engine acp|stream-json` (takes effect on restart), or run `/agy engine` with no arguments for the same picker modal as first run (an `acp` pick there runs the same download + sign-in chain). Setup is automatic: switching to `acp` installs Google's official ACP server binary from the [antigravity-acp registry entry](https://github.com/agentclientprotocol/registry) (`~/.local/opt/agy-acp/<build>/` + a `current` symlink, zip sha256 recorded; layout and pinning in [docs/ACP-ADOPTION-PLAN.md](ACP-ADOPTION-PLAN.md)) and prepares the login. The login is your Antigravity subscription: the same account and plan you use for the Antigravity CLI (`agy`). Sign in explicitly with `/agy auth` (engine `acp` selected): it opens the Google login in your browser and completes when you finish it. If no browser is available (an SSH session on a remote machine), pi shows the sign-in URL to copy, plus the ssh port-forward command for the login redirect. It is no different from logging into the CLI; the server just keeps its own token file on your machine, like any Google tool, and this extension never sees your credentials. If you also export `GEMINI_API_KEY`, it is ignored: the server uses the auth type in settings.json, and setup always writes `oauth-personal`. A session start self-heals the same way, silently when everything is ready. Manual instructions (`/agy auth-manual`) surface only when a step fails. Sessions are engine-scoped, so switching engines never crosses conversations.
