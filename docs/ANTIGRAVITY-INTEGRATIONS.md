# Antigravity Editor Integrations: Reverse Engineered Internals

Date: 2026-08-21. Sources: the official VSIX `Google.google-antigravity_1.0.0` (marketplace.visualstudio.com/items?itemName=Google.google-antigravity, unpacked at `~/Downloads/Google.google-antigravity_1.0.0`), Zed's external-agents registry cache (`~/Library/Application Support/Zed/external_agents/registry/registry.json`), the ACP release zip from `dl.google.com`, and the binaries installed on this machine. I verified everything below by direct inspection or live execution unless marked otherwise. Section 8 has the reproduction commands.

## 0. Executive summary

Google ships two official mechanisms for driving Antigravity from an editor, plus one hidden one:

1. **Mechanism A, VS Code and JetBrains extension**: the extension spawns `agy --hub`, a local HTTP server that serves the complete Antigravity web UI. The extension embeds that UI in an iframe and the webapp drives the agent over an internal WebSocket protocol. The editor never talks to the agent core. It supplies IDE capabilities (open file, diffs, editor state) through a protobuf RPC bridge carried over postMessage.
2. **Mechanism B, Zed and any ACP client**: Google publishes `agy_acp_server`, a dedicated binary that speaks Agent Client Protocol (ACP) v1, JSON-RPC over stdio. A real programmatic integration: sessions, streaming updates, image and audio prompts, MCP support.
3. **Hidden, `agy agentapi`**: an undocumented subcommand that proxies conversation control into a running Antigravity IDE language server over HTTP via the `ANTIGRAVITY_LS_ADDRESS` environment variable.

There is still no published API for the agent core. The webapp WebSocket protocol behind `--hub` stays internal and undocumented. The ACP server is the closest thing to a sanctioned programmatic surface, and it is new: the current release is dated 2026-08-18, three days before this document.

## 1. Binary inventory on this machine

One assumption needed correcting before any of this analysis could stand: `~/.local/bin/agy` is not a construct wrapper. Codesign settles it in one command:

| Path | Identity | Notes |
|---|---|---|
| `~/.local/bin/agy` | Developer ID Application: Google LLC (EQHXZ8M8AV) | Real Antigravity CLI, Go binary, version 1.1.17, identifier `cli`, signed 2026-08-20 |
| `/Applications/Antigravity.app/Contents/Resources/bin/language_server` | Google LLC (EQHXZ8M8AV) | Agent platform backend, 137.8 MB Mach-O arm64, identifier `language_server` |
| `/Applications/Antigravity IDE.app` | (VS Code fork) | The IDE itself, Electron, standard `cli.js` launcher at `Contents/Resources/app/bin/antigravity-ide` |
| `~/Library/Application Support/Antigravity/bin/agy-node` | shell script | Runs the Antigravity Helper (Electron) as Node: `ELECTRON_RUN_AS_NODE=1 exec ".../Antigravity Helper" "$@"` |
| `~/.gemini/antigravity-cli/bin/agentapi` | shell script, 61 bytes | `exec "/Users/esteban/.local/bin/agy" agentapi "$@"` |
| `~/.gemini/antigravity-cli/bin/webm_encoder` | Mach-O arm64 | Screen recording encoder for screencasts |

The construct wrapper lives inside the sandbox (`/home/construct`), not on the host. On the host, the Google-signed binary sits on PATH directly.

Two distinct `agy` install locations matter:

- `~/.local/bin/agy`: the self-updating CLI install (what `agy install` configures, version 1.1.17 on this machine).
- `~/.gemini/bin/agy`: where the VS Code extension installs its own pinned copy via its auto-installer. Independent of the first. Not present on this machine yet because the VSIX was never activated here.

`--hub` never shows in `agy --help`, even with `AGY_ENABLE_HUB=1` set. The flags exist in the binary anyway: strings include `AGY_ENABLE_HUB`, `hub-port`, and the error text `Retry with a different port: --hub-port <port>.`. Go flag parsing accepts hidden flags, so the extension's spawn works regardless of help visibility.

## 2. Mechanism A: the VS Code extension

The bundle: `extension.js` (11.8 MB of Google Closure/tsickle output with the JSDoc annotations intact, which makes it very readable), `bridge.js` (1.7 MB, the webview-side RPC bridge), `loading_bridge.js` (33 KB, a fallback host-input page), plus an `extension_bin.cjs.map`. The internal Blaze package is `google3.cloud.developer_experience.antigravity_extensions.vscode`.

### 2.1 Install pipeline (binary_downloader)

The class `AntigravityServerManager` implements what its own doc comment calls the "Dynamic Auto-Installation strategy (`~/.gemini/bin/agy`)".

Constants:

- `DEFAULT_RELEASE_BASE_URL = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app'` (production, a Cloud Run service).
- `DOGFOOD_RELEASE_BASE_URL = 'https://storage.googleapis.com/antigravity-public/antigravity-cli'` (used when the `antigravity.channel` config equals `dogfood`).

Manifest resolution:

- If the base URL ends in `.json`, it is fetched directly as the manifest.
- Otherwise the service endpoint form is used: `{base}/manifests/{goos}_{goarch}.json`.
- A valid manifest requires a non-empty string `version` and at least one of `url`, `binaries`, or `platforms`.
- Platform binary lookup: `binaries["{platform}-{arch}"]` first, then a normalized fallback used by public manifests: `win32 -> windows`, `arm64/aarch64 -> arm`, so keys look like `darwin-arm`, `linux-x86_64`, `windows-x86_64`.
- Each binary entry can carry `url`, `sha256`, `sha512`; the downloader verifies hashes when present.
- Download uses `fetch` with redirect following and streams to disk with progress reporting; partial files are deleted on failure.
- Installed target: `~/.gemini/bin/agy` (`.exe` suffix on Windows), via `getInstalledTargetPath()`.

Version gating:

- `verifyBinaryVersion` runs `agy --version` (5 s timeout) and requires semver `gte` against a minimum version; strings containing `dev` or `HEAD` bypass the check.
- `getBinaryVersionString` (3 s timeout) extracts `\d+\.\d+\.\d+[^ \t\n\r]*` from combined stdout+stderr; used for the launch log line.

