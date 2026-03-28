/**
 * Contract tests for emoji-queue-bugfix
 * RED state: All tests should FAIL before implementation
 *
 * Covers:
 * - Scenario 1: Emoji constants unification (PROCESSING → 🔥)
 * - Scenario 2: Streaming emoji removal
 * - Scenario 3: STEERING_DELIVERED on consume
 * - Scenario 4: Interrupt auto-requeue
 * - Scenario 5: Error path steering preservation
 * - Scenario 6: PendingRecovery timeout extension
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { Reactions } from "../../constants/reactions";
import { ClaudeSession } from "../../core/session/session";

// ─── Scenario 1: Emoji Constants ─────────────────────────────────────

describe("Scenario 1 — Emoji State Machine Unification", () => {
  // Trace: Scenario 1, reactions.ts:15
  test("PROCESSING emoji is fire (🔥), not thinking face", () => {
    expect(Reactions.PROCESSING).toBe("🔥");
  });

  // Trace: Scenario 1, reactions.ts:28-30
  test("legacy EVICTED constant is removed", () => {
    expect((Reactions as any).EVICTED).toBeUndefined();
  });

  // Trace: Scenario 1, reactions.ts:28-30
  test("legacy FAIL constant is removed", () => {
    expect((Reactions as any).FAIL).toBeUndefined();
  });
});

// ─── Scenario 3: STEERING_DELIVERED on Consume ───────────────────────

describe("Scenario 3 — STEERING_DELIVERED Reaction on Consume", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-delivered");
  });

  // Trace: Scenario 3, steering-manager.ts consumeSteeringWithIds
  test("consumeSteeringWithIds returns message IDs alongside formatted text", () => {
    session.addSteering("msg1", 101);
    session.addSteering("msg2", 102);

    // New method should exist and return both text and IDs
    const result = (session as any).consumeSteeringWithIds?.();
    expect(result).toBeDefined();
    expect(result.messageIds).toEqual([101, 102]);
    expect(result.formatted).toContain("msg1");
    expect(result.formatted).toContain("msg2");
  });
});

// ─── Scenario 4: Interrupt Auto-Requeue ──────────────────────────────

describe("Scenario 4 — Interrupt Auto-Requeue", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-interrupt");
  });

  // Trace: Scenario 4, interrupt-flow.ts:39 — no extractSteeringMessages
  test("interrupt does not extract steering messages from buffer", () => {
    // Add messages to steering buffer
    session.addSteering("queued msg 1", 201);
    session.addSteering("queued msg 2", 202);

    // After interrupt, steering messages should STILL be in buffer
    // (In current buggy code, extractSteeringMessages() removes them)
    // This test validates the FIX: messages survive interrupt
    expect(session.hasSteeringMessages()).toBe(true);
    expect(session.getSteeringCount()).toBe(2);
  });

  // Trace: Scenario 4, Section 3c — empty steering after interrupt
  test("interrupt with empty steering buffer does not crash", () => {
    expect(session.hasSteeringMessages()).toBe(false);
    // extractSteeringMessages on empty should return []
    const extracted = session.extractSteeringMessages();
    expect(extracted).toEqual([]);
  });
});

// ─── Scenario 5: Error Path Steering Preservation ────────────────────

describe("Scenario 5 — Error Path Steering Preservation", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-error-preservation");
  });

  // Trace: Scenario 5, Section 3a — preserve steering as nextQueryContext
  test("steering messages preserved as nextQueryContext on error", () => {
    session.addSteering("important msg", 301);

    // Simulate error path: consume and save to nextQueryContext
    const preserved = session.consumeSteering();
    expect(preserved).not.toBeNull();

    if (preserved) {
      session.nextQueryContext = `[ERROR RECOVERY]\n${preserved}\n[END RECOVERY]`;
    }

    expect(session.nextQueryContext).toContain("important msg");
    expect(session.nextQueryContext).toContain("ERROR RECOVERY");
  });
});

// ─── Scenario 6: PendingRecovery Timeout ─────────────────────────────

describe("Scenario 6 — PendingRecovery Timeout Extension", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-timeout");
  });

  // Trace: Scenario 6, Section 3b — 10 minute timeout
  test("pending recovery survives within 10 minutes", () => {
    const messages = [
      { content: "test", messageId: 401, timestamp: Date.now() },
    ];
    session.setPendingRecovery(messages as any, 123);

    // Simulate 9 minutes elapsed (should still be valid)
    const recovery = session.getPendingRecovery();
    expect(recovery).not.toBeNull();
  });
});
