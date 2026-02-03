import { describe, test, expect, beforeEach } from "bun:test";
import { ClaudeSession } from "./session";
import type { ChoiceState, DirectInputState } from "./types/user-choice";

describe("ClaudeSession - steering", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-steering");
  });

  test("initially has no steering messages", () => {
    expect(session.hasSteeringMessages()).toBe(false);
    expect(session.consumeSteering()).toBeNull();
  });

  test("addSteering buffers a single message", () => {
    session.addSteering("first message", 123);

    expect(session.hasSteeringMessages()).toBe(true);
  });

  test("consumeSteering returns single message without separator", () => {
    session.addSteering("only message", 123);

    const result = session.consumeSteering();

    expect(result).toBe("only message");
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("consumeSteering joins multiple messages with separator", () => {
    session.addSteering("first", 1);
    session.addSteering("second", 2);
    session.addSteering("third", 3);

    const result = session.consumeSteering();

    expect(result).toBe("first\n---\nsecond\n---\nthird");
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("consumeSteering clears buffer after consumption", () => {
    session.addSteering("message", 1);

    session.consumeSteering();

    expect(session.consumeSteering()).toBeNull();
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("addSteering works without messageId", () => {
    session.addSteering("no id message");

    expect(session.hasSteeringMessages()).toBe(true);
    expect(session.consumeSteering()).toBe("no id message");
  });

  test("startProcessing does NOT clear unconsumed steering (for next query)", () => {
    session.addSteering("will be kept", 1);

    const stopProcessing = session.startProcessing();
    expect(session.hasSteeringMessages()).toBe(true);

    stopProcessing();

    // Steering should be KEPT for next query (not cleared)
    expect(session.hasSteeringMessages()).toBe(true);
  });

  test("getPendingSteering returns and clears unconsumed steering", () => {
    session.addSteering("pending 1", 1);
    session.addSteering("pending 2", 2);

    const stopProcessing = session.startProcessing();
    stopProcessing();

    // Steering still there after stopProcessing
    expect(session.hasSteeringMessages()).toBe(true);

    // getPendingSteering retrieves and clears
    const pending = session.getPendingSteering();
    expect(pending).toBe("pending 1\n---\npending 2");
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("steering consumed via PreToolUse does not carry over", () => {
    const stopProcessing = session.startProcessing();

    session.addSteering("during processing 1", 1);
    session.addSteering("during processing 2", 2);

    expect(session.hasSteeringMessages()).toBe(true);

    // Simulating PreToolUse consuming the steering
    const consumed = session.consumeSteering();
    expect(consumed).toBe("during processing 1\n---\nduring processing 2");

    stopProcessing();
    // Nothing left after consumption
    expect(session.hasSteeringMessages()).toBe(false);
    expect(session.getPendingSteering()).toBeNull();
  });

  test("unconsumed steering survives multiple stopProcessing calls", () => {
    session.addSteering("msg 1", 1);

    let stopProcessing = session.startProcessing();
    stopProcessing();

    session.addSteering("msg 2", 2);

    stopProcessing = session.startProcessing();
    stopProcessing();

    // Both messages should be kept
    expect(session.hasSteeringMessages()).toBe(true);
    const pending = session.getPendingSteering();
    expect(pending).toBe("msg 1\n---\nmsg 2");
  });
});

describe("ClaudeSession - choiceState", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-session");
  });

  test("initializes with null choiceState", () => {
    expect(session.choiceState).toBeNull();
    expect(session.pendingDirectInput).toBeNull();
  });

  test("can set and track single choice state", () => {
    const choiceState: ChoiceState = {
      type: "single",
      messageIds: [12345],
    };

    session.choiceState = choiceState;

    expect(session.choiceState).not.toBeNull();
    expect(session.choiceState?.type).toBe("single");
    expect(session.choiceState?.messageIds).toEqual([12345]);
  });

  test("can set and track multi-form choice state", () => {
    const choiceState: ChoiceState = {
      type: "multi",
      formId: "form-abc",
      messageIds: [67890, 67891, 67892],
      selections: {
        q1: { choiceId: "1", label: "Option A" },
        q2: { choiceId: "2", label: "Option B" },
      },
    };

    session.choiceState = choiceState;

    expect(session.choiceState).not.toBeNull();
    expect(session.choiceState?.type).toBe("multi");
    expect(session.choiceState?.formId).toBe("form-abc");
    expect(session.choiceState?.selections?.q1?.label).toBe("Option A");
  });

  test("clearChoiceState() sets choiceState to null", () => {
    session.choiceState = {
      type: "single",
      messageIds: [123],
    };

    expect(session.choiceState).not.toBeNull();

    session.clearChoiceState();

    expect(session.choiceState).toBeNull();
  });

  test("can set and track direct input state", () => {
    const directInputState: DirectInputState = {
      type: "single",
      messageId: 11111,
      createdAt: Date.now(),
    };

    session.pendingDirectInput = directInputState;

    expect(session.pendingDirectInput).not.toBeNull();
    expect(session.pendingDirectInput?.type).toBe("single");
    expect(session.pendingDirectInput?.messageId).toBe(11111);
  });

  test("can set and track multi-form direct input state", () => {
    const directInputState: DirectInputState = {
      type: "multi",
      formId: "form-xyz",
      questionId: "q3",
      messageId: 22222,
      createdAt: Date.now(),
    };

    session.pendingDirectInput = directInputState;

    expect(session.pendingDirectInput).not.toBeNull();
    expect(session.pendingDirectInput?.formId).toBe("form-xyz");
    expect(session.pendingDirectInput?.questionId).toBe("q3");
  });

  test("clearDirectInput() sets pendingDirectInput to null", () => {
    session.pendingDirectInput = {
      type: "single",
      messageId: 999,
      createdAt: Date.now(),
    };

    expect(session.pendingDirectInput).not.toBeNull();

    session.clearDirectInput();

    expect(session.pendingDirectInput).toBeNull();
  });

  test("choiceState and directInput are independent", () => {
    session.choiceState = {
      type: "single",
      messageIds: [111],
    };

    session.pendingDirectInput = {
      type: "single",
      messageId: 222,
      createdAt: Date.now(),
    };

    expect(session.choiceState?.messageIds).toEqual([111]);
    expect(session.pendingDirectInput?.messageId).toBe(222);

    session.clearChoiceState();
    expect(session.choiceState).toBeNull();
    expect(session.pendingDirectInput).not.toBeNull();

    session.clearDirectInput();
    expect(session.pendingDirectInput).toBeNull();
  });
});

describe("ClaudeSession - activityState basics", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-activity-basics");
  });

  test("initializes with idle state", () => {
    expect(session.activityState).toBe("idle");
  });

  test("setActivityState changes to working", () => {
    session.setActivityState("working");
    expect(session.activityState).toBe("working");
  });

  test("setActivityState changes to waiting", () => {
    session.setActivityState("waiting");
    expect(session.activityState).toBe("waiting");
  });

  test("setActivityState changes back to idle", () => {
    session.setActivityState("working");
    session.setActivityState("idle");
    expect(session.activityState).toBe("idle");
  });

  test("multiple state changes work correctly", () => {
    expect(session.activityState).toBe("idle");
    session.setActivityState("working");
    expect(session.activityState).toBe("working");
    session.setActivityState("waiting");
    expect(session.activityState).toBe("waiting");
    session.setActivityState("idle");
    expect(session.activityState).toBe("idle");
  });
});