### 2.2 Hub process lifecycle

Launch sequence in `AntigravityServerManager.start()`:

1. Acquire binary path (auto-install if needed, with progress UI).
2. Allocate an ephemeral port: `net.createServer(); server.listen(0, '127.0.0.1')`, read the assigned port, close the server, reuse the port number. Classic TOCTOU port allocation; the hub prints the retry hint if it loses the race.
3. Build args: `['--hub', '--hub-port=${port}', '--app_data_dir=antigravity']`, then `--add-dir=${folder.fsPath}` for every workspace folder, then any user-configured `antigravity.serverArgs` (see 2.7; this key is read but never declared in the manifest).
4. Spawn with `cwd` = first workspace folder (fallback: extension path) and env:

```
{...process.env,
 HOME: os.homedir(),
 USERPROFILE: os.homedir(),
 AGY_ENABLE_HUB: '1',
 ANTIGRAVITY_VSCODE_HOST: '1',
 ANTIGRAVITY_AUTH_SUCCESS_APP: vscode.env.uriScheme || 'vscode',
}
stdio: ['ignore', 'pipe', 'pipe']
```

5. Readiness poll: HTTP GET the root `http://127.0.0.1:${port}` every 250 ms for up to 15 s; any status code 200-499 counts as healthy (deliberately tolerant, so an auth-required 401 still means "server is up").
6. On exit: log `[LAUNCH ERROR] Server process exited unexpectedly with code ${code}, signal ${signal}`, clear `serverProcess`/`serverUrl` state.
7. `stop()` performs a graceful shutdown with a settle guard so double-stop is safe.

stdout is scanned line by line for the magic prefix `ANTIGRAVITY_OPEN_URL:`; the remainder of the line is parsed as a URI and opened with `vscode.env.openExternal`. That is how OAuth gets out of the hub process and into the browser (see 2.6). All stdout/stderr lines are echoed to the "Antigravity" output channel prefixed `[HUB STDOUT]` / `[HUB STDERR]`; lifecycle messages use `[LAUNCH]`, `[LAUNCH ERROR]`, `[INSTALL]`.

### 2.3 Webview embedding

The sidebar view `antigravity.panel` (activity bar container `antigravity-sidebar`) renders a minimal HTML shell. Key construction, from `renderIframe(webview, serverUrl, options)`:

- Base URL: `new URL(targetRoute || '', serverUrl)`; `targetRoute` allows deep-linking a specific app route.
- Query params set on it: `extensionView=true`, `extensionVariant=vs-code`, `useWebSocket=true`, `hostTheme=${theme}`, `enableMicrophone=false`, `workspaceUri=${first workspace folder uri}`, plus any caller-provided `extraParams`.
- The iframe element: `<iframe id="jetski-frame" src="${fullUrlString}" allow="clipboard-read; clipboard-write" sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox">` with an opacity transition reveal.
- CSP (meta tag): `default-src 'none'; frame-src ${serverUrl} https: http:; script-src ${webview.cspSource} 'unsafe-inline'; style-src ${webview.cspSource} 'unsafe-inline'; connect-src 'self' ${webview.cspSource} https: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*;`
- The shell also loads `bridge.js` as a webview URI (see 2.4) and applies VS Code editor font settings to the host document, forwarding later changes via `updateFontSettings` postMessages.
- Reveal loop: `fetch(fullUrlString)` retried up to 20 times at 1 s intervals; while retrying, the loader text reads `Connecting to Remote Antigravity tunnel (n)...` and after exhaustion `Could not connect to remote port. Please check VS Code Ports tab.` The tunnel wording implies the supported remote scenario is VS Code port forwarding of the hub port, not a second spawn on the remote host.
- A "compatibility modal" in the shell HTML supports an in-place "Update" action, used when the installed binary is older than the extension's minimum (ties into 2.1 version gating).

The critical design fact: `useWebSocket=true` tells the served webapp to talk to the hub over a WebSocket back to `ws://127.0.0.1:${port}` (hence the CSP `connect-src` entries). All agent control traffic, streaming, tool events, and conversation state ride that socket. The editor never sees that protocol.

### 2.4 The postMessage RPC bridge

`bridge.js` runs inside the webview shell (outside the iframe). Constants:

```
AGY_API_CHANNEL: "agy-ext-antigravity-api"        // service: AntigravityApi, implemented by the webapp
EXTENSION_API_CHANNEL: "agy-ext-extension-api"    // service: ExtensionApi, implemented by the editor
ANTIGRAVITY_IFRAME_SOURCE: "antigravity-iframe"   // postMessage source tag from iframe
ANTIGRAVITY_EXTENSION_SOURCE: "antigravity-extension" // postMessage source tag from extension host
```

Wiring (from `getExtensionApi` / `getAntigravity` / the V2 factory `Xe` in bridge.js):

- Inside the iframe, `getExtensionApi()` builds a client for `ExtensionApi` that serializes RPC frames and posts them with `window.parent.postMessage({...frame, source: "antigravity-iframe"}, "*")`, listening on `message` for replies.
- In the webview shell, the bridge receives iframe messages (validated by source tag and frame shape), forwards them to the extension host through the VS Code webview messaging API, and symmetrically delivers extension host messages down into the iframe. Interceptors can override any method on either service (used for the V2 event-emitter merge).
- RPC payloads are protobuf messages from `third_party/gemini_coder/proto/iframe_messages.proto` (proto namespace `gemini_coder.agent_ui_toolkit.iframe`), bundled as a protobuf-es generated module with an embedded `FileDescriptorProto`.

Event surface (the emitter names hard-coded in bridge.js): `onAntigravityReady`, `onDidChangeUrl`, `onDidSendChatMessage`, `onDidStartConversation`, `onDidChangeConversations`, `onKeyboardEvent`, `onMouseEvent`, `onWebviewFocused`.

### 2.5 iframe_messages.proto: complete service surface

I extracted the embedded FileDescriptorProto from bridge.js and decoded it with `protoc --decode=google.protobuf.FileDescriptorProto`. Services:

