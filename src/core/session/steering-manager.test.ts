/**
 * Unit tests for SteeringManager — specifically extractSteeringMessages()
 * which must recover both steeringBuffer AND injectedSteeringDuringQuery.
 *
 * Covers fix for: https://github.com/2lab-ai/soma/issues/32
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { SteeringManager } from "./steering-manager";

const MAX_STEERING = 10;
const RECOVERY_TIMEOUT = 60_000;

function makeManager(): SteeringManager {
  return new SteeringManager(MAX_STEERING, RECOVERY_TIMEOUT);
}

describe("SteeringManager.extractSteeringMessages", () => {
  let mgr: SteeringManager;

  beforeEach(() => {
    mgr = makeManager();
  });

  test("returns empty array when nothing buffered", () => {
    expect(mgr.extractSteeringMessages()).toEqual([]);
  });

  test("returns steeringBuffer messages and clears buffer", () => {
    mgr.addSteering("msg1", 1);
    mgr.addSteering("msg2", 2);

    const extracted = mgr.extractSteeringMessages();
    expect(extracted).toHaveLength(2);
    expect(extracted[0]!.content).toBe("msg1");
    expect(extracted[1]!.content).toBe("msg2");

    // Buffer should be empty after extraction
    expect(mgr.extractSteeringMessages()).toEqual([]);
  });

  test("returns injectedSteeringDuringQuery messages (issue #32 fix)", () => {
    // Simulate: messages added, then tracked for injection (PostToolUse hook),
    // then buffer consumed by auto-continue → injectedSteeringDuringQuery has
    // messages but steeringBuffer is empty.
    mgr.addSteering("injected1", 10, "Bash");
    mgr.addSteering("injected2", 11, "Read");
    mgr.trackBufferedMessagesForInjection();
    mgr.consumeSteering(); // auto-continue consumes the buffer

    // At this point: steeringBuffer=[], injectedSteeringDuringQuery=[msg10,msg11]
    // hasSteeringMessages() now checks both stores (fix #32)
    expect(mgr.hasSteeringMessages()).toBe(true);

    const extracted = mgr.extractSteeringMessages();
    expect(extracted).toHaveLength(2);
    expect(extracted[0]!.content).toBe("injected1");
    expect(extracted[0]!.receivedDuringTool).toBe("Bash");
    expect(extracted[1]!.content).toBe("injected2");
    expect(extracted[1]!.receivedDuringTool).toBe("Read");
  });

  test("returns combined messages from both stores without duplicates", () => {
    // msg1 injected, msg2 still in buffer → both recovered, no duplication
    mgr.addSteering("old-injected", 20, "Bash");
    mgr.trackBufferedMessagesForInjection();
    // Don't consume — so msg 20 is in BOTH injected and buffer
    mgr.addSteering("new-buffered", 21);

    const extracted = mgr.extractSteeringMessages();
    // msg 20 should appear once (from injected), msg 21 from buffer
    expect(extracted).toHaveLength(2);
    expect(extracted.map((m) => m.messageId)).toEqual([20, 21]);
  });

  test("deduplicates messages present in both stores by messageId", () => {
    mgr.addSteering("same-msg", 30, "Bash");
    mgr.trackBufferedMessagesForInjection();
    // msg 30 is now in BOTH injectedSteeringDuringQuery AND steeringBuffer

    const extracted = mgr.extractSteeringMessages();
    expect(extracted).toHaveLength(1);
    expect(extracted[0]!.messageId).toBe(30);
    expect(extracted[0]!.content).toBe("same-msg");
  });

  test("clears both stores after extraction", () => {
    mgr.addSteering("a", 40);
    mgr.trackBufferedMessagesForInjection();
    mgr.addSteering("b", 41);

    mgr.extractSteeringMessages();

    // Both stores empty
    expect(mgr.extractSteeringMessages()).toEqual([]);
    expect(mgr.getInjectedCount()).toBe(0);
    expect(mgr.getSteeringCount()).toBe(0);
  });

  test("preserves chronological order: injected first, then buffered", () => {
    mgr.addSteering("first", 50);
    mgr.trackBufferedMessagesForInjection();
    mgr.consumeSteering();
    mgr.addSteering("second", 51);

    const extracted = mgr.extractSteeringMessages();
    expect(extracted[0]!.content).toBe("first");
    expect(extracted[1]!.content).toBe("second");
  });
});

describe("SteeringManager.hasSteeringMessages", () => {
  test("returns true when only injectedSteeringDuringQuery has messages", () => {
    const mgr = makeManager();
    mgr.addSteering("injected", 60, "Bash");
    mgr.trackBufferedMessagesForInjection();
    mgr.consumeSteering(); // buffer empty, injected has 1

    // Before fix: would return false (only checked steeringBuffer)
    expect(mgr.hasSteeringMessages()).toBe(true);
  });

  test("returns false when both stores are empty", () => {
    const mgr = makeManager();
    expect(mgr.hasSteeringMessages()).toBe(false);
  });

  test("returns true when only steeringBuffer has messages", () => {
    const mgr = makeManager();
    mgr.addSteering("buffered", 61);
    expect(mgr.hasSteeringMessages()).toBe(true);
  });
});

describe("SteeringManager.reset", () => {
  test("clears all state", () => {
    const mgr = makeManager();
    mgr.addSteering("x", 1);
    mgr.trackBufferedMessagesForInjection();
    mgr.addSteering("y", 2);
    mgr.setPendingRecovery([], 999);

    mgr.reset();

    expect(mgr.extractSteeringMessages()).toEqual([]);
    expect(mgr.getInjectedCount()).toBe(0);
    expect(mgr.getSteeringCount()).toBe(0);
    expect(mgr.hasPendingRecovery()).toBe(false);
    expect(mgr.evictionCount).toBe(0);
  });
});
