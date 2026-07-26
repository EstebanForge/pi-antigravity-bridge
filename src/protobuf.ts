// Hand-rolled protobuf decoder for agy's `step_payload` blobs.
//
// agy writes per-conversation SQLite DBs at ~/.gemini/antigravity-cli/
// conversations/<uuid>.db. The `steps.step_payload` column is a protobuf blob
// with NO published schema. Field numbers below are load-bearing
// reverse-engineered facts (cross-checked against the shindgew/agy-acp and
// shubzkothekar/antigravity-acp decoders, plus real DB inspection on this
// machine, agy v1.1.7).
//
// We hand-roll the varint walker instead of pulling @bufbuild/protobuf or
// generating from .proto. The openab/agy-acp Rust port proves ~94 lines is
// enough for text + tool name extraction. Unknown fields are skipped per
// protobuf wire-format rules, so a future agy that adds fields won't break us.
//
// Layout we care about:
//   step_payload:
//     field 20 (submessage) = agentText   { 1: text }
//     field  5 (submessage) = toolRun     { 4: toolCall { 2|9: name, 3: inputJson } }
//     field 30 (submessage) = titleUpdate { 4: title }
// (fuller map in decodeStepPayload  -  only the ones we stream to pi.)

export type ByteSource = Uint8Array | ArrayBufferLike;

/** Read a base-128 varint starting at offset `i`. Returns [value, nextOffset].
 *
 *  NOTE on precision: accumulation uses bitwise OR and shift, which are
 *  32-bit operations in JS. Values needing 5+ continuation bytes (>32 bits)
 *  are truncated, not decoded correctly. This is acceptable here because agy
 *  field numbers and payload lengths are always small (well under 2^32). The
 *  10-byte cap is a DoS guard (stop a corrupt blob spinning forever), not a
 *  correctness guarantee for the full 64-bit varint range. */
export function readVarint(buf: Uint8Array, i: number): [number, number] {
	let result = 0;
	let shift = 0;
	let offset = i;
	// protobuf caps varints at 10 bytes (64-bit). Cap the loop so a corrupt
	// blob can't spin forever.
	for (let count = 0; count < 10; count++) {
		if (offset >= buf.length) {
			throw new RangeError(`varint at ${i} ran past end of buffer`);
		}
		const byte = buf[offset++];
		result |= (byte & 0x7f) << shift;
		if ((byte & 0x80) === 0) return [result >>> 0, offset];
		shift += 7;
	}
	throw new RangeError(`varint at ${i} exceeded 10 bytes`);
}

/** A (fieldNumber, wireType, valueSlice) triple produced by walking one field.
 *  For length-delimited fields (wire 2), `bytes` is the field payload.
 *  For varints (wire 0), `varint` holds the value. */
export interface Field {
	field: number;
	wire: number;
	bytes: Uint8Array | null; // wire 2 payload (view into the source buffer)
	varint: number | null; // wire 0 value
}

/** Walk every top-level field in a protobuf message. Returns the fields in
 *  order. Packed/repeated fields are not collapsed  -  callers see each
 *  occurrence. Unknown fields are included so the walker is reusable. */
