# Approval gate (agy native tools)

agy is not a plain model: it runs its own agent loop with its own native tools (`run_command`, `create_file`, `edit_file`, ...). Those calls execute inside agy with no pi involvement, so pi's permission extensions never saw them. The approval gate closes that gap: agy native tool calls pass through a pi-side approval in a form the existing permission-extension ecosystem gates with zero changes.

Mechanics: the extension stages an `.agents/hooks.json` group in the workspace; the Antigravity server/CLI fires a `PreToolUse` hook before each mutating native tool runs. The hook script (generated, per-pid, mode 0600 because it embeds the bridge token) POSTs the call to the bridge and polls for a decision. The bridge parks it, the provider interrupts the pi-side view of the agy turn with a `toolUse` for a SHADOW tool named `bash`/`write`/`edit` (same schema as the real builtin plus internal `__agy*` marker fields), and pi's whole `tool_call` surface applies: any installed permission extension gates the call unchanged, and only if nothing blocks does the fallback policy run. The decision travels back to the hook and agy enforces it; on deny the reason text is what agy's model sees. Marker calls never execute locally (a ticket check denies forged ones); non-marker calls delegate to a factory twin of the real builtin, so normal pi bash/write/edit behavior is unchanged. Read-only agy tools stay ungated. Every decision lands in the daily log with tool names, source, and latency.

Configuration (`/agy` config keys or environment):

```jsonc
{
  "approvals": {
    "gateMode": "auto",  // auto | shadow | dedicated | off
    "mode": "ask"        // ask | allow | deny  (fallback when no extension gates)
  }
}
// env: AGY_APPROVALS=shadow AGY_APPROVALS_MODE=ask
```

`auto` (default) keeps the gate OFF until one of the known pi permission packages is detected (pi settings `packages` name-match or known config markers). `shadow` forces it on; `off` forces it off. `dedicated` currently stages the same shadow tools (the explicit `antigravity_approve` variant is planned; the config value is accepted today so the schema is stable). The fallback `mode` is consulted only when no extension blocked the call: `ask` shows a pi confirm dialog (headless runs deny, fail-closed), `allow` approves, `deny` blocks. Timeouts deny fail-closed: the staged hook timeout always exceeds the park budget, but a hook that outlives its timeout soft-passes upstream (verified against the ACP server), so the park always answers first.

If you write your own gate extension, it sees a normal pi tool call:

```typescript
export default function (pi) {
	pi.on("tool_call", async (event) => {
		if (event.input?.__agyGate && event.input.command?.startsWith("rm ")) {
			return { block: true, reason: "rm is not allowed through the agy gate" };
		}
	});
}
```

Live end-to-end verification (drive a real mutating agy turn through the gate) is still pending; see docs/TODO.md section 1.
