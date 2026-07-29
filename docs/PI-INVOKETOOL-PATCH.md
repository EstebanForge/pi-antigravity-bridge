# The `pi.invokeTool` local patch

> Status: **local, not upstream.** This is a patch to the installed `pi` package
> that adds one method, `pi.invokeTool(name, args)`, to the extension API. It is
> what lets the pi-antigravity-bridge expose pi's tools to agy over MCP. It is
> small, self-contained, and gated by a runtime capability check, so pi runs
> that lack it are unaffected. An upstream PR is the durable fix (planned).

> **Self-applied by the extension.** As of v1.0.0, on first load with the patch
> missing the bridge **asks you once** whether to apply it (`src/patcher.ts`); if
> you decline it stays silent and won't ask again until `/agy patch apply`, so
> you normally never touch these files by hand. The edits below are documented
> for reference, auditing, and manual recovery. Auto-applier facts:
> - Targets the **running** pi's `dist/` (located via `realpath(process.argv[1])`
>   and verified by anchor presence), never a sibling extension's decoy copy.
> - Idempotent and two-phase: validates all anchors before writing, so a pi
>   version that moved the code aborts cleanly with nothing written. The facade
>   file is written **last**, so a crashed/partial patch leaves
>   `hasInvokeTool()` false (safe degraded), never a half-wired chain.
> - Originals backed up under
>   `~/.pi/agent/antigravity-bridge/pi-patch-backup/<version>-<ts>-<pid>/`.
> - `/agy patch status|apply|restore` inspects, forces, or rolls it back; restore
>   is version-guarded (refuses across pi versions, no silent downgrade).
> - Takes effect only after a **full pi restart** (not `/reload`): pi caches its
>   compiled native-ESM core per process.

This document is written for an LLM (or human) that needs to understand exactly
what was changed, where, and why, without re-deriving it from the codebase.

## What it adds

One new method on pi's `ExtensionAPI`:

```ts
pi.invokeTool(name: string, args?: Record<string, unknown>, options?: {
  toolCallId?: string;
  signal?: AbortSignal;
  onUpdate?: (update: unknown) => void;
}): Promise<{ content: unknown[]; details: unknown; isError?: boolean }>
```

It looks up a registered tool by name and runs its `execute()` **out-of-band**
(not inside an agent turn), returning the same `{ content, details, isError? }`
shape the agent itself produces. Upstream pi already exposes tool *metadata*
(`pi.getAllTools()`) but not tool *execution*; this is the missing sibling.

## Why the bridge needs it

The bridge hosts an MCP server inside pi's process. agy connects to it and asks
"what tools do you have?" (`tools/list`) and "run this tool" (`tools/call`).
`tools/list` is served by the already-public `pi.getAllTools()`. `tools/call`
must actually execute a pi tool, which requires the primitive this patch adds.
Without it, the bridge can advertise pi's tools but cannot run them, so it
detects the missing capability at load time and skips the MCP server entirely
(see `hasInvokeTool()` in `src/mcp-server.ts`).

## The delegation chain (why there are 6 sites)

pi's extension API is a facade. A call travels:

```
pi.invokeTool()                       (facade, built in loader.js)
  -> runner.invokeTool()              (ExtensionRunner, runner.js)
    -> runner.runtime.invokeTool()    (shared runtime object)
      -> AgentSession.invokeTool()    (the actions bundle wires this in bindCore)
        -> _toolRegistry.get(name).execute(...)
```

`bindCore` copies session methods onto a shared `runtime` object that all
extension APIs reference. That indirection is why a single method must be wired
at **six** places: the implementation, the actions-bundle binding, the runner's
copy, the runner's delegating method, the facade method, and the type.

## Where it goes (paths are relative to the pi package root)

pi ships **compiled** (`dist/`); there is no `src/` to edit. Find the package
root:

```bash
node -e "console.log(require('path').dirname(require.resolve('@earendil-works/pi-coding-agent/package.json')))"
# typical: ~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent
```

All paths below are under `<package>/dist/`. Developed against pi `^0.82.1`.

### Site 1 — `core/agent-session.js`: the implementation on `AgentSession`

Added immediately after `getToolDefinition(name) { ... }`:

```js
    /**
     * LOCAL PATCH (pi-antigravity-bridge): invoke a registered tool by name
     * out-of-band and return its result. The tool wrapper synthesizes ctx via
     * its ctxFactory when none is passed. Not upstream pi (yet).
     */
    async invokeTool(name, args = {}, options = {}) {
        const tool = this._toolRegistry.get(name);
        if (!tool) {
            throw new Error(`invokeTool: tool "${name}" not found in registry`);
        }
        const toolCallId = options.toolCallId ?? `invokeTool:${name}:${Date.now()}`;
        return tool.execute(toolCallId, args, options.signal ?? undefined, options.onUpdate);
    }
```

