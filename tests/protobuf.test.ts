// Unit tests for the protobuf decoder. Pure functions, no DB  -  these guard
// the wire-format math (varint, field walking, nested submessage navigation)
// so a future refactor of provider.ts still matches the layout verified against
// real agy conversation DBs (see scripts/decode-db.ts for the live check).
//
// Run: npm test

import assert from "node:assert/strict";
import { test } from "node:test";
import {
	extractAgentText,
	extractTitle,
	extractToolCall,
	getField,
	readVarint,
	utf8String,
	walkFields,
} from "../src/protobuf.js";

// --- fixture helpers --------------------------------------------------------

// Minimal varint encoder (mirrors readVarint) for building fixtures by hand.
function encodeVarint(value: number): number[] {
	const out: number[] = [];
	let v = value;
	while (v >= 0x80) {
		out.push((v & 0x7f) | 0x80);
		v = Math.floor(v / 128);
	}
	out.push(v);
	return out;
}

// Build a length-delimited field: tag varint + length varint + payload.
// Accepts a UTF-8 string OR a pre-built submessage (Uint8Array) for nesting.
// Centralizes tag = (field<<3)|2 so the math can't drift between fixtures.
function lenField(field: number, payload: string | Uint8Array): number[] {
	const tag = (field << 3) | 2;
	const bytes = typeof payload === "string" ? [...Buffer.from(payload)] : [...payload];
	return [...encodeVarint(tag), ...encodeVarint(bytes.length), ...bytes];
}

// --- varint -----------------------------------------------------------------

test("readVarint decodes single-byte values", () => {
	const buf = new Uint8Array([0x08]); // value 8
	assert.equal(readVarint(buf, 0)[0], 8);
});

test("readVarint decodes multi-byte values (150)", () => {
	// canonical protobuf example: 150 = 0x96 0x01
	const buf = new Uint8Array([0x96, 0x01]);
	const [val, next] = readVarint(buf, 0);
	assert.equal(val, 150);
	assert.equal(next, 2);
});

test("readVarint rejects a 10-byte continuation run (corrupt)", () => {
	const buf = new Uint8Array(10).fill(0xff);
	assert.throws(() => readVarint(buf, 0), RangeError);
});

// --- walkFields / getField --------------------------------------------------

test("walkFields parses a one-field message: field 1 string 'hi'", () => {
	const buf = Uint8Array.from(lenField(1, "hi"));
	const fields = walkFields(buf);
	assert.equal(fields.length, 1);
	assert.equal(fields[0].field, 1);
	assert.equal(fields[0].wire, 2);
	assert.equal(utf8String(fields[0].bytes!), "hi");
});

test("walkFields parses mixed varint + length-delimited fields in order", () => {
	const buf = Uint8Array.from([
		...lenField(1, ""), // placeholder removed below  -  rebuild manually:
	]);
	// Build by hand so we can mix wire types: field1 varint(7), field2 "x", field3 "y".
	const manual = [
		...encodeVarint((1 << 3) | 0),
		7, // varint value
		...lenField(2, "x"),
		...lenField(3, "y"),
	];
	const fields = walkFields(Uint8Array.from(manual));
	void buf;
	assert.deepEqual(
		fields.map((f) => [f.field, f.wire, f.varint]),
		[
			[1, 0, 7],
			[2, 2, null],
			[3, 2, null],
		],
	);
	assert.equal(utf8String(fields[1].bytes!), "x");
	assert.equal(utf8String(fields[2].bytes!), "y");
});

test("getField returns first match or null", () => {
	const buf = Uint8Array.from(lenField(1, "hi"));
	assert.equal(utf8String(getField(buf, 1)!), "hi");
	assert.equal(getField(buf, 99), null);
});

// --- extractAgentText: field 20 -> field 1 ---------------------------------

test("extractAgentText navigates field 20.1", () => {
	const inner = Uint8Array.from(lenField(1, "hello"));
	const buf = Uint8Array.from(lenField(20, inner));
	assert.equal(extractAgentText(buf)?.text, "hello");
});

test("extractAgentText returns null when no field 20", () => {
	const buf = Uint8Array.from(lenField(1, "hi"));
	assert.equal(extractAgentText(buf), null);
});

// --- extractToolCall: field 5 -> field 4 -> {2|9: name, 3: inputJson} -------

test("extractToolCall reads name (field 2) and input (field 3)", () => {
	const toolCall = Uint8Array.from([
		...lenField(2, "run_command"),
		...lenField(3, '{"cmd":"ls"}'),
	]);
	const toolRun = Uint8Array.from(lenField(4, toolCall));
	const buf = Uint8Array.from(lenField(5, toolRun));
	const tc = extractToolCall(buf);
	assert.equal(tc?.name, "run_command");
	assert.equal(tc?.inputJson, '{"cmd":"ls"}');
});

// --- extractTitle: field 30 -> field 4 -------------------------------------

test("extractTitle navigates field 30.4", () => {
	const inner = Uint8Array.from(lenField(4, "audit"));
	const buf = Uint8Array.from(lenField(30, inner));
	assert.equal(extractTitle(buf), "audit");
});

test("extractTitle returns null when absent", () => {
	const buf = Uint8Array.from(lenField(1, "x"));
	assert.equal(extractTitle(buf), null);
});