export function walkFields(buf: Uint8Array): Field[] {
	const out: Field[] = [];
	let i = 0;
	while (i < buf.length) {
		const [tag, afterTag] = readVarint(buf, i);
		i = afterTag;
		const field = tag >>> 3;
		const wire = tag & 0x07;
		if (wire === 0) {
			// varint
			const [val, after] = readVarint(buf, i);
			i = after;
			out.push({ field, wire, bytes: null, varint: val });
		} else if (wire === 2) {
			// length-delimited
			const [len, afterLen] = readVarint(buf, i);
			i = afterLen;
			if (i + len > buf.length) {
				throw new RangeError(`field ${field}: length ${len} runs past buffer end`);
			}
			// subarray is a VIEW into the same backing buffer (no copy). Safe here
			// because the view is decoded and discarded within this poll; do NOT
			// retain `Field.bytes` past the current call  -  the source buffer may
			// be reused or collected differently than a retained slice expects.
			out.push({ field, wire, bytes: buf.subarray(i, i + len), varint: null });
			i += len;
		} else if (wire === 5) {
			// fixed32
			out.push({ field, wire, bytes: null, varint: null });
			i += 4;
		} else if (wire === 1) {
			// fixed64
			out.push({ field, wire, bytes: null, varint: null });
			i += 8;
		} else {
			// wire 3/4 (start/end group) are deprecated and agy never emits them.
			// Throw rather than silently drop every field after this point  -  a
			// corrupt byte that looks like a group delimiter should fail loudly so
			// the caller (pollOnce) can drop the step and retry on the next poll.
			throw new RangeError(`unexpected wire type ${wire} at field ${field}`);
		}
	}
	return out;
}

/** Find the first length-delimited field with the given number, or null.
 *  Equivalent to agy-acp's readSubmessage + readMessage dispatch for one field. */
export function getField(buf: Uint8Array, target: number): Uint8Array | null {
	for (const f of walkFields(buf)) {
		if (f.field === target && f.wire === 2 && f.bytes) return f.bytes;
	}
	return null;
}

/** Decode a UTF-8 slice to a string. Tolerant: invalid bytes become U+FFFD. */
const utf8 = new TextDecoder("utf-8", { fatal: false });
export function utf8String(bytes: Uint8Array): string {
	return utf8.decode(bytes);
}

export interface AgentText {
	text: string;
}

export interface ToolCallInfo {
	/** Primary tool name (field 2 of toolCall). */
	name: string;
	/** Raw input JSON string (field 3 of toolCall), unparsed. */
	inputJson: string;
}

/** Extract agent text from a step_payload: field 20 -> field 1.
 *  Returns null if the payload has no agentText field. */
export function extractAgentText(payload: Uint8Array): AgentText | null {
	const agentText = getField(payload, 20);
	if (!agentText) return null;
	const text = getField(agentText, 1);
	if (!text) return null;
	return { text: utf8String(text) };
}

/** Extract tool-call info from a step_payload: field 5 (toolRun) -> field 4
 *  (toolCall) -> fields 2/9 (name) and 3 (inputJson). Returns null if the
 *  payload has no toolRun.toolCall. */
export function extractToolCall(payload: Uint8Array): ToolCallInfo | null {
	const toolRun = getField(payload, 5);
	if (!toolRun) return null;
	const toolCall = getField(toolRun, 4);
	if (!toolCall) return null;
	// Name lives at field 2 (namePrimary) or field 9 (nameSecondary).
	let name = "";
	let inputJson = "";
	for (const f of walkFields(toolCall)) {
		if (f.field === 2 && f.bytes) name ||= utf8String(f.bytes);
		else if (f.field === 9 && f.bytes && !name) name = utf8String(f.bytes);
		else if (f.field === 3 && f.bytes) inputJson ||= utf8String(f.bytes);
	}
	if (!name && !inputJson) return null;
	return { name, inputJson };
}

/** Extract the title from a step_payload: field 30 (titleUpdate) -> field 4.
 *  Returns null when absent. */
export function extractTitle(payload: Uint8Array): string | null {
	const titleUpdate = getField(payload, 30);
	if (!titleUpdate) return null;
	const title = getField(titleUpdate, 4);
	return title ? utf8String(title) : null;
}

/** Decode a Buffer/Uint8Array-shaped column value to a clean Uint8Array.
 *  node:sqlite returns Uint8Array for BLOB; better-sqlite3 returns Buffer. */
export function toUint8(v: unknown): Uint8Array {
	if (v instanceof Uint8Array) return v;
	// Buffer is a Uint8Array subclass; instanceof covers it but be defensive.
	if (ArrayBuffer.isView(v)) {
		const view = v as Uint8Array;
		return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
	}
	if (v == null) return new Uint8Array(0);
	return new Uint8Array(0);
}
