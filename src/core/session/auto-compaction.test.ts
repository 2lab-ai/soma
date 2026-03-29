import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "./session";

describe("auto-compaction", () => {
  function createSessionWithContext(
    usedTokens: number,
    maxTokens: number
  ): ClaudeSession {
    const session = new ClaudeSession("test:auto-compact");
    // Simulate an active session with known context usage
    (session as any).sessionId = "test-session-abc123";
    (session as any).actualContextUsed = usedTokens;
    (session as any).actualContextMax = maxTokens;
    return session;
  }

  describe("getContextPercentage", () => {
    test("returns null when no context window size is known", () => {
      const session = new ClaudeSession("test:no-context");
      expect(session.getContextPercentage()).toBeNull();
    });

    test("returns correct fraction from actualContext values", () => {
      const session = createSessionWithContext(80000, 200000);
      expect(session.getContextPercentage()).toBeCloseTo(0.4, 2);
    });

    test("returns correct fraction at boundary", () => {
      const session = createSessionWithContext(160000, 200000);
      expect(session.getContextPercentage()).toBeCloseTo(0.8, 2);
    });

    test("falls back to contextWindowSize when actualContextMax is null", () => {
      const session = new ClaudeSession("test:fallback");
      (session as any).sessionId = "test-session";
      (session as any).actualContextUsed = null;
      (session as any).actualContextMax = null;
      (session as any).contextWindowSize = 200000;
      // currentContextTokens will be 0 since no usage data
      expect(session.getContextPercentage()).toBe(0);
    });
  });

  describe("needsAutoCompact", () => {
    test("false when no active session", () => {
      const session = new ClaudeSession("test:inactive");
      expect(session.needsAutoCompact).toBe(false);
    });

    test("false when context is below threshold (70%)", () => {
      const session = createSessionWithContext(140000, 200000);
      expect(session.needsAutoCompact).toBe(false);
    });

    test("true when context is at threshold (80%)", () => {
      const session = createSessionWithContext(160000, 200000);
      expect(session.needsAutoCompact).toBe(true);
    });

    test("true when context is above threshold (90%)", () => {
      const session = createSessionWithContext(180000, 200000);
      expect(session.needsAutoCompact).toBe(true);
    });

    test("false when recentlyRestored flag is set manually", () => {
      const session = createSessionWithContext(180000, 200000);
      // Note: markRestored() has a known quirk where resetWarningFlags() clears
      // recentlyRestored. Set the flag directly to test the guard.
      (session as any).recentlyRestored = true;
      expect(session.needsAutoCompact).toBe(false);
    });
  });

  describe("autoCompact", () => {
    test("returns null when no active session", () => {
      const session = new ClaudeSession("test:no-session");
      expect(session.autoCompact()).toBeNull();
    });

    test("resets sessionId to null", () => {
      const session = createSessionWithContext(180000, 200000);
      expect(session.sessionId).not.toBeNull();

      session.autoCompact();

      expect(session.sessionId).toBeNull();
      expect(session.isActive).toBe(false);
    });

    test("sets nextQueryContext with carry-over", () => {
      const session = createSessionWithContext(180000, 200000);
      (session as any).totalQueries = 15;
      (session as any).lastMessage = "tell me about TypeScript generics";

      const carryOver = session.autoCompact();

      expect(carryOver).not.toBeNull();
      expect(carryOver).toContain("Auto-compaction triggered");
      expect(carryOver).toContain("90.0%");
      expect(carryOver).toContain("15 queries");
      expect(carryOver).toContain("TypeScript generics");
      expect((session as any).nextQueryContext).toContain(carryOver!);
    });

    test("resets token counters", () => {
      const session = createSessionWithContext(180000, 200000);
      (session as any).totalInputTokens = 50000;
      (session as any).totalOutputTokens = 30000;
      (session as any).totalQueries = 10;

      session.autoCompact();

      expect((session as any).totalInputTokens).toBe(0);
      expect((session as any).totalOutputTokens).toBe(0);
      expect((session as any).totalQueries).toBe(0);
    });

    test("resets context tracking", () => {
      const session = createSessionWithContext(180000, 200000);

      session.autoCompact();

      expect((session as any).contextWindowUsage).toBeNull();
      expect((session as any).actualContextUsed).toBeNull();
      expect((session as any).actualContextMax).toBeNull();
    });

    test("increments compaction count", () => {
      const session = createSessionWithContext(180000, 200000);
      expect(session.compactionCount).toBe(0);

      session.autoCompact();
      expect(session.compactionCount).toBe(1);

      // Simulate re-establishing session for another compaction
      (session as any).sessionId = "new-session";
      session.autoCompact();
      expect(session.compactionCount).toBe(2);
    });

    test("records compaction timestamp", () => {
      const session = createSessionWithContext(180000, 200000);
      expect(session.lastCompactionTime).toBe(0);

      const before = Date.now();
      session.autoCompact();
      const after = Date.now();

      expect(session.lastCompactionTime).toBeGreaterThanOrEqual(before);
      expect(session.lastCompactionTime).toBeLessThanOrEqual(after);
    });

    test("resets warning flags", () => {
      const session = createSessionWithContext(180000, 200000);
      (session as any).warned70 = true;
      (session as any).warned85 = true;
      (session as any).warned95 = true;
      (session as any).contextLimitWarned = true;

      session.autoCompact();

      expect((session as any).warned70).toBe(false);
      expect((session as any).warned85).toBe(false);
      expect((session as any).warned95).toBe(false);
      expect((session as any).contextLimitWarned).toBe(false);
    });

    test("preserves steering buffer (does not disrupt pending messages)", () => {
      const session = createSessionWithContext(180000, 200000);
      session.addSteering("pending message 1", 101);
      session.addSteering("pending message 2", 102);

      session.autoCompact();

      expect(session.hasSteeringMessages()).toBe(true);
      expect(session.getSteeringCount()).toBe(2);
    });

    test("appends to existing nextQueryContext", () => {
      const session = createSessionWithContext(180000, 200000);
      (session as any).nextQueryContext = "[EXISTING CONTEXT]";

      session.autoCompact();

      const ctx = (session as any).nextQueryContext as string;
      expect(ctx).toContain("[EXISTING CONTEXT]");
      expect(ctx).toContain("Auto-compaction triggered");
    });
  });
});
