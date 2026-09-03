# ACP Protocol Reference — `antigravity-acp` (verified live)

Everything below was verified LIVE on 2026-09-03 against the official Google
ACP server, build `agy_acp_server_20260818_01_RC01` (registry id
`antigravity-acp`, v1.0.0), linux-x86_64, on a headless Fedora box. Raw
traffic: `probe-logs/acp-traffic-run5.jsonl` (600 clean JSONL lines,
gitignored). Gate verdicts: [ACP-ADOPTION-PLAN.md](./ACP-ADOPTION-PLAN.md)
section 8.1. Raw SQLite conversation store: `probe-logs/acp-server-conversations/`.

Transport: newline-delimited JSON-RPC 2.0 over the server's stdio. The server
is fully silent until it receives a request. Cold start to `initialize`
response measured ~5-6 s across three runs (1.5 GB binary). Startup flags:
only `--debug` and `--notices` exist. No model/effort/conversation flags:
everything moves through the protocol or `settings.json`.

Data provenance: the captures are SERVER STDOUT only. Requests quoted here
are author-attested — we composed and sent those exact bytes (source: our
stdin writes, preserved in `probe-logs/MANIFEST.md` references and the pi
session) and correlate them with the success/error responses on the capture.
No request echo exists on the wire. Gate F's accepted `mcpServers` shape is
verified this way: those exact bytes were sent and `session/new` returned a
session.

## Method index (verified against this build)

| Method | Status on RC01 |
| --- | --- |
| `initialize` | works |
| `authenticate` | works (param is `methodId`) |
| `session/new` | works |
| `session/set_config_option` | works (param is `configId`) |
| `session/prompt` | works |
| `session/cancel` | **-32601 Method not found. NOT IMPLEMENTED on RC01** |
| `session/load` | works (run 6: `{sessionId, cwd, mcpServers}`; full-text history replay) |
| `session/close` | works (run 6; per-session, connection survives) |
| `session/set_mode` | works (run 6; `modeId`; redundant with `set_config_option("mode")`) |
| `session/request_permission` | observed live (run 6, mode `default` tool probe; agent-to-client REQUEST, once-only options) |
| `session/list`, `session/resume`, `session/fork`, `session/delete` | advertised; not yet probed |
| `fs/read_text_file`, `fs/write_text_file`, `terminal/*` | not observed (our client capabilities were `fs:false`, `terminal:false`) |

## initialize

Request:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{"fs":{"readTextFile":false,"writeTextFile":false},"terminal":false}}}
```

Result (verbatim, capability names):

```json
{"protocolVersion":1,
 "agentCapabilities":{
   "loadSession":true,
   "promptCapabilities":{"image":true,"audio":true,"embeddedContext":true},
   "mcpCapabilities":{"http":true,"sse":true},
   "sessionCapabilities":{"list":{},"resume":{}},
   "auth":{"logout":{}}},
 "authMethods":[
   {"description":"Log in with your Google account","id":"oauth-personal","name":"Log in with Google"},
   {"description":"Log in with your Gemini Enterprise account","id":"oauth-business","name":"Log in with Gemini Enterprise"},
   {"description":"Use an API key with Gemini Developer API","id":"gemini-api-key","name":"Gemini API key"},
   {"description":"Use Gemini Enterprise Agent Platform (formerly Vertex AI) with Application Default Credentials or an API key","id":"agent-platform","name":"Gemini Enterprise Agent Platform"}],
 "agentInfo":{"name":"antigravity-acp","title":"Google Antigravity","version":"agy_acp_server_20260818_01_RC01"}}
