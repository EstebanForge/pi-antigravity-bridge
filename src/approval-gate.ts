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

/** Build the shadow definition for one builtin. `base` MUST be the real
 *  builtin's definition (captured before any shadow registration). */
export function createShadowTool(base: AnyToolDefinition, policy: GatePolicy): AnyToolDefinition {
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