describe("ClaudeSession - activityState transitions", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-activity-transitions");
  });

  test("full lifecycle: idle → working → waiting → working → idle", () => {
    expect(session.activityState).toBe("idle");

    // Query starts
    session.setActivityState("working");
    expect(session.activityState).toBe("working");

    // Keyboard displayed
    session.setActivityState("waiting");
    expect(session.activityState).toBe("waiting");

    // User responds
    session.setActivityState("working");
    expect(session.activityState).toBe("working");

    // Query completes
    session.setActivityState("idle");
    expect(session.activityState).toBe("idle");
  });

  test("idempotent: setting same state twice", () => {
    session.setActivityState("working");
    session.setActivityState("working");
    expect(session.activityState).toBe("working");

    session.setActivityState("waiting");
    session.setActivityState("waiting");
    expect(session.activityState).toBe("waiting");
  });

  test("skip transition: idle → waiting (valid but unusual)", () => {
    expect(session.activityState).toBe("idle");
    session.setActivityState("waiting");
    expect(session.activityState).toBe("waiting");
  });

  test("error recovery: working → idle", () => {
    session.setActivityState("working");
    // Simulating error recovery (finally block or explicit error handling)
    session.setActivityState("idle");
    expect(session.activityState).toBe("idle");
  });

  test("state preserved across other operations", () => {
    session.setActivityState("waiting");

    // Other session operations
    session.choiceState = { type: "single", messageIds: [123] };
    session.addSteering("test message");

    // State should remain unchanged
    expect(session.activityState).toBe("waiting");

    session.clearChoiceState();
    expect(session.activityState).toBe("waiting");
  });

  test("multi-form partial completion: stays in waiting", () => {
    session.setActivityState("waiting");

    // Simulate partial multi-form completion
    session.choiceState = {
      type: "multi",
      messageIds: [1, 2, 3],
      selections: { q1: { choiceId: "1", label: "Answer 1" } },
    };

    // State should stay waiting until all questions answered
    expect(session.activityState).toBe("waiting");
  });
});

