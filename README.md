# pi-antigravity-bridge - WIP

A Gemini model provider **and** the `AskAntigravity` delegation tool for [pi](https://github.com/earendil-works/pi-coding-agent), both built on Google's `agy` CLI. It registers `antigravity/gemini-*` models in pi's `/model` picker (streaming), and provides the `AskAntigravity` tool for one-shot delegation - the same combined shape as `pi-claude-bridge`.

<img width="3024" height="1774" alt="image" src="https://github.com/user-attachments/assets/9fc2f368-7292-4dde-851b-db2bd579263c" align="center" />

If you also have [`@estebanforge/pi-ask-antigravity`](https://github.com/EstebanForge/pi-ask-antigravity) installed, this bridge takes over: pi-ask-antigravity detects the bridge and registers nothing, so the `AskAntigravity` tool is never duplicated.

## What it does

You pick a Gemini model in pi's `/model` picker. pi routes each turn through this provider. The provider spawns `agy -p` in your workspace, polls the SQLite database agy writes as it works, decodes the protobuf step payloads, and streams the agent text back into pi token by token.

Multi-turn works. The provider binds a pi session to an agy conversation id (persisted under `~/.pi/agent/antigravity-bridge/sessions.json`) and resumes it on the next turn via `--conversation <id>`. agy keeps its own history, so only the latest user message is sent each turn.

## What it cannot do

agy runs its own closed tool loop (`read_file`, `write_file`, `edit_file`, `run_command`) against `--add-dir`. By default pi's own `read`/`write`/`edit`/`bash` do not fire for agy's file and shell work, and that is fine: agy has capable native equivalents. What used to be a hard wall for everything else is now bridgeable; see [MCP tool bridge](#mcp-tool-bridge-agy-uses-pis-tools) below.

Residual limits (with or without the bridge):

- agy's own edits still land directly on disk; pi's inline diff review does not engage for them.
- agy commands run without per-action approval, same as every other tool in pi. See [Permissions](#permissions) below.
- No token usage or cost accounting. agy does not expose token counts, so usage reports as zero.

## MCP tool bridge (agy uses pi's tools)

While agy is the active model it normally cannot see pi's universe of extensions: agentmemory, codegraph, web search, slack/asana, the `Ask*` delegations, and any other installed pi tool. This extension optionally bridges that gap.

When the capability is present the bridge starts a localhost MCP server inside pi's process. `tools/list` returns pi's registered tools (built-in file/shell tools and `AskAntigravity` are filtered out), and `tools/call` executes them via `pi.invokeTool()`. agy discovers the server through a per-invocation config: the bridge writes `.agents/mcp_config.json` into a bridge-controlled dir (`~/.pi/agent/antigravity-bridge/agy-mcp-<pid>/`) and the provider passes that dir as an extra `--add-dir` when it spawns agy. The user's global agy config (`~/.gemini/config/mcp_config.json`) is never touched, so standalone agy outside pi is unaffected.

**Capability requirement.** `pi.invokeTool()` is not (yet) part of upstream pi. On first load with the patch missing, the extension **asks you once** whether to apply it (see [Install](#install)); once applied it activates after a full `pi` restart. Without it the bridge detects the missing capability at load time, skips the MCP server, and everything else works unchanged. See [docs/PI-INVOKETOOL-PATCH.md](docs/PI-INVOKETOOL-PATCH.md) for what the patch is, and `/agy patch status|apply|restore` to inspect, force, or undo it.

**Recursion safety.** Only the provider's agy receives the extra `--add-dir`. The `AskAntigravity` tool spawns its own agy with just the workspace, so that inner agy starts plain (no pi tools) and cannot re-enter. `AskAntigravity` is also filtered from the exposed tool list. Standalone agy is unaffected because nothing is written to its global config.

**Cost / fan-out.** Every registered pi tool except builtins (and `AskAntigravity`) is exposed, including other delegation tools like `AskClaude`/`AskCodex`. agy can therefore chain into other models via the bridge, which is a new cost/time fan-out vector that did not exist before this feature.

**Security.** The MCP server binds to `127.0.0.1` only and requires a per-session shared-secret header (`x-bridge-token`) that agy sends from the bridge config; browsers cannot set custom headers on a simple cross-origin POST, so this blocks web CSRF against the loopback server. Request bodies are size-capped. This is intended for single-user developer machines: any local process running as the same user can read the token from the per-pid config and call the exposed tools, so do not run it on a shared host where you do not trust other same-user processes.

## Install

> ⚠️ **Heads-up: this extension patches your `pi` install.** When it loads and
> the running pi lacks `pi.invokeTool()`, it **asks you once** whether to edit
> files inside your globally-installed `@earendil-works/pi-coding-agent/dist/`
> (adding one method) to enable the MCP tool bridge.
> - **Yes** → applies the patch (reversible via `/agy patch restore`) and tells
>   you to restart pi. The bridge starts on the next launch.
> - **No** → it remembers your choice and stays silent; it won't ask again until
>   you run `/agy patch apply`. The provider and AskAntigravity tool keep working;
>   only the MCP tool bridge stays off.
> - The apply is **idempotent & safe** (only what's missing; aborts cleanly if a
>   pi update moved the code), **backed up** (under
>   `~/.pi/agent/antigravity-bridge/pi-patch-backup/`), and **self-healing** (a
>   `pi` reinstall/update wipes `dist/`; re-applied on the next start).
>
> The patch only takes effect after a **full `pi` restart** (quit + relaunch) —
> `/reload` is **not** enough, because pi caches its compiled core for the
> process. If pi was installed with `sudo`, the first write may need permissions;
> the error message tells you exactly how to fix it. Details in
> [docs/PI-INVOKETOOL-PATCH.md](docs/PI-INVOKETOOL-PATCH.md).

Install with pi's package manager:

```bash
pi install npm:@estebanforge/pi-antigravity-bridge
```

Requires the **`agy` CLI** installed and authenticated. If you don't have it, follow Google's [official install guide](https://antigravity.google/docs/cli/install) for your platform, then run `agy` once to complete Google OAuth. The extension resolves `agy` on `$PATH`, or via the `AGY_BIN` environment variable.

Also requires Node 22.5 or newer (uses the built-in `node:sqlite`).

## Usage

Pick a model and talk to pi as usual:

```
/model antigravity/gemini-3-6-flash-medium
```

Model ids are slugified from the `agy models` output (`Gemini 3.6 Flash (Medium)` becomes `gemini-3-6-flash-medium`). Discovery runs once at extension load. Run `/reload` after an `agy update` to refresh the list.

If `agy models` fails at load (binary missing, auth not done, network stall), a fallback catalog still populates the picker so you get a clear runtime error instead of an empty list.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AGY_BIN` | Path to the agy binary. Defaults to `agy` on PATH. |
| `AGY_EXTRA_ARGS` | Extra args appended to every invocation. Whitespace-split. |
| `AGY_CONVERSATIONS_DIR` | Override the conversations DB directory. |
| `AGY_MODE` | Override execution mode: `plan` (review-only) or `accept-edits` (default). Wins over the config file. |
| `AGY_FILTER_NARRATION` | `1`/`true` to filter agy's "I will ..." narration chunks, `0`/`false` to stream raw. Wins over the config file. |
| `AGY_SKIP_PERMISSIONS` | `1`/`true` (default) to pass `--dangerously-skip-permissions` so commands don't hang on an unanswerable prompt in `-p` mode. `0`/`false` to prompt (hangs any `run_command` non-interactively). Wins over the config file. |
| `AGY_DEFAULT_MODEL` | Default model alias for the `AskAntigravity` tool (`flash`/`pro`/`gemini`, or a tier/version qualifier). Wins over the config file. |
| `AGY_DEFAULT_THINKING` | Default thinking tier for the `AskAntigravity` tool: `low`/`medium`/`high`. Anything else falls back to `medium`. Wins over the config file. |

### The /agy command

`/agy` configures the provider at runtime. Settings persist to `~/.pi/agent/antigravity-bridge/config.json` and take effect on the next turn.

```
/agy                      status, or open the mode/narration/permissions/model/thinking picker (TUI)
/agy status               print current mode, narration, model + session counts
/agy mode plan            review-only: agy plans but writes nothing
/agy mode accept-edits    agy applies edits directly (default)
/agy permissions on|off   auto-approve / prompt for tool calls (see warning)
/agy narration on|off     filter / keep agy's "I will ..." planning chunks
/agy model flash|pro|gemini   default model alias for the AskAntigravity tool
/agy thinking low|medium|high default thinking tier for the AskAntigravity tool
/agy patch status|apply|restore   inspect / force / undo the pi.invokeTool patch
/agy clear                drop all session bindings (force fresh conversations)
```

Narration filtering is on by default. agy interleaves short "I will read the file" planning lines before the real answer; in a streaming transcript those are noise. Turn it off with `/agy narration off` if you want everything agy emits.

### Permissions

pi itself has no built-in approval gate. Unlike codex, claude, or agy running interactively, pi does not prompt you to confirm each tool action before it runs. That is the host environment this extension lives in.

Because agy in `-p` (print) mode cannot answer an interactive `y/n` prompt, this extension passes `--dangerously-skip-permissions` by default. It is technically necessary: `accept-edits` auto-approves file edits but not shell commands, so a `run_command` would otherwise hang forever waiting for a prompt nothing can answer (upstream [google-antigravity/antigravity-cli#318](https://github.com/google-antigravity/antigravity-cli/issues/318)). The net effect is that agy executes commands the same way pi already executes your other tools: without per-action review.

If you want agy to execute nothing, use `/agy mode plan`. Do not combine `--sandbox` with skip-permissions ([#36](https://github.com/google-antigravity/antigravity-cli/issues/36)).

### Run pi inside a sandbox

For isolation when running any agent that executes commands without a confirmation gate, run pi inside [**construct-cli**](https://github.com/EstebanForge/construct-cli) - EstebanForge's sandbox for AI agents. Isolated container, no path escape, ephemeral filesystem, `strict` / `offline` network modes, secret redaction. The blast radius of a bad command stays in the container, not your host. Install and usage instructions are in that repo.

## Development

Build, test, and debug instructions live in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). For the internal architecture (decode pipeline, polling, conversation discovery) see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Terms of Service notice

Google's [Antigravity ToS](https://antigravity.google/terms) (Section 6) prohibits accessing the service "in connection with products not provided by us", and names as its example using tools like Hermes/OpenClaw with Antigravity OAuth. That targets reusing your credentials in a non-Google harness that calls Google's backend directly.

This extension does not do that. It spawns the official, unmodified `agy` binary as a subprocess; `agy` performs its own OAuth and makes its own calls to Google. This code never sees, extracts, or reuses your token, and never contacts Antigravity's backend. It only reads the local SQLite file `agy` writes. From Google's server-side view there is no signal that distinguishes "agy launched by pi" from "agy launched by a terminal, an IDE task runner, or cron": same signed binary, same authenticated calls.

Google's reported enforcement to date (the February 2026 suspensions) targeted token-reuse tools, not spawning the official CLI.

pi-antigravity-bridge practical risk is low, near zero. But not zero: the "in connection with" wording is broad, and Google can suspend accounts at its discretion regardless of whether a breach is provable. Grey area. Safe for now. You should read "news" about this online from time to time.

This is engineering analysis, not legal advice. Use against your own Antigravity account at your own risk; I am not responsible for any consequence to your account.

## License

MIT.
