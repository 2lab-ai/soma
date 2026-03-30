import { describe, test, expect } from "bun:test";

describe("crash recovery user-binding (#31)", () => {
  // Mirrors the consumption logic from session.ts sendMessageStreaming
  function consumeContext(
    nextQueryContext: { userId: number; context: string } | null,
    queryUserId: number | undefined
  ): { consumed: boolean; context: string | null } {
    if (!nextQueryContext) return { consumed: false, context: null };
    if (nextQueryContext.userId === queryUserId) {
      return { consumed: true, context: nextQueryContext.context };
    }
    return { consumed: false, context: null };
  }

  test("nextQueryContext stores userId with context", () => {
    const ctx = { userId: 12345, context: "[CRASH RECOVERY - 1 message(s)]\nhello\n[END RECOVERY]" };
    expect(ctx.userId).toBe(12345);
    expect(ctx.context).toContain("hello");
  });

  test("same user's context IS consumed", () => {
    const stored = { userId: 111, context: "user A's crashed message" };
    const result = consumeContext(stored, 111);
    expect(result.consumed).toBe(true);
    expect(result.context).toBe("user A's crashed message");
  });

  test("different user's context is NOT consumed", () => {
    const stored = { userId: 111, context: "user A's crashed message" };
    const result = consumeContext(stored, 222);
    expect(result.consumed).toBe(false);
    expect(result.context).toBeNull();
  });

  test("undefined queryUserId does NOT bypass user binding", () => {
    // Critical: queryUserId=undefined must NOT consume stored context
    const stored = { userId: 111, context: "user A's context" };
    const result = consumeContext(stored, undefined);
    expect(result.consumed).toBe(false);
    expect(result.context).toBeNull();
  });

  test("null nextQueryContext returns no context", () => {
    const result = consumeContext(null, 111);
    expect(result.consumed).toBe(false);
    expect(result.context).toBeNull();
  });

  test("context accumulation works for same user", () => {
    const userId = 111;
    let nextQueryContext: { userId: number; context: string } | null = null;

    // First crash
    const crash1 = "[CRASH RECOVERY]\nmsg1\n[END]";
    const existingCtx1 = nextQueryContext?.userId === userId ? nextQueryContext.context : "";
    nextQueryContext = { userId, context: existingCtx1 ? `${existingCtx1}\n${crash1}` : crash1 };

    // Second crash (same user) — should accumulate
    const crash2 = "[CRASH RECOVERY]\nmsg2\n[END]";
    const existingCtx2 = nextQueryContext?.userId === userId ? nextQueryContext.context : "";
    nextQueryContext = { userId, context: existingCtx2 ? `${existingCtx2}\n${crash2}` : crash2 };

    expect(nextQueryContext.context).toContain("msg1");
    expect(nextQueryContext.context).toContain("msg2");
    expect(nextQueryContext.userId).toBe(111);
  });

  test("context accumulation resets for different user", () => {
    const userA = 111;
    const userB = 222;
    let nextQueryContext: { userId: number; context: string } | null = null;

    // User A crashes
    nextQueryContext = { userId: userA, context: "user A's crash context" };

    // User B crashes — should NOT accumulate User A's context
    const existingCtx = nextQueryContext?.userId === userB ? nextQueryContext.context : "";
    nextQueryContext = { userId: userB, context: existingCtx ? `${existingCtx}\nnew` : "user B's crash context" };

    expect(nextQueryContext.context).toBe("user B's crash context");
    expect(nextQueryContext.context).not.toContain("user A");
    expect(nextQueryContext.userId).toBe(222);
  });
});
