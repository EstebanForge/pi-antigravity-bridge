# Antigravity Editor Integrations: Reverse Engineered Internals (historical)

Date of original research: 2026-08-21 (full 551-line analysis preserved in git
history; this stub summarizes what still matters). Sources: the official VSIX
`Google.google-antigravity_1.0.0`, Zed's external-agents registry cache, the
ACP release zip from `dl.google.com`, and the binaries on this machine — all
verified by direct inspection or live execution.

> **2026-09-04 status:** the ACP adoption this doc originally planned is
> SHIPPED (phases 0-3 of docs/ACP-ADOPTION-PLAN.md). Everything about the ACP
> server's protocol now lives in docs/ACP-PROTOCOL-REFERENCE.md (far more
> complete than section 3 below); the adoption decision and trade-offs live
> in ACP-ADOPTION-PLAN.md sections 1, 4, and 8.1 (superseding sections 9-10
> here). The VSIX internals below are retained as ecosystem reference only —
> this bridge uses Mechanism B and has no plans to touch Mechanism A.

## The three mechanisms (executive summary)

1. **Mechanism A, VS Code and JetBrains extension**: the extension spawns
   `agy --hub` (hidden flag; `AGY_ENABLE_HUB=1`), a local HTTP server serving
   the complete Antigravity web UI, embedded in an iframe. The webapp drives
   the agent over an internal WebSocket protocol; IDE capabilities flow
   through a protobuf RPC bridge over postMessage. Never documented by
   Google.
2. **Mechanism B, Zed and any ACP client**: Google publishes
   `agy_acp_server`, a dedicated binary speaking Agent Client Protocol v1,
   JSON-RPC over stdio. The sanctioned programmatic surface — this is what
   the bridge's ACP engine drives.
3. **Hidden, `agy agentapi`**: an undocumented subcommand that proxies
   conversation control into a running Antigravity IDE language server over
   HTTP via the `ANTIGRAVITY_LS_ADDRESS` environment variable. Documented
   nowhere else; potential future integration surface, unexamined.

## Facts worth keeping

- Two distinct `agy` install locations exist: `~/.local/bin/agy` (the
  self-updating CLI, what `agy install` configures) and `~/.gemini/bin/agy`
  (where the VS Code extension's auto-installer pins its own copy). They are
  independent and can be different versions.
- The VSIX auto-installer resolves binaries from
  `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/{goos}_{goarch}.json`
  (production) or a GCS dogfood bucket, verifies sha256/sha512 when present,
  and installs to `~/.gemini/bin/agy`.
- The hub process signals OAuth via the stdout prefix
  `ANTIGRAVITY_OPEN_URL:`; the extension opens the URI with
  `vscode.env.openExternal`. (The bridge's ACP auth uses the same
  loopback-redirect OAuth flow via the BROWSER-capture trick — see
  docs/ACP-PROTOCOL-REFERENCE.md.)
- The ACP conversation store is per-session SQLite with opaque
  `steps.step_payload` blobs. Never poll these DBs.