`AntigravityApi` (implemented by the Antigravity webapp; the editor calls these):

| Method | Request | Response |
|---|---|---|
| GetUrl | UrlQueryMessage | UrlResponseMessage |
| Navigate | UrlNavigateMessage | UrlNavigateResponse |
| SetEditorState | EditorStateMessage | EditorStateResponse |
| SetContextCategories | SetContextCategoriesRequest | SetContextCategoriesResponse |
| InsertSnippet | InsertSnippetRequest | InsertSnippetResponse |
| AddContext | AddContextRequest | AddContextResponse |
| SetTheme | ThemeChangeMessage | ThemeChangeResponse |
| AddSkills | AddSkillsMessage | AddSkillsResponse |
| SetComments | SetCommentsRequest | SetCommentsResponse |
| NewConversation | NewConversationRequest | NewConversationResponse |
| AddFileComment | AddFileCommentRequest | AddFileCommentResponse |
| DeleteFileComment | DeleteFileCommentRequest | DeleteFileCommentResponse |
| EditFileComment | EditFileCommentRequest | EditFileCommentResponse |
| TriggerSend | TriggerSendRequest | TriggerSendResponse |
| SendCommand | SendCommandRequest | SendCommandResponse |
| ListCommands | ListCommandsRequest | ListCommandsResponse |
| SetFileDiffs | FileDiffsChangedMessage | FileDiffsChangedResponse |

`ExtensionApi` (implemented by the editor; the webapp calls these):

| Method | Request | Response |
|---|---|---|
| OnDidChangeUrl | UrlChangeMessage | UrlChangeResponse |
| OnDidSendChatMessage | ChatMessageSentRequest | ChatMessageSentResponse |
| OnDidStartConversation | ConversationStartedRequest | ConversationStartedResponse |
| OnDidChangeConversations | ConversationsChangedMessage | ConversationsChangedResponse |
| OpenUrl | OpenUrlRequest | OpenUrlResponse |
| OpenFile | OpenFileRequest | OpenFileResponse |
| OpenArtifact | OpenArtifactRequest | OpenArtifactResponse |
| OpenSettings | OpenSettingsRequest | OpenSettingsResponse |
| OpenTerminal | OpenTerminalRequest | OpenTerminalResponse |
| OpenDiff | OpenDiffRequest | OpenDiffResponse |
| AddAgentEdit | AddAgentEditRequest | AddAgentEditResponse |
| CloseAllDiffZones | CloseAllDiffZonesRequest | CloseAllDiffZonesResponse |
| ResolveAllAgentEdits | ResolveAllAgentEditsRequest | ResolveAllAgentEditsResponse |
| RequestAgentEditsState | RequestAgentEditsStateRequest | RequestAgentEditsStateResponse |
| RequestDiffZonesState | RequestDiffZonesStateRequest | RequestDiffZonesStateResponse |
| StorageGetItems | StorageGetItemsRequest | StorageGetItemsResponse |
| StorageUpdateItems | StorageUpdateItemsRequest | StorageUpdateItemsResponse |
| ClipboardRead | ClipboardReadRequest | ClipboardReadResponse |
| OnKeyboardEvent | KeyboardEventRequest | KeyboardEventResponse |
| OnMouseEvent | MouseEventRequest | MouseEventResponse |
| OnWebviewFocused | WebviewFocusedRequest | WebviewFocusedResponse |
| GetBrowserNotificationPermissionState | NotificationPermissionQueryMessage | NotificationPermissionStateMessage |
| RequestBrowserNotificationPermission | NotificationPermissionRequestMessage | NotificationPermissionStateMessage |
| ShowBrowserNotification | NotificationRequestMessage | BrowserNotificationResponse |
| ShowNotification | ShowNotificationRequest | ShowNotificationResponse |
| ReportFeedbackMetadata | ReportFeedbackMetadataRequest | ReportFeedbackMetadataResponse |
| ProvideFeedback | ProvideFeedbackRequest | ProvideFeedbackResponse |
| ChangeWorkspace | ChangeWorkspaceRequest | ChangeWorkspaceResponse |
| ExecuteNotebookCells | ExecuteNotebookCellsRequest | ExecuteNotebookCellsResponse |
| GetEditorState | GetEditorStateRequest | GetEditorStateResponse |
| BroadcastComments | BroadcastCommentsRequest | BroadcastCommentsResponse |
| CanResolveConnection | CanResolveConnectionRequest | CanResolveConnectionResponse |
| ResolveConnection | ResolveConnectionRequest | ResolveConnectionResponse |
| OnAntigravityReady | OnAntigravityReadyRequest | OnAntigravityReadyResponse |
| LogTelemetry | LogTelemetryRequest | LogTelemetryResponse |
| GetContextCategories | GetContextCategoriesRequest | GetContextCategoriesResponse |
| QueryContextCategory | QueryContextCategoryRequest | QueryContextCategoryResponse |

Also present in the proto: a `ConnectionResolutionType` enum with at least `RESTART_LS` (ties `ResolveConnection` to restarting the language server).

Read the two tables together and the split is obvious: the editor is an IDE capability server (files, diffs, notifications, storage, clipboard, editor state) plus an event sink, and the webapp owns all agent state. `TriggerSend` is the closest thing to "programmatically send a chat message" from the editor side, and `SendCommand`/`ListCommands` expose a slash-command-like surface to the webapp.

### 2.6 Auth flow

1. Hub starts unauthenticated; when OAuth is needed it writes `ANTIGRAVITY_OPEN_URL:<url>` to stdout.
2. The extension opens that URL externally (`vscode.env.openExternal`).
3. `ANTIGRAVITY_AUTH_SUCCESS_APP` (set to the editor URI scheme, e.g. `vscode`) lets the OAuth landing page deep-link back into the editor after success.
4. Credentials land in `~/.gemini/oauth_creds.json` (mode 600 on this machine) alongside `google_accounts.json`; `~/.gemini/installation_id` and `state.json` hold install identity.

### 2.7 Extension manifest surface (package.json)

