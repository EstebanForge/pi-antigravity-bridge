import { describe, expect, it } from "vitest";
import { withDialogLock } from "../src/dialog-lock.js";

// Pins the cross-extension dialog serialization contract (see dialog-lock.ts):
// holders run one at a time in FIFO order, a throwing holder cannot wedge the
// queue, and the queue lives on the Symbol.for registry so every pi-* extension
// in one process shares it.

// Flush pending microtasks so queued callers reach (or pass) their slot before
// the next assertion.
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("withDialogLock", () => {
  it("runs holders one at a time, in FIFO order", async () => {
    const events: string[] = [];
    let release!: () => void;

    const first = withDialogLock(async () => {
      events.push("a:open");
      await new Promise<void>((r) => (release = r));
      events.push("a:close");
    });
    const second = withDialogLock(async () => {
      events.push("b:open");
    });

    await settle();
    // Second holder must still be waiting while the first is open.
    expect(events).toEqual(["a:open"]);

    release();
    await Promise.all([first, second]);
    expect(events).toEqual(["a:open", "a:close", "b:open"]);
  });

  it("releases the queue when a holder throws", async () => {
    await expect(
      withDialogLock(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    let ran = false;
    await withDialogLock(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("shares one queue across modules via Symbol.for", () => {
    // Same key in every pi-* repo: one queue per pi process, so gates from
    // different extensions in one parallel batch serialize against each other.
    expect(
      (globalThis as Record<symbol, unknown>)[Symbol.for("pi-me.dialog-lock")],
    ).toBeDefined();
  });
});
