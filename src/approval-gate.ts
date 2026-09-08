// Approval-gate shadow tools (docs/TODO.md section 2.5, design v2).
//
// When the approval gate is active, the bridge re-registers pi's mutating
// builtins (bash, write, edit) as SHADOW tools: same name, same schema plus
// internal __agy* marker fields. Two behaviors, keyed on the marker:
//
//   - marker absent: delegate to the captured real builtin. Normal pi
//     behavior (including the G9 path, where pi tools execute for real) is
//     untouched.
//   - marker present: the call is an approval round-trip for an agy NATIVE
//     tool. NEVER execute locally. Ask the policy for a decision; agy runs
//     the tool in its own loop either way.
//
// Decision mapping (consumed by the provider's /approval park):
//   resolve (success result)      -> {"decision":"allow"}
//   throw                         -> {"decision":"deny","reason": message}
// pi's tool executor converts thrown errors into error tool results with
// the message as text, matching how builtins report failures (write.js,
// edit-diff.js). A tool_call handler that blocks the shadow call upstream
// (any third-party permission extension) produces the same error result
// without execute() running, so both paths land on the same deny mapping.
//
// Run: npm test

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";

/** Marker flag: this shadow-tool call is an approval round-trip, not a real
 *  invocation. The bridge's provider sets it when composing the toolUse. */
export const GATE_MARKER = "__agyGate";

/** Internal context fields the provider may attach next to the marker.
 *  Stripped before delegating to the real builtin. */
export const MARKER_FIELDS = [GATE_MARKER, "__agyTicket", "__agyTool"] as const;

export type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface GateDecision {
	allow: boolean;
	reason?: string;
}

/** Fallback policy: consulted only when NO extension blocked the shadow
 *  tool_call. Implementations map approvals.mode: ask -> ctx.ui.confirm
 *  (guarded by ctx.hasUI), allow -> {allow:true}, deny -> {allow:false}. */
export type GatePolicy = (call: {
	tool: string;
	params: Record<string, unknown>;
	ctx: unknown;
}) => Promise<GateDecision> | GateDecision;

/** Marker schemas injected into the shadow parameters. Optional, so the
 *  model's own calls stay valid; audited permission extensions match only
 *  their known fields (command/path) and ignore these. */
const MARKER_SCHEMAS: Record<string, unknown> = {
	[GATE_MARKER]: {
		type: "boolean",
		description:
			"Internal bridge approval marker. Never set this yourself; calls without local execution intent must not set it.",
	},
	__agyTicket: { type: "string" },
	__agyTool: { type: "string", description: "Native agy tool this approval round-trip is for." },
};

/** Clone a tool's parameter schema with the marker fields added as optional
 *  properties. Field-exact for everything the permission extensions match on
 *  (command, path, edits, ...). Does not mutate the base schema. */
export function withGateMarkerSchema(base: AnyToolDefinition["parameters"]): AnyToolDefinition["parameters"] {
	const src = base as { properties?: Record<string, unknown> };
	return { ...base, properties: { ...src.properties, ...MARKER_SCHEMAS } } as AnyToolDefinition["parameters"];
}

/** Copy of params without the internal marker fields, for delegation. */
export function stripMarkerFields(params: Record<string, unknown>): Record<string, unknown> {
	const out = { ...params };
	for (const field of MARKER_FIELDS) delete out[field];
	return out;
}

export interface ShadowMapping {
	shadow: "bash" | "write" | "edit";
	input: Record<string, unknown>;
}

/** Map an agy native tool call (hook stdin payload) onto the shadow surface.
 *  Field names follow the TODO 2.5 table: create_file is live-captured (F1);
 *  the edit-class arg names are docs-attested and degrade gracefully - a
 *  wrong guess only weakens the confirm-dialog text, never the decision
 *  (the tool runs in agy's loop either way). Unknown names return null:
 *  read-only tools are not gated. */