```

Types: `promptCapabilities.image|audio|embeddedContext: bool`;
`mcpCapabilities.http|sse: bool`; `sessionCapabilities.list|resume: object`;
`auth.logout: object`; `authMethods[].id` is the string passed to
`authenticate`.

## authenticate

Request (param name is `methodId`, NOT `method` — `method` yields -32602 with
`errors:[{"loc":["methodId"],"msg":"field required","type":"value_error.missing"}]`):

```json
{"jsonrpc":"2.0","id":1,"method":"authenticate","params":{"methodId":"oauth-personal"}}
```

Success result: `{}` (empty object). Failures (verified live):

```json
{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Onboarding failed: The authentication flow did not complete successfully.","data":{"reason":"onboarding_failed"}}}
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Onboarding failed: Timed out waiting for the authentication flow to complete.","data":{"reason":"onboarding_failed"}}}
```

Unauthenticated `session/new` (before any auth) returns:

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required","data":{"message":"No authentication method selected. Either call the `authenticate` method (supports oauth-personal, gemini-api-key, agent-platform), or set `auth.type` in settings.json (/home/<u>/.gemini/antigravity-acp/settings.json) to one of: oauth-personal, gemini-api-key (requires GEMINI_API_KEY env var), oauth-business (Gemini Enterprise; requires gcp.project/location), agent-platform (formerly 'vertex-ai', still accepted; requires GOOGLE_API_KEY, or a project and location from GOOGLE_CLOUD_PROJECT/GOOGLE_CLOUD_LOCATION or gcp.project/gcp.location with Application Default Credentials)."}}}
```

### settings.json shapes (official Zed docs + error message)

```jsonc
// ~/.gemini/antigravity-acp/settings.json
{"auth": {"type": "oauth-personal"}}
{"auth": {"type": "gemini-api-key"}}                       // + GEMINI_API_KEY env
{"auth": {"type": "oauth-business"},  "gcp": {"project": "<ID>", "location": "<REGION>"}}
{"auth": {"type": "agent-platform"},  "gcp": {"project": "<ID>", "location": "<REGION>"}}
```

settings.json is read at server STARTUP: writing it while a server process
runs has no effect on that process (verified: the error persisted until
restart).

### oauth-personal flow (headless, verified end-to-end)

On `authenticate` the server: starts a loopback HTTP listener on
`127.0.0.1:<random port>` (observed 44603, 34653, 59563, 35293 — random per
run), composes a Google OAuth URL, and tries to open a browser. HEADLESS: it
never prints the URL on stdout or stderr (`--debug` stderr stays empty) and
execs nothing (strace-verified). The URL exists only in process memory.
Capture trick (works): set `BROWSER` to a script that appends its argument to
a file, and/or prepend a fake `xdg-open` to `PATH` (see
`probe-logs/capurl.sh`). Remote login: `ssh -N -L <port>:127.0.0.1:<port>
<host>` on the user's machine, then open the URL there; Google's redirect
lands on the server's loopback through the tunnel. NEVER curl the loopback
yourself: a `GET /` without the code param is treated as a failed callback
and aborts the flow ("Authentication failed" page).

Captured URL anatomy (run 5):

```
https://accounts.google.com/o/oauth2/v2/auth
  ?response_type=code
  &client_id=1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com
  &redirect_uri=http%3A%2F%2F127.0.0.1%3A35293%2F
  &scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcloud-platform
        +https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email
        +https%3A%2F%2Fwww.googleapis.com%2Fauth%2Faicode
  &state=<random>
  &access_type=offline
  &prompt=consent
  &code_challenge=<S256>
  &code_challenge_method=S256
```

Timing: the onboarding window is minutes-scale (one flow timed out at ~8.5
minutes; a second completed within ~1.5 minutes). Tokens persist at
`~/.gemini/antigravity-acp/acp_token.json` (0600; 510 bytes; credential —
never copy). A second server run after successful auth has NOT yet been
tested (token-reuse across restart is a remaining probe).

## session/new

Request:

```json
{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"/abs/cwd","mcpServers":[]}}
```

Result (verbatim, this is also the model catalog + config schema):

```json
{"sessionId":"4d5a6c89-0be5-4d98-ac4d-dede75c780fe",
 "modes":{"currentModeId":"default","availableModes":[
   {"id":"default","name":"Default","description":"Default permission prompt flow"},
   {"id":"auto_edit","name":"Auto Edit","description":"Auto-approve file edit tools"},
   {"id":"yolo","name":"YOLO","description":"Auto-approve all tools"}]},
 "models":{"availableModels":[
   {"modelId":"gemini-3.8-flash-high","name":"Gemini 3.8 Flash (High)","description":"gemini-3.8-flash-high"},
   {"modelId":"gemini-3.8-flash-medium","name":"Gemini 3.8 Flash (Medium)","description":"gemini-3.8-flash-medium"},
   {"modelId":"gemini-3.8-flash-low","name":"Gemini 3.8 Flash (Low)","description":"gemini-3.8-flash-low"},
   {"modelId":"gemini-3.7-flash-high","name":"Gemini 3.7 Flash (High)","description":"gemini-3.7-flash-high"},
   {"modelId":"gemini-3.7-flash-medium","name":"Gemini 3.7 Flash (Medium)","description":"gemini-3.7-flash-medium"},
   {"modelId":"gemini-3.7-flash-low","name":"Gemini 3.7 Flash (Low)","description":"gemini-3.7-flash-low"},
   {"modelId":"gemini-3.6-flash-high","name":"Gemini 3.6 Flash (High)","description":"gemini-3.6-flash-high"},
   {"modelId":"gemini-3.6-flash-medium","name":"Gemini 3.6 Flash (Medium)","description":"gemini-3.6-flash-medium"},
   {"modelId":"gemini-3.6-flash-low","name":"Gemini 3.6 Flash (Low)","description":"gemini-3.6-flash-low"},
   {"modelId":"gemini-pro-agent","name":"Gemini 3.1 Pro (High)","description":"gemini-pro-agent"},
   {"modelId":"gemini-3.1-pro-low","name":"Gemini 3.1 Pro (Low)","description":"gemini-3.1-pro-low"}],
  "currentModelId":"gemini-3.7-flash-high"},
 "configOptions":[
  {"currentValue":"gemini-3.7-flash-high","id":"model","name":"Model","category":"model","type":"select","options":[{"value":"gemini-3.8-flash-high","name":"Gemini 3.8 Flash (High)","description":"..."}, "...all 11..."]},
  {"currentValue":"default","id":"mode","name":"Session Mode","category":"mode","type":"select","options":[{"value":"default","name":"Default","description":"Default permission prompt flow"},{"value":"auto_edit","name":"Auto Edit","description":"Auto-approve file edit tools"},{"value":"yolo","name":"YOLO","description":"Auto-approve all tools"}]}]}
```

Key facts:

- `sessionId` is a UUID, chosen by the server.
- The FULL model catalog ships in `session/new` (the `agy models` CLI is not
  needed for the ACP engine). Default model: `gemini-3.7-flash-high`.
- Model ids are FULL slugs with the effort tier baked in
  (`gemini-3.8-flash-low` = Flash, low effort). One `--model`-style split is
  NOT needed here. `gemini-pro-agent` is the 3.1 Pro High slug (differs from
  the CLI's `gemini-3.1-pro-high` print).
- Modes map onto our config knobs: `default` = permission prompt flow,
  `auto_edit` ≈ `--mode accept-edits` for edit tools, `yolo` ≈
  `--dangerously-skip-permissions`.
- `mode` and `model` are both `configOptions` (`type: select`), settable via
  `session/set_config_option`.
- `availableCommands` arrive right after via `session/update`
  (`available_commands_update`): observed commands `plan` ("generates an
  implementation plan artifact and awaits user approval") and `logout`.

## session/set_config_option

Request (param is `configId`, NOT `configOptionId` — wrong name gives -32602
`errors:[{"loc":["configId"],"msg":"field required"}]`):

```json
{"jsonrpc":"2.0","id":5,"method":"session/set_config_option","params":{"sessionId":"<uuid>","configId":"model","value":"gemini-3.8-flash-low"}}
```

Result: the full `configOptions` array with `currentValue` updated
(`"currentValue":"gemini-3.8-flash-low"` observed). LIVE VERIFIED: model and
effort switch per session with no process recycle. Mode switch
(`configId:"mode"`) is expected to work identically (same option shape) but
was not explicitly exercised.

## session/prompt

Request (`prompt` is an array of typed content blocks):

```json
{"jsonrpc":"2.0","id":6,"method":"session/prompt","params":{"sessionId":"<uuid>","prompt":[{"type":"text","text":"Reply with exactly: HELLO ACP. Do not use any tools."}]}}
```

Streaming: `session/update` NOTIFICATIONS (no id), then the `session/prompt`
response. Discriminator is `update.sessionUpdate`.

`agent_message_chunk` (verbatim):

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<uuid>","update":{"content":{"text":"HELLO ACP.","type":"text"},"sessionUpdate":"agent_message_chunk"}}}
```

Terminal response:

```json
{"jsonrpc":"2.0","id":6,"result":{"stopReason":"end_turn"}}
```

Observed stop reasons so far: `end_turn` only. Schema enumerates
`max_tokens`, `max_turn_requests`, `refusal`, `cancelled` (cancelled
unreachable on RC01 — no cancel method).

`available_commands_update` (verbatim):

```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"<uuid>","update":{"availableCommands":[{"name":"plan","description":"Plan carefully before executing a task (generates an implementation plan artifact and awaits user approval)."},{"name":"logout","description":"Log out and clear stored credentials."}],"sessionUpdate":"available_commands_update"}}}
```

### Streaming behavior (300-line and 3000-line stress writes)

- Chunks are pure DELTAS. Verified by content: numbers split mid-token across
  chunk boundaries (`"...\n39\n40\n4"` then `"1\n42\n43..."`), and no chunk
  ever contained a full prefix of the accumulated text. The legacy
  cumulative-resend failure mode was NOT observed over ACP (defensive guard
  stays cheap insurance).
- Throughput: 300 numbers (~600 tokens) completed within one 25 s poll;
  3000 numbers streamed continuously at roughly 100 numbers per 1.5 s.
- Ordering: notifications strictly before the prompt response; no
  interleaving with other responses observed.

### Usage

NO usage/token fields appeared anywhere in `initialize`, `session/new`,
`set_config_option`, `agent_message_chunk`, prompt results, or tool flows
(run 6). Gate B FINAL: ABSENT on RC01. Consequence in the plan: stream-json
is retained as a secondary engine until upstream ships usage (phase-4
deletion conditioned on Gate B lifting).

## session/cancel

**NOT IMPLEMENTED on RC01** (despite appearing in the ACP schema source and
our plan):

```json
{"jsonrpc":"2.0","id":12,"method":"session/cancel","params":{"sessionId":"<uuid>"}}
{"jsonrpc":"2.0","id":12,"error":{"code":-32601,"message":"Method not found","data":{"method":"session/cancel"}}}
```

An in-flight `session/prompt` CANNOT be stopped over the protocol on this
build (verified: a 3000-number stream ran to completion after cancel
returned -32601). Abort fallback candidate: kill the connection and
`session/load` on the next server (probe pending).

## Error shapes (verified)

```jsonc
// -32602 Invalid params (wrong/missing param name) — includes field location
{"code":-32602,"message":"Invalid params","data":{"errors":[{"loc":["methodId"],"msg":"field required","type":"value_error.missing"}]}}
// -32000 server-state errors — message + data{message|reason}
{"code":-32000,"message":"Authentication required","data":{"message":"..."}}
{"code":-32000,"message":"Onboarding failed: ...","data":{"reason":"onboarding_failed"}}
// -32601 method not implemented
{"code":-32601,"message":"Method not found","data":{"method":"session/cancel"}}
```

Note the schema-mismatch pattern: two live params differ from the obvious
names (`methodId` not `method`; `configId` not `configOptionId`). Expect
thirds; code against captured examples, and treat -32602 `loc` as the
correction oracle.

## Server-side persistence (on-disk formats)

`~/.gemini/antigravity-acp/` layout:

| Path | Purpose |
| --- | --- |
| `settings.json` | auth config (world-readable 0644); read at startup only |
| `acp_token.json` | OAuth tokens (0600). CREDENTIAL. Never copy or print. |
| `conversations/<uuid>.db` | SQLite 3 conversation DB (WAL mode; 163 KB main + 4 MB WAL for our probe session) |
| `conversations/<uuid>.db-wal`, `.db-shm` | WAL pair |
| `conversations/<uuid>.meta` | 46-byte JSON: `{"cwd":"<session cwd>"}` |

Session ids match conversation DB file stems (our `sessionId`
`4d5a6c89-0be5-4d98-ac4d-dede75c780fe` → `conversations/4d5a6c89-....db`).

Snapshot DDL (`probe-logs/acp-server-conversations/schema.sql`; 7 tables):

```sql
CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`));
CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));
CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`));
CREATE TABLE `executor_metadata` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));
CREATE TABLE `parent_references` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));
CREATE TABLE `trajectory_metadata_blob` (`id` text DEFAULT "main",`data` blob,PRIMARY KEY (`id`));
CREATE TABLE `battle_mode_infos` (`idx` integer,`data` blob,PRIMARY KEY (`idx`));
```

Two facts matter for us:

1. `steps.step_payload` is an OPAQUE BLOB — the same two-phase-write SQLite
   blob family that silently broke the pre-1.3.2 legacy engine (issue #1).
   Never poll these DBs; that decision is re-validated by this schema.
2. WAL quirk: a read-only open of the live `.db` shows an EMPTY
   `sqlite_master` (schema lives in the WAL until checkpoint); copying
   `db+wal+shm` yields a copy that also reads empty (stale `-shm` suppresses
   replay). To snapshot: `VACUUM INTO` from an opened connection (that is how
   `probe-logs/acp-server-conversations/probe-session-4d5a6c89.db` was made).

## Client capability posture (phase 1 decision, verified harmless)

`initialize` sent `fs:false`, `terminal:false`. Effects observed: `session/new`
and pure-text prompts work; the agent self-executes its own tools and asks
via `session/request_permission` (verified in run 6, tool probe). No `fs/*`
or `terminal/*` delegation occurred with capabilities off.

## Timing summary (Gate E evidence)

| Event | Observation |
| --- | --- |
| Spawn → initialize response | ~5-6 s (three runs, consistent; 1.5 GB binary, page cache warm) |
| session/new response | < 2 s |
| set_config_option response | < 1 s |
| Prompt first chunk | ~1-2 s (Flash, low effort) |
| OAuth onboarding window | minutes-scale; one timeout observed at ~8.5 min |
| Steady RSS | ~327 MB (5 min mixed load; VSZ ~5.3 GB is TCMalloc reservation) |

## Run 6 findings (2026-09-03, post-restart session; raw traffic
`probe-logs/acp-traffic-run6-restart-load-tools.jsonl`, 28 clean JSONL lines)

All remaining probes executed. Results:

1. **Token persistence: PASS.** New server process, `session/load` with NO
   `authenticate` call succeeded. `acp_token.json` + `settings.json` carry
   auth across restarts.
2. **`session/load`: PASS.** Params `{sessionId, cwd, mcpServers}`. On
   success the server REPLAYS the whole conversation as `session/update`
   notifications: `user_message_chunk` / `agent_message_chunk` PAIRS per
   turn, in order. Replay re-sends prior replies as FULL TEXT (one giant
   chunk), not the original deltas. Driver rule: on load, incoming chunks
   are HISTORY replay, never live generation. Then:
   `available_commands_update`.
3. **Config does NOT persist across restart.** The loaded session came back
   `currentModelId: gemini-3.7-flash-high` (default) although it had been
   switched to `gemini-3.8-flash-low` before the kill. Model/effort/mode
   must be re-applied by the driver after every restart/load.
4. **`session/request_permission` verified live.** Agent-to-client REQUEST:
   `{sessionId, toolCall{...full tool_call object incl. diff content...},
   options:[{optionId:"allow",name:"Allow",kind:"allow_once"},
   {optionId:"deny",name:"Deny",kind:"reject_once"}]}`. Client answers:
   `{"outcome":{"outcome":"selected","optionId":"allow"}}`. Only once-kinds
   observed (no allow_always in this payload).
5. **`tool_call` / `tool_call_update` shapes verified.** Fields:
   `toolCallId`, `title` ("Run create_file?"), `kind` (`edit`/`read`),
   `status` lifecycle `pending → in_progress → completed|failed`, `content`
   with `{type:"diff", path, newText, _meta:{kind:"add"}}` (the edit arrives
   AS A DIFF), `locations:[{path}]`, `rawInput` (full args object), optional
   `rawOutput` on completion. Gate C PASS: enough content to retire
   wrapper-replay rendering later.
6. **toolCallId formats are inconsistent:** `33eb71a0...` (32-hex),
   `<sessionId>:7` (composite), `call_859008` (OpenAI-style). Treat as
   opaque strings.
7. **Approved-id supersede quirk.** After `allow`, the approved
   `create_file` call reported `status:"failed",
   rawOutput:"Tool call was approved but never executed."` while the actual
   edit executed under a different toolCallId (`<sessionId>:7`,
   `edit_file`) and succeeded (file created, read back, confirmed).
   Never assume approved toolCallId == executed toolCallId; track effects,
   not ids.
8. **Image prompt: PASS end-to-end.** 1x1 red PNG as `{type:"image",
   data:<base64>, mimeType:"image/png"}` + text question → answer "Red".
   (Community reports said the agy CLI was broken for images; the ACP path
   works.)
9. **Gate F: PASS at shape level.** Accepted entry:
   `{"name":"pi-bridge","type":"http","url":"http://...","headers":[]}`.
   `headers` is a LIST. Permitted types: `http`, `sse` (same headers
   shape), stdio (`command`/`args`/`env`), and an `acp` type (needs `id`).
   A DEAD url is accepted at `session/new` (connection is lazy). Phase-1
   TODO: point at the real bridge (MCP SDK Streamable HTTP) and confirm the
   agent's http client completes `tools/list` + `tools/call` (G9
   round-trip end-to-end).
10. **`session/set_mode` (`modeId`) and `session/close` work** (`{}`
    results). `close` is per-session; the connection survives it.
    `set_mode` and `set_config_option("mode")` are redundant paths to the
    same state.
11. **Usage: ABSENT on RC01 (Gate B final).** No token fields in any
    payload across both runs, including tool flows. Accept zero-usage
    (existing documented fallback); re-check on future builds.
12. **Steady RSS ~327 MB** under 5 minutes of mixed load.

Probe session closed cleanly (`session/close` then kill). Final gate status:
plan section 8.1.