describe("ClaudeSession - activityState coordination", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-coordination");
  });

  test("choiceState cleared when transitioning waiting → working", () => {
    session.choiceState = {
      type: "single",
      messageIds: [100],
    };
    session.setActivityState("waiting");

    // Simulate user selection
    session.clearChoiceState();
    session.setActivityState("working");

    expect(session.choiceState).toBeNull();
    expect(session.activityState).toBe("working");
  });

  test("directInput cleared independently of activityState", () => {
    session.pendingDirectInput = {
      type: "single",
      messageId: 100,
      createdAt: Date.now(),
    };
    session.setActivityState("waiting");

    session.clearDirectInput();

    expect(session.pendingDirectInput).toBeNull();
    expect(session.activityState).toBe("waiting"); // State unchanged
  });

  test("parseTextChoice cleared independently of activityState", () => {
    session.parseTextChoiceState = {
      type: "single",
      messageId: 100,
      createdAt: Date.now(),
    };
    session.setActivityState("waiting");

    session.clearParseTextChoice();

    expect(session.parseTextChoiceState).toBeNull();
    expect(session.activityState).toBe("waiting"); // State unchanged
  });

  test("multi-form completion: choiceState cleared, state transitions working", () => {
    session.choiceState = {
      type: "multi",
      messageIds: [1, 2],
      selections: {
        q1: { choiceId: "a", label: "A" },
        q2: { choiceId: "b", label: "B" },
      },
    };
    session.setActivityState("waiting");

    // Simulate all questions answered
    const allAnswered =
      Object.keys(session.choiceState.selections!).length === 2;
    expect(allAnswered).toBe(true);

    session.clearChoiceState();
    session.setActivityState("working");

    expect(session.choiceState).toBeNull();
    expect(session.activityState).toBe("working");
  });
});

