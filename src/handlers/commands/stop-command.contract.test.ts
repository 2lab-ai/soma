import { describe, test, expect, beforeEach } from "bun:test";
import { ClaudeSession } from "../../core/session/session";

/**
 * Contract tests for /stop command behavior (Issue #24).
 *
 * Verifies:
 * 1. wasStoppedByUser flag is set on stop() and reset on startProcessing()
 * 2. Steering buffer is cleared after stop in handleStop flow
 * 3. Auto-continue loop respects wasStoppedByUser flag
 */
describe("/stop command — Issue #24", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-stop-contract");
  });

  describe("wasStoppedByUser flag lifecycle", () => {
    test("wasStoppedByUser is false initially", () => {
      expect(session.wasStoppedByUser).toBe(false);
    });

    test("wasStoppedByUser is set to true when stop() is called during preparing", async () => {
      // Put session into "preparing" state
      session.startProcessing();
      expect(session.isProcessing).toBe(true);

      // Stop during preparing (user-initiated)
      const result = await session.stop(true);
      expect(result).toBe("pending");
      expect(session.wasStoppedByUser).toBe(true);
    });

    test("wasStoppedByUser is reset to false on next startProcessing()", async () => {
      // Simulate user stop
      session.startProcessing();
      await session.stop(true);
      expect(session.wasStoppedByUser).toBe(true);

      // Simulate stopProcessing (from finally block)
      session.clearStopRequested();

      // New query starts — flag must reset
      const stopFn = session.startProcessing();
      expect(session.wasStoppedByUser).toBe(false);
      stopFn();
    });
  });

  describe("steering cleanup on stop", () => {
    test("steering messages can be discarded after stop (handleStop flow)", async () => {
      // Simulate: query is processing, user sent steering messages
      const stopProcessing = session.startProcessing();

      session.addSteering("follow-up 1", 101);
      session.addSteering("follow-up 2", 102);
      expect(session.getSteeringCount()).toBe(2);

      // handleStop flow: discard steering, then stop
      session.consumeSteering();
      session.clearInjectedSteeringTracking();

      expect(session.hasSteeringMessages()).toBe(false);
      expect(session.getSteeringCount()).toBe(0);

      // Then stop the query (user-initiated)
      const result = await session.stop(true);
      expect(result).toBe("pending");
      expect(session.wasStoppedByUser).toBe(true);

      stopProcessing();
    });

    test("wasStoppedByUser prevents auto-continue from processing steering", async () => {
      // Simulate: query finishes but stop was called
      const stopProcessing = session.startProcessing();

      // User sends messages during processing
      session.addSteering("should be ignored", 201);

      // User-initiated stop
      await session.stop(true);
      expect(session.wasStoppedByUser).toBe(true);

      // Auto-continue loop checks wasStoppedByUser BEFORE checking steering
      // This is the key behavioral test:
      // Even though steering exists, wasStoppedByUser should signal "don't process"
      expect(session.hasSteeringMessages()).toBe(true);
      expect(session.wasStoppedByUser).toBe(true);

      // The auto-continue code would do:
      // if (session.wasStoppedByUser) { session.consumeSteering(); break; }
      if (session.wasStoppedByUser) {
        session.consumeSteering();
        session.clearInjectedSteeringTracking();
      }
      expect(session.hasSteeringMessages()).toBe(false);

      stopProcessing();
    });
  });

  describe("stop() return values", () => {
    test("stop() returns false when not processing", async () => {
      const result = await session.stop();
      expect(result).toBe(false);
      // wasStoppedByUser should NOT be set when nothing was processing
      expect(session.wasStoppedByUser).toBe(false);
    });

    test("stop() returns 'pending' during preparing state", async () => {
      session.startProcessing();
      const result = await session.stop(true);
      expect(result).toBe("pending");
      expect(session.wasStoppedByUser).toBe(true);
    });

    test("stop() without userInitiated does NOT set wasStoppedByUser (interrupt case)", async () => {
      session.startProcessing();
      const result = await session.stop(); // no userInitiated — simulates ! interrupt
      expect(result).toBe("pending");
      expect(session.wasStoppedByUser).toBe(false); // interrupt must NOT trigger steering discard
    });
  });
});
