import { describe, test, expect, jest, beforeEach, afterEach } from "bun:test";
import { MessageQueue, type BatchPayload } from "./message-queue";

describe("MessageQueue", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("single message auto-flushes after debounce", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("msg1");
    expect(batches).toEqual([]);

    jest.advanceTimersByTime(100);
    expect(batches).toEqual([["msg1"]]);
  });

  test("multiple messages batch into single auto-flush", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("a");
    queue.enqueue("b");
    queue.enqueue("c");

    jest.advanceTimersByTime(100);
    expect(batches).toEqual([["a", "b", "c"]]);
  });

  test("debounce resets on each enqueue", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("a");
    jest.advanceTimersByTime(50);
    queue.enqueue("b");
    jest.advanceTimersByTime(50); // Total 100ms from first, but only 50ms from second
    expect(batches).toEqual([]); // Timer was reset, no flush yet

    jest.advanceTimersByTime(50); // Now 100ms from second enqueue
    expect(batches).toEqual([["a", "b"]]);
  });

  test("manual flush returns current batch and cancels timer", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("x");
    queue.enqueue("y");
    const batch = queue.flush();

    expect(batch).toEqual(["x", "y"]);
    expect(batches).toEqual([]); // onFlush not called

    jest.advanceTimersByTime(100);
    expect(batches).toEqual([]); // Timer was cancelled
  });

  test("empty flush returns empty array", () => {
    const queue = new MessageQueue({ debounceMs: 100 });
    const batch = queue.flush();
    expect(batch).toEqual([]);
  });

  test("flush after auto-flush returns empty array", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("msg");
    jest.advanceTimersByTime(100);
    expect(batches).toEqual([["msg"]]);

    const batch = queue.flush();
    expect(batch).toEqual([]);
  });

  test("enqueue after flush starts fresh batch", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("a");
    queue.flush();
    queue.enqueue("b");

    jest.advanceTimersByTime(100);
    expect(batches).toEqual([["b"]]);
  });

  test("pending property reflects buffer size", () => {
    const queue = new MessageQueue({ debounceMs: 100 });
    expect(queue.pending).toBe(0);

    queue.enqueue("a");
    expect(queue.pending).toBe(1);

    queue.enqueue("b");
    expect(queue.pending).toBe(2);

    queue.flush();
    expect(queue.pending).toBe(0);
  });

  test("destroy clears timer and prevents further enqueues", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("msg");
    queue.destroy();

    jest.advanceTimersByTime(100);
    expect(batches).toEqual([]); // Timer was cleared, no auto-flush

    expect(() => queue.enqueue("blocked")).toThrow("MessageQueue has been destroyed");
  });

  test("buffer cleared synchronously even with async onFlush", () => {
    const flushedBatches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: async (batch) => {
        // Simulate async work (e.g., API call)
        await new Promise((r) => setTimeout(r, 50));
        flushedBatches.push(batch);
      },
    });

    queue.enqueue("a");
    expect(queue.pending).toBe(1);

    jest.advanceTimersByTime(100); // Trigger auto-flush

    // Buffer should be cleared immediately (synchronous flush())
    // even though onFlush callback is still running
    expect(queue.pending).toBe(0);

    // Can immediately start new batch
    queue.enqueue("b");
    expect(queue.pending).toBe(1);
  });

  test("custom debounce window", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 500,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("msg");
    jest.advanceTimersByTime(400);
    expect(batches).toEqual([]); // Not yet

    jest.advanceTimersByTime(100);
    expect(batches).toEqual([["msg"]]); // Now flushed
  });

  test("no onFlush callback - auto-flush is silent", () => {
    const queue = new MessageQueue({ debounceMs: 100 });
    queue.enqueue("msg");
    jest.advanceTimersByTime(100);
    // No error, just silent flush
    expect(queue.pending).toBe(0);
  });

  test("onFlush error triggers onError callback", () => {
    const errors: Array<{ error: Error; batch: BatchPayload }> = [];
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: () => {
        throw new Error("Flush failed");
      },
      onError: (error, batch) => {
        errors.push({ error, batch });
      },
    });

    queue.enqueue("msg");
    jest.advanceTimersByTime(100);

    expect(errors).toHaveLength(1);
    expect(errors[0]!.error.message).toBe("Flush failed");
    expect(errors[0]!.batch).toEqual([]); // Buffer was already cleared
  });

  test("onFlush error logs to console when no onError handler", () => {
    const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const queue = new MessageQueue({
      debounceMs: 100,
      onFlush: () => {
        throw new Error("Unhandled flush error");
      },
    });

    queue.enqueue("msg");
    jest.advanceTimersByTime(100);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      "MessageQueue autoFlush error:",
      expect.any(Error)
    );
    consoleErrorSpy.mockRestore();
  });

  test("flush after destroy returns empty array", () => {
    const queue = new MessageQueue({ debounceMs: 100 });
    queue.enqueue("msg");
    queue.destroy();

    const batch = queue.flush();
    expect(batch).toEqual([]); // Buffer cleared on destroy
  });

  test("negative debounceMs throws error", () => {
    expect(() => {
      new MessageQueue({ debounceMs: -100 });
    }).toThrow("debounceMs must be non-negative");
  });

  test("zero debounceMs flushes on next tick", () => {
    const batches: BatchPayload[] = [];
    const queue = new MessageQueue({
      debounceMs: 0,
      onFlush: (batch) => batches.push(batch),
    });

    queue.enqueue("instant");
    jest.runAllTimers(); // Run all pending timers including 0ms

    expect(batches).toEqual([["instant"]]);
  });
});
