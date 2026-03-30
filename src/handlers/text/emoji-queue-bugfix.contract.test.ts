/**
 * Contract tests for emoji-queue-bugfix
 *
 * Covers:
 * - Scenario 1: Emoji constants unification (PROCESSING → 🔥, legacy removed)
 * - Scenario 2: Streaming emoji removal (no independent setReaction in streaming.ts)
 * - Scenario 3: STEERING_DELIVERED on consume (consumeSteeringWithIds)
 * - Scenario 4: Interrupt auto-requeue (messages stay in buffer)
 * - Scenario 5: Error path steering preservation (nextQueryContext)
 * - Scenario 6: PendingRecovery timeout extension (60s → 10min)
 * - Scenario 7: Interrupt marker not polluting lastMessage
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import { Reactions } from "../../constants/reactions";
import { ClaudeSession } from "../../core/session/session";
import { PENDING_RECOVERY_TIMEOUT_MS } from "../../types/session";

// ─── Scenario 1: Emoji Constants ─────────────────────────────────────

describe("Scenario 1 — Emoji State Machine Unification", () => {
  test("PROCESSING emoji is fire (🔥), not thinking face", () => {
    expect(Reactions.PROCESSING).toBe("🔥");
  });

  test("legacy EVICTED constant is removed", () => {
    expect((Reactions as any).EVICTED).toBeUndefined();
  });

  test("legacy FAIL constant is removed", () => {
    expect((Reactions as any).FAIL).toBeUndefined();
  });

  test("all required state emojis are defined", () => {
    expect(Reactions.READ).toBe("👀");
    expect(Reactions.COMPLETE).toBe("👍");
    expect(Reactions.STEERING_BUFFERED).toBe("👌");
    expect(Reactions.STEERING_DELIVERED).toBe("🙏");
    expect(Reactions.INTERRUPTED).toBe("👎");
    expect(Reactions.ERROR_SOMA).toBe("😱");
    expect(Reactions.ERROR_MODEL).toBe("💩");
    expect(Reactions.CANCELLED).toBe("😢");
  });
});

// ─── Scenario 2: Streaming Emoji Removal ─────────────────────────────

describe("Scenario 2 — Streaming No Longer Sets Independent Reactions", () => {
  test("streaming.ts does not import PROGRESS_REACTION_ENABLED", () => {
    const streamingSource = readFileSync(
      resolve(__dirname, "../streaming.ts"),
      "utf-8"
    );
    // Must NOT contain an active import of PROGRESS_REACTION_ENABLED
    const importLines = streamingSource
      .split("\n")
      .filter(
        (line) =>
          line.includes("PROGRESS_REACTION_ENABLED") &&
          !line.trimStart().startsWith("//")
      );
    expect(importLines).toEqual([]);
  });

  test("streaming.ts does not call setReaction with 🔥 or 🎉", () => {
    const streamingSource = readFileSync(
      resolve(__dirname, "../streaming.ts"),
      "utf-8"
    );
    // Active (non-commented) setReaction calls with conflict emojis
    const activeReactionCalls = streamingSource
      .split("\n")
      .filter(
        (line) =>
          !line.trimStart().startsWith("//") &&
          line.includes("setReaction") &&
          (line.includes('"🔥"') || line.includes('"🎉"'))
      );
    expect(activeReactionCalls).toEqual([]);
  });

  test("config no longer exports PROGRESS_REACTION_ENABLED", () => {
    const configSource = readFileSync(
      resolve(__dirname, "../../config/index.ts"),
      "utf-8"
    );
    const activeExports = configSource
      .split("\n")
      .filter(
        (line) =>
          line.includes("PROGRESS_REACTION_ENABLED") &&
          line.trimStart().startsWith("export")
      );
    expect(activeExports).toEqual([]);
  });
});

// ─── Scenario 3: STEERING_DELIVERED on Consume ───────────────────────

describe("Scenario 3 — STEERING_DELIVERED Reaction on Consume", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-delivered");
  });

  test("consumeSteeringWithIds returns message IDs alongside formatted text", () => {
    session.addSteering("msg1", 101);
    session.addSteering("msg2", 102);

    const result = session.consumeSteeringWithIds();
    expect(result).not.toBeNull();
    expect(result!.messageIds).toEqual([101, 102]);
    expect(result!.formatted).toContain("msg1");
    expect(result!.formatted).toContain("msg2");
  });

  test("consumeSteeringWithIds clears buffer after consumption", () => {
    session.addSteering("msg1", 101);
    session.consumeSteeringWithIds();
    expect(session.hasSteeringMessages()).toBe(false);
    expect(session.getSteeringCount()).toBe(0);
  });

  test("consumeSteeringWithIds returns null on empty buffer", () => {
    const result = session.consumeSteeringWithIds();
    expect(result).toBeNull();
  });

  test("consumeSteeringWithIds filters out undefined messageIds", () => {
    // addSteering with messageId=undefined should be filtered
    session.addSteering("no-id-msg", undefined as any);
    session.addSteering("has-id-msg", 201);

    const result = session.consumeSteeringWithIds();
    expect(result).not.toBeNull();
    // Only the valid messageId should be in the array
    expect(result!.messageIds).toEqual([201]);
    // But formatted text should include both messages
    expect(result!.formatted).toContain("no-id-msg");
    expect(result!.formatted).toContain("has-id-msg");
  });
});

// ─── Scenario 4: Interrupt Auto-Requeue ──────────────────────────────

describe("Scenario 4 — Interrupt Auto-Requeue", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-interrupt");
  });

  test("steering messages survive in buffer (not destructively extracted)", () => {
    session.addSteering("queued msg 1", 201);
    session.addSteering("queued msg 2", 202);

    // Verify messages are still in buffer
    expect(session.hasSteeringMessages()).toBe(true);
    expect(session.getSteeringCount()).toBe(2);

    // consumeSteeringWithIds should still return them
    const result = session.consumeSteeringWithIds();
    expect(result).not.toBeNull();
    expect(result!.messageIds).toEqual([201, 202]);
  });

  test("extractSteeringMessages on empty buffer returns empty array", () => {
    expect(session.hasSteeringMessages()).toBe(false);
    const extracted = session.extractSteeringMessages();
    expect(extracted).toEqual([]);
  });

  test("interrupt-flow.ts does not call extractSteeringMessages", () => {
    const interruptSource = readFileSync(
      resolve(__dirname, "./interrupt-flow.ts"),
      "utf-8"
    );
    const activeExtracts = interruptSource
      .split("\n")
      .filter(
        (line) =>
          line.includes("extractSteeringMessages") &&
          !line.trimStart().startsWith("//")
      );
    expect(activeExtracts).toEqual([]);
  });
});

// ─── Scenario 5: Error Path Steering Preservation ────────────────────

describe("Scenario 5 — Error Path Steering Preservation", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-error-preservation");
  });

  test("consumeSteering returns formatted content for preservation", () => {
    session.addSteering("important msg", 301);
    const preserved = session.consumeSteering();
    expect(preserved).not.toBeNull();
    expect(preserved).toContain("important msg");
  });

  test("preserved steering can be stored as nextQueryContext", () => {
    session.addSteering("important msg", 301);
    const preserved = session.consumeSteering();
    expect(preserved).not.toBeNull();

    // Simulate error path logic from query-flow.ts
    const lostCount = 1;
    session.nextQueryContext = { userId: 1, context: `[ERROR RECOVERY - ${lostCount} message(s)]\n${preserved}\n[END RECOVERY]` };

    expect(session.nextQueryContext!.context).toContain("important msg");
    expect(session.nextQueryContext!.context).toContain("ERROR RECOVERY");
    expect(session.nextQueryContext!.context).toContain("END RECOVERY");
  });

  test("multiple error recoveries accumulate in nextQueryContext", () => {
    // First error
    session.addSteering("msg1", 301);
    const preserved1 = session.consumeSteering()!;
    session.nextQueryContext = { userId: 1, context: `[ERROR RECOVERY - 1 message(s)]\n${preserved1}\n[END RECOVERY]` };

    // Second error (same user — accumulate)
    session.addSteering("msg2", 302);
    const preserved2 = session.consumeSteering()!;
    const existingCtx = session.nextQueryContext?.userId === 1 ? session.nextQueryContext.context : "";
    session.nextQueryContext = { userId: 1, context: `${existingCtx}\n[ERROR RECOVERY - 1 message(s)]\n${preserved2}\n[END RECOVERY]` };

    expect(session.nextQueryContext!.context).toContain("msg1");
    expect(session.nextQueryContext!.context).toContain("msg2");
  });

  test("query-flow.ts error path wraps ctx.reply in try-catch", () => {
    const queryFlowSource = readFileSync(
      resolve(__dirname, "./query-flow.ts"),
      "utf-8"
    );
    // The error recovery notification should be wrapped in try-catch
    const hasGuardedReply = queryFlowSource.includes(
      "Failed to notify user of error recovery"
    );
    expect(hasGuardedReply).toBe(true);
  });
});

// ─── Scenario 6: PendingRecovery Timeout ─────────────────────────────

describe("Scenario 6 — PendingRecovery Timeout Extension", () => {
  test("PENDING_RECOVERY_TIMEOUT_MS is 10 minutes (600_000ms)", () => {
    expect(PENDING_RECOVERY_TIMEOUT_MS).toBe(600_000);
  });

  test("pending recovery is accessible immediately after setting", () => {
    const session = new ClaudeSession("test-timeout");
    const messages = [
      { content: "test", messageId: 401, timestamp: Date.now() },
    ];
    session.setPendingRecovery(messages as any, 123);
    const recovery = session.getPendingRecovery();
    expect(recovery).not.toBeNull();
    expect(recovery!.messages).toHaveLength(1);
  });
});

// ─── Scenario 7: Interrupt Marker Protection ─────────────────────────

describe("Scenario 7 — Interrupt Marker Does Not Pollute Session", () => {
  test("query-flow.ts skips initial query for interrupt marker", () => {
    const queryFlowSource = readFileSync(
      resolve(__dirname, "./query-flow.ts"),
      "utf-8"
    );
    // The interrupt drain marker constant should exist
    expect(queryFlowSource).toContain("INTERRUPT_STEERING_MARKER");
    // isInterruptDrain check should exist
    expect(queryFlowSource).toContain("isInterruptDrain");
    // lastMessage should not be set for interrupt marker
    expect(queryFlowSource).toContain("if (!isInterruptDrain)");
  });

  test("interrupt-flow returns synthetic marker for pending steering", () => {
    const interruptSource = readFileSync(
      resolve(__dirname, "./interrupt-flow.ts"),
      "utf-8"
    );
    // Should return handled=false with synthetic message
    expect(interruptSource).toContain("handled: false");
    expect(interruptSource).toContain("인터럽트 후 대기 메시지 처리");
  });
});