export function mapNativeToShadow(name: string, args: Record<string, unknown>): ShadowMapping | null {
	const a = args ?? {};
	const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v));
	switch (name) {
		case "run_command": {
			const input: Record<string, unknown> = { command: str(a.CommandLine) };
			if (a.Cwd !== undefined && a.Cwd !== null && a.Cwd !== "") input.cwd = str(a.Cwd);
			return { shadow: "bash", input };
		}
		case "write_to_file":
		case "create_file":
			return { shadow: "write", input: { path: str(a.TargetFile), content: str(a.CodeContent) } };
		case "replace_file_content":
		case "edit_file":
			return {
				shadow: "edit",
				input: {
					path: str(a.TargetFile),
					edits: [{ oldText: str(a.SearchText), newText: str(a.ReplacementContent) }],
				},
			};
		case "multi_replace_file_content": {
			const chunks = Array.isArray(a.ReplacementChunks) ? a.ReplacementChunks : [];
			return {
				shadow: "edit",
				input: {
					path: str(a.TargetFile),
					edits: chunks.map((c) => {
						const chunk = (c ?? {}) as Record<string, unknown>;
						return { oldText: str(chunk.SearchText), newText: str(chunk.ReplacementContent) };
					}),
				},
			};
		}
		default:
			return null;
	}
}

/** Options for the shadow factory. */
export interface ShadowOptions {
	/** Registry lookup for the park's ticket. When set, a marker call whose
	 *  __agyTicket is missing or unrecognized throws (deny) BEFORE the policy
	 *  runs: a model that sets __agyGate:true itself can then never produce a
	 *  fake-approved result, even under approvals.mode "allow". */
	verifyTicket?: (ticket: string) => boolean;
}

/** Build the shadow definition for one builtin. `base` MUST be a definition
 *  of the real builtin - the extension passes factory twins created with
 *  pi's public createBashToolDefinition/createWriteToolDefinition/
 *  createEditToolDefinition (pi.getAllTools() returns ToolInfo, which strips
 *  execute, so the live definition cannot be captured). */
export function createShadowTool(base: AnyToolDefinition, policy: GatePolicy, opts: ShadowOptions = {}): AnyToolDefinition {
	const execute = async (
		toolCallId: string,
		params: any,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<any> | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<unknown>> => {
		const p = (params ?? {}) as Record<string, unknown>;
		if (p[GATE_MARKER] !== true) {
			return base.execute(toolCallId, stripMarkerFields(p), signal, onUpdate, ctx);
		}
		const native = typeof p.__agyTool === "string" && p.__agyTool.length > 0 ? p.__agyTool : base.name;
		// Ticket binding (peer review 2026-09-07): only calls the provider parked
		// carry a live ticket. Anything else with the marker set was forged by
		// the model (or the park is gone); fail closed without consulting the
		// policy, so approvals.mode "allow" can never bless it either.
		const ticket = typeof p.__agyTicket === "string" ? p.__agyTicket : "";
		if (!ticket || !opts.verifyTicket?.(ticket)) {
			throw new Error(
				`approval gate: unrecognized or stale approval ticket; refusing to decide (${native}).`,
			);
		}
		if (signal?.aborted) {
			throw new Error(`approval gate aborted before a decision was reached (${native}).`);
		}
		let decision: GateDecision;
		// Race the policy against the abort signal: a cancelled turn must
		// unblock execute() instead of hanging on a human decision.
		const aborted = new Error(`approval gate aborted before a decision was reached (${native}).`);
		const abortp = new Promise<never>((_, reject) => {
			signal?.addEventListener("abort", () => reject(aborted), { once: true });
		});
		abortp.catch(() => {}); // late rejection must not become unhandled
		try {
			decision = await Promise.race([Promise.resolve(policy({ tool: native, params: p, ctx })), abortp]);
		} catch (err) {
			if (signal?.aborted) throw aborted;
			// Fail closed: a broken policy must never look like an approval.
			throw new Error(`approval gate policy failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		if (signal?.aborted) {
			// Sync-abort inside the policy settles the policy promise BEFORE the
			// race starts, so the rejection loses the ordering tie. Re-check.
			throw aborted;
		}
		if (!decision.allow) {
			throw new Error(decision.reason || `blocked by approval gate (${native}).`);
		}
		return {
			content: [
				{
					type: "text",
					text: `Approved by approval gate: ${native}. No local execution happened; the tool runs in the Antigravity agent loop.`,
				},
			],
			details: { gate: "allow", native },
		};
	};
	return { ...base, parameters: withGateMarkerSchema(base.parameters), execute } as AnyToolDefinition;
}