describe("ClaudeSession - activityState error handling", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-error-handling");
  });

  test("error during working: resets to idle", () => {
    session.setActivityState("working");

    // Simulate error handling (what sendDirectInputToClaude does)
    try {
      throw new Error("Test error");
    } catch {
      session.setActivityState("idle");
    }

    expect(session.activityState).toBe("idle");
  });

  test("finally block guard: only resets if not already idle", () => {
    // Already idle
    expect(session.activityState).toBe("idle");

    // Simulate finally block logic from session.ts:814
    if (session.activityState !== "idle") {
      session.setActivityState("idle");
    }

    expect(session.activityState).toBe("idle");
  });

  test("expiration cleanup: directInput cleared, state can be set separately", () => {
    session.pendingDirectInput = {
      type: "single",
      messageId: 100,
      createdAt: Date.now() - 6 * 60 * 1000, // Expired (> 5 min)
    };
    session.choiceState = { type: "single", messageIds: [100] };
    session.setActivityState("waiting");

    // Simulate expiration handler (text.ts:61-65)
    const FIVE_MINUTES = 5 * 60 * 1000;
    const expired = Date.now() - session.pendingDirectInput.createdAt > FIVE_MINUTES;
    expect(expired).toBe(true);

    session.clearDirectInput();
    session.clearChoiceState();

    expect(session.pendingDirectInput).toBeNull();
    expect(session.choiceState).toBeNull();
    // Activity state unchanged by cleanup (would be set by handler)
    expect(session.activityState).toBe("waiting");
  });

  test("parseTextChoice expiration: state cleared independently", () => {
    session.parseTextChoiceState = {
      type: "single",
      messageId: 100,
      createdAt: Date.now() - 6 * 60 * 1000, // Expired
    };
    session.setActivityState("waiting");

    // Simulate expiration check (text.ts:288-291)
    const FIVE_MINUTES = 5 * 60 * 1000;
    const expired = Date.now() - session.parseTextChoiceState.createdAt > FIVE_MINUTES;
    expect(expired).toBe(true);

    session.clearParseTextChoice();

    expect(session.parseTextChoiceState).toBeNull();
    expect(session.activityState).toBe("waiting");
  });

  test("concurrent button clicks: state remains consistent", () => {
    // Setup: User clicks button, keyboard displayed, waiting state
    session.choiceState = {
      type: "single",
      messageIds: [100],
    };
    session.setActivityState("waiting");

    // Simulate: User clicks button again before first handler completes
    const initialState = session.activityState;
    expect(initialState).toBe("waiting");

    // Rapid state transitions (simulating concurrent callbacks)
    session.setActivityState("working"); // First click handler
    session.setActivityState("working"); // Second click (should be idempotent)

    // Verify: State consistent, no corruption
    expect(session.activityState).toBe("working");
    expect(session.choiceState).not.toBeNull(); // Not cleared yet
  });

  test("interrupt during waiting state: transitions cleanly", () => {
    // Setup: Keyboard displayed, user in waiting state
    session.choiceState = {
      type: "single",
      messageIds: [200],
    };
    session.pendingDirectInput = {
      type: "single",
      messageId: 200,
      createdAt: Date.now(),
    };
    session.setActivityState("waiting");

    expect(session.activityState).toBe("waiting");
    expect(session.pendingDirectInput).not.toBeNull();

    // Simulate: User sends interrupt message (text.ts handles with checkInterrupt)
    // Interrupt should clear pending state and transition to working
    session.clearDirectInput();
    session.clearChoiceState();
    session.setActivityState("working");

    // Verify: Clean transition, no orphaned state
    expect(session.activityState).toBe("working");
    expect(session.pendingDirectInput).toBeNull();
    expect(session.choiceState).toBeNull();
  });

  test("finally block race condition: concurrent setActivityState calls", () => {
    session.setActivityState("working");

    // Simulate race: Handler still running while finally block executes
    let finallyExecuted = false;
    let errorHandlerExecuted = false;

    try {
      // Main handler sets working
      session.setActivityState("working");
      throw new Error("Simulated error");
    } catch {
      // Error handler tries to set idle
      errorHandlerExecuted = true;
      session.setActivityState("idle");
    } finally {
      // Finally block guard (session.ts:814-816 pattern)
      finallyExecuted = true;
      if (session.activityState !== "idle") {
        session.setActivityState("idle");
      }
    }

    // Verify: Both handlers executed, state is idle, no corruption
    expect(errorHandlerExecuted).toBe(true);
    expect(finallyExecuted).toBe(true);
    expect(session.activityState).toBe("idle");
  });
});
