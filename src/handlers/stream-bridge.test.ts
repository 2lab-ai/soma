import { describe, it, expect } from "bun:test";
import { DeltaQueue } from "./stream-bridge";

describe("DeltaQueue", () => {
  it("emits deltas from cumulative text, not full duplicates", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    // Simulate Claude SDK pushing cumulative text
    queue.pushCumulative("Hello");
    queue.pushCumulative("Hello World");
    queue.pushCumulative("Hello World!");
    queue.end();

    for await (const chunk of queue) {
      collected.push(chunk);
    }

    expect(collected).toEqual(["Hello", " World", "!"]);
  });

  it("skips empty deltas when same text is pushed twice", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    queue.pushCumulative("Hello");
    queue.pushCumulative("Hello"); // duplicate — no delta
    queue.pushCumulative("Hello World");
    queue.end();

    for await (const chunk of queue) {
      collected.push(chunk);
    }

    expect(collected).toEqual(["Hello", " World"]);
  });

  it("handles async consumption with waiting", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    // Start consuming before data arrives
    const consumer = (async () => {
      for await (const chunk of queue) {
        collected.push(chunk);
      }
    })();

    // Push data asynchronously
    await new Promise((r) => setTimeout(r, 10));
    queue.pushCumulative("A");
    await new Promise((r) => setTimeout(r, 10));
    queue.pushCumulative("AB");
    await new Promise((r) => setTimeout(r, 10));
    queue.end();

    await consumer;
    expect(collected).toEqual(["A", "B"]);
  });

  it("abort discards remaining buffer", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    queue.pushCumulative("Hello");
    queue.pushCumulative("Hello World");
    queue.abort(); // Discard and stop

    for await (const chunk of queue) {
      collected.push(chunk);
    }

    // Buffer was cleared by abort, only items already yielded count
    // Since we haven't started consuming, abort clears everything
    expect(collected).toEqual([]);
  });

  it("ignores pushes after end()", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    queue.pushCumulative("Hello");
    queue.end();
    queue.pushCumulative("Hello World"); // ignored

    for await (const chunk of queue) {
      collected.push(chunk);
    }

    expect(collected).toEqual(["Hello"]);
  });

  it("splits large deltas into ≤4096-char chunks", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    // Push a 10000-char cumulative text
    const bigText = "x".repeat(10000);
    queue.pushCumulative(bigText);
    queue.end();

    for await (const chunk of queue) {
      collected.push(chunk);
      // Every chunk must be ≤ 4096
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }

    // All chunks together should equal the full text
    expect(collected.join("")).toBe(bigText);
    expect(collected.length).toBe(3); // 4096 + 4096 + 1808
  });

  it("handles segment_end flush pattern", async () => {
    const queue = new DeltaQueue();
    const collected: string[] = [];

    // Simulate text callbacks (throttled — not every token)
    queue.pushCumulative("Hello");
    queue.pushCumulative("Hello World, this is");

    // segment_end arrives with full text (may have more than last text callback)
    queue.pushCumulative("Hello World, this is a test!");
    queue.end();

    for await (const chunk of queue) {
      collected.push(chunk);
    }

    expect(collected).toEqual(["Hello", " World, this is", " a test!"]);
    expect(collected.join("")).toBe("Hello World, this is a test!");
  });
});