- Activation: `onStartupFinished` and `onCustomEditor:antigravity.artifactEditor`.
- Custom editors: `antigravity.artifactEditor` claims filename patterns `antigravity:/**/*.md` and `**/.gemini/*/brain/**/*.md` (agent artifacts and the agent "brain" directory get a rich viewer instead of plain markdown); `jetski.settingsEditor` claims `jetski-settings://**` (internal codename "jetski" = Antigravity).
- Views: single webview `antigravity.panel` in activity-bar container `antigravity-sidebar`.
- Commands: `showThirdPartyNotices`, `resetConversationState`, `insertSnippet` (also `insertTerminalSnippet`, bound not declared), `panel.focus`, `inlineDiff.acceptAll`, `inlineDiff.rejectAll`, `toggleInlineDiff`, `startNewConversation`, `toggleChatFocus`, `dynamic.acceptAgentStep`, `dynamic.rejectAgentStep`, `dynamic.interruptAgent`.
- Keybindings: `cmd+l` / `ctrl+l` context-dependent (editor selection to chat, terminal selection to chat, focus chat, close chat), `cmd+shift+l` new conversation, `alt+enter` accept agent step, `alt+shift+enter` reject, `escape` interrupt while agent running and panel focused.
- Declared configuration: `antigravity.enableTelemetry` (default true, telemetry goes to "Google Cloudmill"), `antigravity.enableInlineDiff` (default true, inline decorations vs side-by-side diff tab), `antigravity.channel` (default `production`, deprecationMessage "Internal channel setting").
- Undocumented configuration: `antigravity.serverArgs`, an array of extra CLI args appended to the hub spawn. Read by the server manager, never declared in `contributes.configuration`. Useful for enabling experimental hub flags without code changes.
- `buildInfo` in the manifest records the internal build system (SrcFS, depot path `//depot/...`).

## 3. Mechanism B: Agent Client Protocol (Zed and others)

### 3.1 Registry entry

Zed ships a local cache of the ACP agent registry at `~/Library/Application Support/Zed/external_agents/registry/registry.json` (upstream: `https://cdn.agentclientprotocol.com/registry/v1/latest/...`). The `antigravity-acp` entry, version 1.0.0, published with release artifacts dated 2026-08-18:

```json
{
  "id": "antigravity-acp",
  "name": "Google Antigravity",
  "version": "1.0.0",
  "description": "Google's AI coding agent",
  "website": "https://antigravity.google/docs/ide/extensions",
  "authors": ["Google LLC"],
  "license": "proprietary",
  "distribution": {
    "binary": {
      "darwin-aarch64": {
        "archive": "https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip",
        "cmd": "./agy_acp_server.par"
      },
      "linux-x86_64": {
        "archive": "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-x86_64.zip",
        "cmd": "./agy_acp_server.par",
        "args": ["--uid="]
      },
      "linux-aarch64": {
        "archive": "https://dl.google.com/agy-extensions/releases/linux/agy-acp-server-agy_acp_server_20260818_01_RC01-linux-arm64.zip",
        "cmd": "./agy_acp_server.par",
        "args": ["--uid="]
      },
      "windows-x86_64": {
        "archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-x86_64.zip",
        "cmd": "./agy_acp_server.exe"
      },
      "windows-aarch64": {
        "archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_20260818_01_RC01-windows-arm64.zip",
        "cmd": "./agy_acp_server.exe"
      }
    }
  }
}
```

Note the Linux-only `--uid=` argument: Zed appends the real uid at spawn time, presumably because a sandboxed environment can't provide one.

### 3.2 Payload

The darwin-arm64 zip is 299.9 MB compressed and contains two files:

- `agy_acp_server.par`, 792,105,680 bytes uncompressed: a Mach-O arm64 executable despite the `.par` extension. It is a self-contained Google-style Python archive (log lines reference `main.py:80`, `settings.py:300`). 755 MB on disk.
- `localharness_external`, 101,551,680 bytes: Mach-O arm64. Name suggests a bundled local test harness; purpose not verified.

`agy_acp_server.par` is codesigned `Developer ID Application: Google LLC (EQHXZ8M8AV)`, identifier `agy_acp_server`.

### 3.3 Verified handshake (live test)

I spawned `./agy_acp_server.par` and sent one JSON-RPC line over stdin:

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}
```

Response on stdout:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},"mcpCapabilities":{"http":true,"sse":true},"sessionCapabilities":{"list":{},"resume":{}},"auth":{"logout":{}}},"authMethods":[{"description":"Log in with your Google account","id":"oauth-personal","name":"Log in with Google"},{"description":"Log in with your Gemini Enterprise account","id":"oauth-business","name":"Log in with Gemini Enterprise"},{"description":"Use an API key with Gemini Developer API","id":"gemini-api-key","name":"Gemini API key"},{"description":"Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials or an API key","id":"agent-platform","name":"Gemini Enterprise Agent Platform"}],"agentInfo":{"name":"antigravity-acp","title":"Google Antigravity","version":"agy_acp_server_20260818_01_RC01"}}}
```

Stderr during the run:

```
I0821 19:24:52.714127 ... main.py:80] Starting AGY ACP Server...
I0821 19:24:52.714230 ... main.py:81] Gemini home resolved to /Users/esteban/.gemini (default; $GEMINI_HOME is unset)
I0821 19:24:52.714300 ... settings.py:300] settings: path=/Users/esteban/.gemini/antigravity-acp/settings.json status=missing
I0821 19:24:52.748428 ... main.py:98] Shutting down AGY ACP Server...
```

Capability decoding:

- `loadSession: true`: clients can resume existing agent sessions.
- `promptCapabilities`: `image`, `audio`, `embeddedContext` all supported in prompts (multimodal input).
- `mcpCapabilities`: `http` and `sse` MCP servers supported.
- `sessionCapabilities`: `list` and `resume`, so session enumeration and resumption are first-class.
- `auth`: `logout` method exists; four auth methods: `oauth-personal` (Google account), `oauth-business` (Gemini Enterprise), `gemini-api-key` (Gemini Developer API key), `agent-platform` (Gemini Enterprise Agent Platform, formerly Vertex AI, via ADC or API key).

