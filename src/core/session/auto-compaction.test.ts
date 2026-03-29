import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "./session";

describe("auto-compaction (SDK-native)", () => {
  describe("onCompactionObserved", () => {
    test("tracks compaction count", () => {
      const session = new ClaudeSession("test:compact-count");
      expect(session.compactionCount).toBe(0);

      session.onCompactionObserved("auto", 150000);
      expect(session.compactionCount).toBe(1);

      session.onCompactionObserved("auto", 180000);
      expect(session.compactionCount).toBe(2);
    });

    test("records last compaction timestamp", () => {
      const session = new ClaudeSession("test:compact-time");
      expect(session.lastCompactionTime).toBe(0);

      const before = Date.now();
      session.onCompactionObserved("auto", 150000);
      const after = Date.now();

      expect(session.lastCompactionTime).toBeGreaterThanOrEqual(before);
      expect(session.lastCompactionTime).toBeLessThanOrEqual(after);
    });

    test("handles manual trigger", () => {
      const session = new ClaudeSession("test:compact-manual");
      session.onCompactionObserved("manual", 100000);
      expect(session.compactionCount).toBe(1);
    });

    test("handles unknown trigger gracefully", () => {
      const session = new ClaudeSession("test:compact-unknown");
      session.onCompactionObserved("unknown", 0);
      expect(session.compactionCount).toBe(1);
    });
  });

  describe("compaction telemetry survives session lifecycle", () => {
    test("kill() does not reset compaction counters", async () => {
      const session = new ClaudeSession("test:compact-survive-kill");
      session.onCompactionObserved("auto", 150000);
      session.onCompactionObserved("auto", 180000);
      expect(session.compactionCount).toBe(2);

      await session.kill();

      // Compaction count should persist across session kills
      // since it's session-wide telemetry, not per-SDK-session state
      expect(session.compactionCount).toBe(2);
    });
  });
});
