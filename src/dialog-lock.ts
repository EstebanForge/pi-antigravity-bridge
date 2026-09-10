// Process-wide FIFO lock for human-facing dialogs (confirm/editor/select).
//
// pi's interactive UI shows ONE extension dialog at a time; an overlapping
// ctx.ui.* dialog call REPLACES the live dialog and the replaced promise
// never settles, so parallel gated tool calls hang forever (or silently lose
// their prompt). Holding this lock around each dialog serializes them: the
// first renders, the rest appear in turn as each is answered.
//
// The lock is keyed via Symbol.for because ALL pi-* extensions run in the
// SAME pi process and must share one queue: a per-module lock would still let
// a dialog from one extension clobber a dialog from another in the same
// parallel tool-call batch.
const DIALOG_LOCK: unique symbol = Symbol.for("pi-me.dialog-lock");

interface DialogQueue {
  tail: Promise<void>;
}

function dialogQueue(): DialogQueue {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[DIALOG_LOCK] as DialogQueue | undefined;
  if (existing) return existing;
  const created: DialogQueue = { tail: Promise.resolve() };
  host[DIALOG_LOCK] = created;
  return created;
}

/**
 * Run `run` while holding the cross-extension dialog lock. FIFO: each caller
 * chains onto the queue tail synchronously (before its first await), so call
 * order is the order the dialogs appear. Released in a finally block, so one
 * throwing dialog can never wedge the queue for the callers behind it.
 * NOT reentrant: calling it inside a held `run` self-deadlocks.
 */
export async function withDialogLock<T>(run: () => Promise<T>): Promise<T> {
  const queue = dialogQueue();
  const prev = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await run();
  } finally {
    release();
  }
}