### 3.4 ACP method surface

Strings in the binary confirm the standard ACP v1 method set: `session/new` (54 hits), `session/prompt`, `session/load`, `session/update`, `session/set_mode`, `session/cancel`, plus `newSession` and `agentclientprotocol` (449 hits). This is the Zed ACP spec (agentclientprotocol.com), JSON-RPC 2.0 over stdio with `session/update` notifications for streaming agent progress.

What this means concretely: any client that implements ACP (Zed today, any custom harness tomorrow) gets a bidirectional structured channel to Antigravity. Create sessions, prompt with images, audio, embedded context, receive streaming updates, switch modes, cancel, list and resume sessions, manage MCP servers. No browser, no webapp, no SQLite scraping.

### 3.5 Runtime notes

- State lives under the shared Gemini home: `~/.gemini/antigravity-acp/settings.json`, conversations under `~/.gemini/antigravity-acp/conversations/` (created on first session).
- `$GEMINI_HOME` overrides the root, which is how you isolate a bridge instance from your desktop installs.
- The server is Python inside a frozen archive (pex-style; the .par carries readable source under `google3/`), so startup is fast enough for per-session spawns but not free; `sessionCapabilities.resume` plus a long-lived process is the sensible pattern for a bridge.
- The zip has no sha256 pins in the registry entry (unlike some other agents in the same registry; amp-acp pins sha256 per platform). Trust rests on dl.google.com transport plus the Apple code signature.

### 3.6 Additional live findings (second test round, 2026-08-21)

A second test round closed what the first round left open, and added some warnings.

- `session/new` requires authentication. Unauthenticated call returns a descriptive error: `Authentication required ... Either call the authenticate method (supports oauth-personal, gemini-api-key, agent-platform), or set auth.type in settings.json (~/.gemini/antigravity-acp/settings.json) to one of: oauth-personal, gemini-api-key (requires GEMINI_API_KEY env var), oauth-business (Gemini Enterprise; requires gcp.project/location), agent-platform (formerly 'vertex-ai', still accepted; requires GOOGLE_API_KEY, or a project and location from GOOGLE_CLOUD_PROJECT/...)`.
- Critical consequence: the ACP server ignores the desktop OAuth credentials at `~/.gemini/oauth_creds.json`. Its auth is separate, persisted under `~/.gemini/antigravity-acp/settings.json`.
- A stderr warning states: `Environment-based auth selection has been removed. AGY_ACP_ENABLE_OAUTH and a bare GEMINI_API_KEY no l[onger ...]`. Env-var auth was deliberately removed; settings.json or the `authenticate` method are the only paths.
- `session/list` works unauthenticated and returns `{"sessions":[]}` on a fresh install.
- Method naming: the wire method is `session/new` (snake); a `newSession` (camelCase) request yields `Method not found`. Internal handler is `new_session` in `google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py` (~line 2727), auth gate `_assert_authenticated` (~line 2607), per traceback leaked on stderr.
- The server bundles the open-source ACP Python library from `google3/third_party/py/acp` (router/connection/task plumbing visible in tracebacks).
- `localharness_external` presence changes startup behavior; without it, stderr logs `Localharness not found.` (non-fatal). With it present, one run hung >30s at `initialize`.
- Startup reliability was nondeterministic across four runs: 2 of 4 hung at `initialize` indefinitely (with and without localharness), fixed only by killing and respawning. Treat this build (RC01) as experimental.
- Process shutdown: SIGTERM was ignored in tests; SIGKILL was required.

## 4. Hidden: `agy agentapi`

`agy agentapi --help` (works on 1.1.17) prints:

```
Usage: agentapi <command> [args]

Available Commands:
  get-conversation-metadata <conversation_id>
  new-conversation [--model=<flash_lite|flash|pro>] [--title=<title>] [--profile=<profile>] <prompt>
  send-message [--title=<title>] <recipient_id> <content>
```

Behavior: `agentapi` is an HTTP client for a running Antigravity IDE instance. Without configuration it fails with `{"error": "ANTIGRAVITY_LS_ADDRESS is not set"}`. The `ANTIGRAVITY_LS_ADDRESS` environment variable must point at the live IDE language server (the `language_server` binary from `/Applications/Antigravity.app`). The `~/.gemini/antigravity-cli/bin/agentapi` shim exists so other tools (including agent-side scripts) can call it with a stable path.

This is the IDE-attach surface: create conversations in the running IDE, send messages into them, read metadata. Model selectors `flash_lite|flash|pro` confirm the current Antigravity model tiers. Recipient IDs for `send-message` presumably address agents or subagents inside a conversation (unverified beyond the help text).

## 5. Hub WebSocket protocol status

Known: the webapp served by `agy --hub` connects back over WebSocket (`useWebSocket=true`) and that socket carries the agent control plane. Unknown: the message schema, the auth handshake on the socket, and any compatibility guarantee. Nothing in the VSIX exposes it; the schema lives in the webapp bundle served by the hub and in the hub binary itself. Treat it as internal and unstable. Anyone needing programmatic control should use section 3 instead.

## 6. Security observations

- All hub and ACP traffic is loopback-only (`127.0.0.1`, ephemeral port, no TLS; the CSP allows plain `http://localhost:*` / `ws://localhost:*`).
- The webview CSP `connect-src ... https:` is broad: the embedded webapp may call any HTTPS origin from inside the editor.
- OAuth tokens sit in `~/.gemini/oauth_creds.json` with mode 600; multiple Google surfaces (CLI, IDE, extension, ACP server) share the Gemini home, so one compromise exposes all.
- The postMessage bridge uses `targetOrigin "*"` from inside the iframe; risk is contained by the sandbox attributes on the iframe (`allow-scripts allow-same-origin allow-popups allow-forms allow-popups-to-escape-sandbox`) but the pattern is permissive by design.
- Binaries carry Google LLC signatures (EQHXZ8M8AV) with the hardened runtime flag (0x10000).
- The extension auto-downloads and executes binaries from a Cloud Run URL gated only by that service's availability; channel `dogfood` switches to a public GCS bucket. No signature pinning observed in the downloader; hash verification exists only when the manifest supplies hashes.