`_toolRegistry` is `Map<string, AgentTool>` and already exists on `AgentSession`.
Stored tools are **wrapped** (`wrapRegisteredTools(..., runner)` in
`tool-definition-wrapper.js`); their `execute` is
`(toolCallId, params, signal, onUpdate, ctx) => definition.execute(..., ctx ?? ctxFactory?.())`.
By passing only four args (no `ctx`), the wrapper synthesizes a valid
`ExtensionContext` via the runner's `createContext()`. No per-turn agent state
is required; this is what makes out-of-band execution safe.

### Site 2 — `core/agent-session.js`: the `bindCore` actions bundle (CRITICAL)

Inside the object literal passed to `runner.bindCore({ ... })`, immediately
after `refreshTools: () => this._refreshToolRegistry(),`:

```js
            invokeTool: (name, args, options) => this.invokeTool(name, args, options),
```

**This is the easy site to miss.** `bindCore` is the only place session methods
are wired onto the shared `runtime` object. Without this line,
`actions.invokeTool` is `undefined`, so site 3 assigns `undefined`, and the
facade throws `runtime.invokeTool is not a function`.

### Site 3 — `core/extensions/runner.js`: copy onto the shared runtime

In `bindCore`, immediately after `this.runtime.refreshTools = actions.refreshTools;`:

```js
        this.runtime.invokeTool = actions.invokeTool;
```

### Site 4 — `core/extensions/runner.js`: the delegating method

On `ExtensionRunner`, immediately after the `getActiveTools() { ... }` method:

```js
    invokeTool(name, args, options) {
        this.assertActive();
        return this.runtime.invokeTool(name, args, options);
    }
```

### Site 5 — `core/extensions/loader.js`: the facade method

In the `api` object literal returned to extensions, immediately after the
`getAllTools() { ... }` entry:

```js
        invokeTool(name, args, options) {
            runtime.assertActive();
            return runtime.invokeTool(name, args, options);
        },
```

### Site 6 — `core/extensions/types.d.ts`: the type declaration

On the `ExtensionAPI` interface, immediately after `getAllTools(): ToolInfo[];`:

```ts
    /**
     * LOCAL PATCH (pi-antigravity-bridge): invoke a registered tool by name
     * out-of-band and return { content, details, isError? }. ctx is synthesized.
     */
    invokeTool(name: string, args?: Record<string, unknown>, options?: { toolCallId?: string; signal?: AbortSignal; onUpdate?: (update: unknown) => void }): Promise<{ content: unknown[]; details: unknown; isError?: boolean }>;
```

## How to apply

**You usually don't.** On first load, the extension asks you once whether to
apply the patch (`src/patcher.ts`); see the note at the top of this document.
The manual steps below are for reference, auditing, or recovering without the
extension loaded.

The patch is plain edits to the six compiled files above. Because pi ships no
`src/`, there is nothing to recompile. (The old "clear jiti's cache" step is a
no-op on pi 0.82.1, which sets `moduleCache: false` in its extension loader, so
jiti never writes an fs cache.)

A `pi` reinstall or update overwrites `dist/` and **removes the patch**, but the
extension re-applies it on the next start (then prompts you to restart pi).
Durable fix: merge it upstream.

## How to verify

1. The facade has the method:

   ```bash
   pi -e /path/to/some-ext.ts --list-models   # ext logs typeof pi.invokeTool
   # expect: "function"
   ```

2. It executes a real tool. Quickest: a tiny extension that on `session_start`
   calls `pi.invokeTool("read", { path: <some file> })` and prints the result,
   run via `pi -e that-ext.ts --mode rpc` (RPC mode fires `session_start`
   without a model turn). The returned `content` should hold the file text.
   (Note: print/`-p` mode hangs on a remote default model before `session_start`
   fires; RPC mode avoids that.)

## Capability gate (how the bridge stays safe without it)

`src/mcp-server.ts` checks at load time:

```ts
export function hasInvokeTool(pi: ExtensionAPI): boolean {
  return typeof (pi as unknown as { invokeTool?: unknown }).invokeTool === "function";
}
```

If false, `startMcpServer()` returns `{ ok: false }` immediately and the bridge
runs exactly as it did before this feature existed: provider + `AskAntigravity`
tool, no MCP server. So an unpatched pi, or a pi updated past the patch, degrades
gracefully rather than crashing.

## Scope and risk

- Adds one read-only-by-convention method. Does not modify existing behavior,
  tool registration, the agent loop, or tool results.
- Calls the existing wrapped `execute` with a synthesized ctx; tools that depend
  on live per-turn agent state (an active abort signal, the current message)
  get a quiescent ctx. This is fine for the stateless tools the bridge exposes
  (memory, codegraph, search, delegations) and is the same synthesis pi itself
  uses for out-of-band tool execution.
- No new dependencies; no changes to persisted state or session format.