## 7. Impact on this project (pi-antigravity-bridge)

This ranking predates the adversarial review; section 9 supersedes it where they disagree.

The bridge currently spawns `agy` print-mode and scrapes SQLite WAL step data with a hand-rolled protobuf decoder. The findings above give three surfaces, ranked:

1. **ACP server (recommended)**: `agy_acp_server` is the sanctioned programmatic entry point. JSON-RPC over stdio, streaming `session/update` notifications replace WAL polling, `loadSession`/`list`/`resume` replace the session watermark logic, multimodal prompts and MCP support come for free. Costs: 755 MB binary, download from `dl.google.com/agy-extensions/`, no sha256 pin in the registry. Auth flows through ACP `authenticate` with the four methods from 3.3. The existing provider architecture maps cleanly: pi request -> `session/new` + `session/prompt`, streaming events -> `session/update`, pi tool calls stay local to pi (the ACP agent runs its own tools, same model as today).
2. **`agy agentapi`**: for driving a live IDE Antigravity instance (workspace sessions the human can watch). Thin surface (three commands) but zero reverse engineering needed. Requires the IDE running and `ANTIGRAVITY_LS_ADDRESS` discovery.
3. **`agy --hub` + iframe protocol**: richest surface, but the WebSocket schema is internal and the editor bridge only makes sense inside a real webview host. Not worth it for a headless bridge. The one salvageable trick is `ANTIGRAVITY_OPEN_URL:` stdout handling as an auth pattern reference.

For session continuity work: ACP `sessionCapabilities.list/resume` removes the need for the bridge's own persisted session map on the agy side, though pi-session to ACP-session mapping would still be needed.

## 8. Reproducing these findings

```
# Extension bundle analysis (all offsets refer to extension.js unless noted)
rg -o 'ws://localhost[^"]{0,80}' extension.js                       # CSP entries
rg -o '.{150}http://127\.0\.0\.1.{150}' extension.js                # backendUrl construction
python3 - <<'PY'                                                    # spawn spec + env around serverProcess
data=open('extension.js',encoding='utf-8',errors='replace').read()
i=data.find('this.serverProcess ='); print(data[i-3000:i+500])
PY
python3 - <<'PY'                                                    # extract embedded FileDescriptorProto from bridge.js
import re,base64
b=open('bridge.js',encoding='utf-8',errors='replace').read()
m=re.search(r'file_third_party_gemini_coder_proto_iframe_messages\s*=\s*[^;]*?([A-Za-z0-9+/=]{200,})',b)
open('/tmp/iframe_messages.fd','wb').write(base64.b64decode(m.group(1)))
PY
protoc --decode=google.protobuf.FileDescriptorProto google/protobuf/descriptor.proto < /tmp/iframe_messages.fd

# Binary identity
codesign -d -vv ~/.local/bin/agy
codesign -d -vv /Applications/Antigravity.app/Contents/Resources/bin/language_server

# ACP server live test
curl -sL -o agy-acp.zip 'https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_20260818_01_RC01-darwin-arm64.zip'
unzip agy-acp.zip
( printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":true,"writeTextFile":true}}}}'; sleep 6 ) | ./agy_acp_server.par

# Hidden subcommands
agy agentapi --help
strings ~/.local/bin/agy | grep -E 'AGY_ENABLE_HUB|hub-port'
```

## Appendix: Gemini home layout observed on this machine

```
~/.gemini/
  agy                    (not present yet on this host; VSIX installs here)
  antigravity/           agent platform app data
  antigravity-backup/
  antigravity-cli/       bin/agentapi (shim), bin/webm_encoder, brain/, builtin/, cache/, log/, conversation_summaries.db
  antigravity-ide/       IDE data
  config/                includes memory.txtpb (agent memory)
  history/  prompts/  skills/  tmp/
  google_accounts.json  oauth_creds.json  projects.json  settings.json  state.json  installation_id  trustedFolders.json
  GEMINI.md -> /Users/esteban/Dev/EstebanForge/AGENTS/AGENTS.md
```

## 9. Integration plan: ACP transport for this bridge

Status: proposed. Reviewed adversarially by an isolated reviewer with repo access on 2026-08-21; verdict was "proceed with changes". This section is the binding plan. Where it disagrees with section 7, this section wins.

### 9.1 Goal and framing

Replace the CLI print-mode transport (spawn `agy -p`, poll SQLite WAL, decode protobuf steps) with the official ACP server for pi turns, behind a flag, without weakening the working CLI path until Google ships a non-RC ACP build.

On framing: the obvious pitch, "replaces polling", is the wrong one. The poller is decent code (`PRAGMA data_version` gating, torn-read tolerance). The defects ACP actually fixes:

1. Conversation binding is unreliable on darwin: `procTreeOpenDbResolver` (src/discovery.ts) returns null on non-Linux, so a concurrent agy process can fail a turn with "could not be bound" (src/provider.ts).
2. Protobuf step field numbers are load-bearing and unversioned; every agy release can silently break the decoder (src/protobuf.ts, src/runner.ts).
3. No cancellation semantics beyond process kill.
4. No image input path today.
5. Blanket `--dangerously-skip-permissions` instead of per-action permission control.

### 9.2 Gating condition (Phase 0 exit criteria)

No bridge code gets written until Phase 0 answers all of these from primary sources. The .par contains readable Python source; read it, do not guess:

- [ ] Model selection: does `session/new` (or `session/set_mode`) accept a model parameter? Read `new_session` in `google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py` (~line 2727) and the settings model.
- [ ] Model catalog: what models does the ACP server serve? Same set as `agy models` (incl. claude-*, gpt-oss-*) or a narrower Gemini-only set?
- [ ] Billing identity: does the Antigravity subscription cover ACP sessions under `oauth-personal`, or do some auth methods bill a different quota (Gemini API key, Vertex)? The four auth methods imply different billing paths.
- [ ] Streaming fidelity: capture real `session/update` frames from one authenticated prompt. Confirm tool_call/tool_call_update granularity, diff content blocks, usage/token counts, thinking blocks.
- [ ] Concurrency: do concurrent `session/prompt` calls on one connection serialize (head-of-line blocking)? Measure RSS of the server plus harness.
- [ ] Cancellation: does `session/cancel` actually cancel on the RC build? Measure initialize hang rate over 20 cold runs.
- [ ] Session resume + MCP: does `session/load` accept `mcpServers`? If not, resumed sessions would bind a dead bridge port (ports are ephemeral per process).
- [ ] MCP transport: is `mcpCapabilities.http` Streamable HTTP, and does it accept custom headers (the bridge's token header)?

Kill criteria: if model selection is impossible AND the catalog is narrower than `agy models`, ACP is a downgrade for this bridge regardless of protocol cleanliness. Stay on CLI and revisit when Google ships a non-RC build with session-scoped model selection.

### 9.3 Least-bad model-selection fallbacks (ranked, if no session param exists)

1. Per-session `settings.json` model override under a per-pi-process isolated `GEMINI_HOME`, written before `session/new`, serialized by a lock; model switch = new session. Acceptable only if the source shows the model is read per session, not at process start.
2. Honest degradation: keep CLI as default; under the flag collapse the catalog to a single entry (`antigravity/acp-default`) so the model picker never lies.
3. Per-model server processes: rejected (footprint multiplied by N, auth multiplied by N).

The default transport does not flip until model selection is session-scoped. Advertising `antigravity/*` slugs that ACP silently ignores is the one outcome worse than staying on the CLI.

### 9.4 Phase plan (revised after review)

**Phase 0, verify-before-build (no bridge code):**

- Unzip the `.par` (pex; readable source under `google3/`), read `new_session`, `set_mode`, settings, and auth code paths.
- Run one authenticated prompt (one-time `authenticate` with `oauth-personal`, browser roundtrip), capture `session/update` frames to a fixture file under `tests/fixtures/`.
- Run the kill-criteria checklist in 9.2. Record results in this doc.
- Decide the AskAntigravity question (see Phase 3) now, not later.

**Phase 1, transport behind a flag:**

- New `src/acp/client.ts`: process lifecycle, JSON-RPC stdio framing, initialize/authenticate handshake, first-turn initialize timeout with kill+retry (RC hang observed 2 of 4 runs).
- New `src/acp/acquire.ts`: download and cache the zip (~950 MB unpacked with `localharness_external`). Requirements: explicit user consent before first download, sha256 pinned by this repo (the registry and dl.google.com provide none), version pin with an update check, install under a bridge-owned directory. Never execute an unpinned download.
- Rewrite `src/runner.ts` internals to emit the same event stream from `session/update`; keep the public options/result shape.
- Widen the seam in the same phase, not later: extend the event union with `tool_update` (status, locations), `diff` (native old/new content; skip git reconstruction for these), `usage` (token counts, retire `zeroUsage()` fallback when present), and `mode`. Keeping only today's four event kinds would force Phase 4 rework.
- `src/sessions.ts`: store ACP session id; drop `lastStepIdx` (native resume); keep `lastMessageCount` (digest watermark, independent of steps); add a transport tag per record so a post-flip `get()` never feeds an agy conversation UUID to `session/load` (silent-wrong-resume risk). `narrowStoreMap` must validate the tag.
- `src/provider.ts`: unchanged apart from event-union expansion and digest watermark continuation.
- Cancellation: per-prompt deadline that (a) finalizes pi's stream, (b) marks the ACP session dead in the store, (c) kills and respawns the server (a watchdog kill nukes every concurrent session on that process; document this trade-off). `session/cancel` first, kill as backstop, not the reverse.
- Flag: `PI_AGY_TRANSPORT=acp` (env), CLI default unchanged.

**Phase 2, MCP discovery hop only (shrunk after review):**

- The pi dist patch (src/patcher.ts, docs/PI-INVOKETOOL-PATCH.md) does not retire. It supplies `pi.invokeTool` inside pi; `startMcpServer` hard-gates on it. ACP `mcpServers` replaces only the discovery hop: the `--add-dir` bridge config dir and `mcp_config.json` wiring. Delete that plumbing only.
- Register the existing bridge MCP server through `newSession mcpServers` (transport per the 9.2 checklist; fall back to keeping agy-side config if http-with-headers is unsupported).
- Permission handling: auto-approve only. Interactive forwarding of `session/request_permission` to pi's `ask_user_question` routes through `pi.invokeTool`, the very seam Phase 2 cannot remove; do not promise interactive permissions until pi exposes a provider UI channel.

**Phase 3, default flip and deletions (blocked on two decisions):**

- Blocked by: (a) AskAntigravity (src/ask-tool.ts) spawns `agy -p` directly and imports conversation-dir helpers from src/discovery.ts; it must either migrate to its own ACP session (second concurrent session on the shared server, see 9.2 concurrency) or the CLI path stays and deletions shrink accordingly; (b) model selection session-scoped (9.3).
- After unblocking: flip default to ACP, delete `src/poller.ts` and `src/protobuf.ts`, and delete `src/discovery.ts` only if ask-tool no longer imports it. Own zero or one legacy transport accordingly.

**Auth home (cross-phase requirement):**

- Add an explicit `/agy auth` command (extension entry, where `ctx.ui` exists) that runs the one-time `authenticate` flow before the first turn. `streamSimple` has no UI channel; the provider must fail with a clear "run /agy auth" error when unauthenticated.
- Headless/CI pi: only via `auth.type: gemini-api-key` in settings, which changes billing. Document this, do not hide it.
- Long-lived process: map auth-expiry errors to a reauth instruction; verify token refresh behavior in Phase 0.
- Isolate: run the ACP server under a bridge-owned `GEMINI_HOME` so bridge state never collides with desktop installs.

### 9.5 What does not change

- `src/models.ts` catalog discovery stays on `agy models` until 9.2 answers the catalog question.
- Turn digest (delta of pi-side context agy was not spawned for) stays; ACP sessions hold agy-side context exactly like conversations today.
- `src/diff-render.ts` stays (still needed for edit tools that do not carry native diff blocks).
- CLI print-mode transport stays as default and fallback until the Phase 3 conditions hold. This is time-boxed risk management on an RC build, not permanent compatibility cruft.

### 9.6 Known risks accepted

- RC build quality: initialize hangs (2 of 4 runs), SIGTERM ignored (SIGKILL needed), env auth removed mid-release cycle. Every watchdog and consent gate in this plan exists because of observed behavior, not speculation.
- 755 MB server + 100 MB harness footprint per pi process; measured, not assumed, in Phase 0.
- Zed's registry JSON is a local cache, not a contract; pin downloads to exact dl.google.com URLs with repo-computed hashes.
- No official stability guarantees on any of this until Google documents the ACP server beyond the Zed registry entry.

## 10. Trade-off analysis: ACP transport vs current CLI transport

Comparison of what the bridge gains and pays by moving pi turns from the CLI print-mode path (spawn `agy -p`, poll SQLite WAL, decode protobuf steps) to the ACP server. Every row is grounded in repo code or a live test; nothing speculative. The flag-and-fallback strategy in section 9 keeps this trade reversible at every phase.

### 10.1 What we win

| # | Gain under ACP | Cost today (CLI path) |
|---|---|---|
| 1 | Darwin conversation binding fixed: the session id comes from the protocol itself | `procTreeOpenDbResolver` (src/discovery.ts) returns null on non-Linux, so a concurrent agy process can fail a turn with "could not be bound" (src/provider.ts) |
| 2 | No dependence on unversioned protobuf internals: typed `session/update` frames under a versioned protocol | Decoder relies on magic step_type numbers (14/15/23 plus 9 tool types) and reverse-engineered field numbers; any agy release can silently break decoding (src/protobuf.ts, src/runner.ts) |
| 3 | Native diffs and usage: `tool_call_update` carries status, locations, old/new text, and likely token counts | Diffs are reconstructed from git after the fact (src/diff-render.ts); usage always falls back to `zeroUsage()` |
| 4 | Image and audio input (`promptCapabilities.image/audio/embeddedContext`) | Text-only prompts |
| 5 | Native session list and resume (`sessionCapabilities.list/resume`) | Bridge owns conversationId + step watermark + re-poll skip logic (src/sessions.ts) |
| 6 | Per-action permission requests (auto-approve mode at minimum) | Blanket `--dangerously-skip-permissions` |
| 7 | Streaming without the 250ms poll loop: no torn-read tolerance, no `data_version` coalescing | Modest cost only; the poller (src/poller.ts) is decent code |
| 8 | MCP registration through `newSession mcpServers`, no config-dir hack | `--add-dir` + per-conversation `mcp_config.json` wiring |
| 9 | Official protocol trajectory: public spec (agentclientprotocol.com), consumed by Zed, maintained by Google | The DB schema reverse engineering has no maintainer but this project |

### 10.2 What we pay

1. Footprint: 950 MB (755 MB server + 100 MB harness) versus the ~30 MB CLI; possibly per pi process.
2. Separate auth: one-time browser flow; headless pi needs `gemini-api-key`, a different billing path. The CLI today transparently reuses the desktop login.
3. RC stability tax: hangs at `initialize` (2 of 4 observed runs), SIGTERM ignored, env-based auth removed mid-cycle. Every watchdog in section 9 exists because of observed behavior, not speculation.
4. Process model inversion: one shared long-lived server versus free per-turn isolation; a hang-kill nukes every concurrent session on that process.
5. Download and pinning burden: no hashes published, RC-pinned URLs, Zed's registry is a cache not a contract; this repo owns consent, sha256 pinning, and updates.
6. Two transports to maintain during the transition, until the Phase 3 conditions hold.
7. Cancellation becomes negotiable: today abort is a guaranteed kill of a throwaway process; ACP relies on `session/cancel` on a build that ignored SIGTERM, so the deadline + mark-dead + respawn ladder from 9.4 is mandatory.

### 10.3 Incompatibilities (sharp edges)

1. Model selection: the gating risk. The CLI takes `--model`/`--effort` per turn; ACP v1 may pin the model per session. If so, mid-conversation model switches break (new session, history drop), and the effort tiers in src/models.ts have no known ACP analogue. Phase 0 (9.2) gates on this.
2. Catalog identity unverified: if the ACP server serves Gemini-only, the `antigravity/claude-*` and `gpt-oss-*` slugs die under the flag, and billing may move off the Antigravity subscription.
3. sessions.json schema: agy conversation UUIDs fed to `session/load` would fail or silently resume the wrong session. Requires the transport tag from 9.4; `lastStepIdx` becomes meaningless while `lastMessageCount` (digest watermark) stays.
4. Event union mismatch: ACP's richer blocks (tool_update, diff, usage, mode) do not fit today's four-kind `AgyEvent`; the seam must widen in Phase 1 or Phase 4 pays for it.
5. Conversation data location: ACP sessions live under `~/.gemini/antigravity-acp/conversations` (and under an isolated `GEMINI_HOME` if the bridge isolates). The `decode-db` script, the summaries DB, and any tooling that reads `antigravity-cli/conversations/*.db` goes blind to ACP sessions.
6. Permissions UX: interactive forwarding of `session/request_permission` to pi's question UI is unreachable from the provider path; auto-approve only until pi exposes a provider UI channel.
7. AskAntigravity divergence (src/ask-tool.ts): it spawns `agy -p` itself; either it becomes a second concurrent ACP session or it anchors the CLI path alive (Phase 3 decision).

### 10.4 Net assessment

The trade in one paragraph: we exchange self-maintained reverse engineering (fragile against agy updates, broken binding on macOS, text-only) for an official protocol with real capabilities, and we pay in footprint, auth bootstrap, and RC babysitting until Google stabilizes the ACP server. The flag plus CLI fallback keeps the trade reversible at every phase.

References: extension marketplace page (https://marketplace.visualstudio.com/items?itemName=Google.google-antigravity), Antigravity extensions doc (https://antigravity.google/docs/ide/extensions), ACP spec and registry (https://agentclientprotocol.com, https://cdn.agentclientprotocol.com/registry/v1/latest/).
