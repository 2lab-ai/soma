import { describe, test, expect, beforeEach } from "bun:test";
import { ClaudeSession } from "./session";
import { createSteeringMessage } from "./types";
import type { SessionData } from "./types";
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

  test("consumeSteering returns single message with timestamp", () => {
    session.addSteering("only message", 123);

    const result = session.consumeSteering();

    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\] only message$/);
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("consumeSteering joins multiple messages with separator and timestamps", () => {
    session.addSteering("first", 1);
    session.addSteering("second", 2);
    session.addSteering("third", 3);

    const result = session.consumeSteering();

    expect(result).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] first\n---\n\[\d{2}:\d{2}:\d{2}\] second\n---\n\[\d{2}:\d{2}:\d{2}\] third$/
    );
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("consumeSteering clears buffer after consumption", () => {
    session.addSteering("message", 1);

    session.consumeSteering();

    expect(session.consumeSteering()).toBeNull();
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("addSteering requires messageId", () => {
    session.addSteering("message with id", 999);

    expect(session.hasSteeringMessages()).toBe(true);
    const result = session.consumeSteering();
    expect(result).toMatch(/^\[\d{2}:\d{2}:\d{2}\] message with id$/);
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
    expect(pending).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] pending 1\n---\n\[\d{2}:\d{2}:\d{2}\] pending 2$/
    );
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("steering consumed via PreToolUse does not carry over", () => {
    const stopProcessing = session.startProcessing();

    session.addSteering("during processing 1", 1);
    session.addSteering("during processing 2", 2);

    expect(session.hasSteeringMessages()).toBe(true);

    // Simulating PreToolUse consuming the steering
    const consumed = session.consumeSteering();
    expect(consumed).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] during processing 1\n---\n\[\d{2}:\d{2}:\d{2}\] during processing 2$/
    );

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
    expect(pending).toMatch(
      /^\[\d{2}:\d{2}:\d{2}\] msg 1\n---\n\[\d{2}:\d{2}:\d{2}\] msg 2$/
    );
  });

  test("addSteering evicts oldest when MAX_STEERING_MESSAGES reached", () => {
    // Fill buffer to MAX_STEERING_MESSAGES (20)
    for (let i = 1; i <= 20; i++) {
      const evicted = session.addSteering(`msg ${i}`, i);
      expect(evicted).toBe(false);
    }

    // 21st message should trigger eviction
    const evicted = session.addSteering("msg 21", 21);
    expect(evicted).toBe(true);

    // Verify oldest message (msg 1) was evicted, newest present
    const result = session.consumeSteering();
    const lines = result!.split("\n---\n");
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];

    // First should be msg 2 (msg 1 evicted)
    expect(firstLine).toMatch(/^\[\d{2}:\d{2}:\d{2}\] msg 2$/);
    // Last should be msg 21
    expect(lastLine).toMatch(/^\[\d{2}:\d{2}:\d{2}\] msg 21$/);

    // Buffer should have exactly 20 messages
    expect(result!.split("\n---\n")).toHaveLength(20);
  });

  test("consumeSteering includes tool context when provided", () => {
    session.addSteering("message during tool", 123, "Bash");

    const result = session.consumeSteering();

    expect(result).toMatch(/\(during Bash\)/);
    expect(result).toMatch(
      /^\[\d{2}:\d{2}:\d{2} \(during Bash\)\] message during tool$/
    );
  });

  test("consumeSteering handles messages with and without receivedDuringTool", () => {
    session.addSteering("normal message", 1);
    session.addSteering("during read", 2, "Read");
    session.addSteering("another normal", 3);

    const result = session.consumeSteering();

    // Verify mixed formatting
    expect(result).toContain("normal message");
    expect(result).toContain("(during Read)");
    expect(result).toContain("another normal");
  });

  test("kill clears steering buffer", async () => {
    session.addSteering("message before kill", 1);
    session.addSteering("another message", 2);
    expect(session.hasSteeringMessages()).toBe(true);

    await session.kill();

    expect(session.hasSteeringMessages()).toBe(false);
    expect(session.consumeSteering()).toBeNull();
  });

  test("restoreFromData clears steering buffer", () => {
    session.addSteering("message before restore", 1);
    expect(session.hasSteeringMessages()).toBe(true);

    const mockData: SessionData = {
      session_id: "test-session-123",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: null,
      contextWindowSize: 200000,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      totalQueries: 5,
      sessionStartTime: new Date().toISOString(),
    };

    session.restoreFromData(mockData);

    expect(session.hasSteeringMessages()).toBe(false);
    expect(session.consumeSteering()).toBeNull();
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
    session.addSteering("test message", 456);

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
    session.choiceState = { type: "single", messageIds: [100] };
    session.setActivityState("waiting");
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
    expect(session.activityState).toBe("waiting");
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
    expect(session.activityState).toBe("waiting");
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
    try {
      throw new Error("Test error");
    } catch {
      session.setActivityState("idle");
    }

    expect(session.activityState).toBe("idle");
  });

  test("finally block guard: only resets if not already idle", () => {
    expect(session.activityState).toBe("idle");
    if (session.activityState !== "idle") {
      session.setActivityState("idle");
    }

    expect(session.activityState).toBe("idle");
  });

  test("expiration cleanup: directInput cleared independently", () => {
    const expiredTime = Date.now() - 6 * 60 * 1000;

    session.pendingDirectInput = {
      type: "single",
      messageId: 100,
      createdAt: expiredTime,
    };
    session.choiceState = { type: "single", messageIds: [100] };
    session.setActivityState("waiting");

    expect(Date.now() - session.pendingDirectInput.createdAt > 5 * 60 * 1000).toBe(
      true
    );

    session.clearDirectInput();
    session.clearChoiceState();

    expect(session.pendingDirectInput).toBeNull();
    expect(session.choiceState).toBeNull();
    expect(session.activityState).toBe("waiting");
  });

  test("parseTextChoice expiration: cleared independently", () => {
    const expiredTime = Date.now() - 6 * 60 * 1000;

    session.parseTextChoiceState = {
      type: "single",
      messageId: 100,
      createdAt: expiredTime,
    };
    session.setActivityState("waiting");
    session.clearParseTextChoice();

    expect(session.parseTextChoiceState).toBeNull();
    expect(session.activityState).toBe("waiting");
  });

  test("concurrent button clicks: state remains consistent", () => {
    session.choiceState = { type: "single", messageIds: [100] };
    session.setActivityState("waiting");

    expect(session.activityState).toBe("waiting");

    session.setActivityState("working");
    session.setActivityState("working");

    expect(session.activityState).toBe("working");
    expect(session.choiceState).not.toBeNull();
  });

  test("interrupt during waiting state: transitions cleanly", () => {
    session.choiceState = { type: "single", messageIds: [200] };
    session.pendingDirectInput = {
      type: "single",
      messageId: 200,
      createdAt: Date.now(),
    };
    session.setActivityState("waiting");

    session.clearDirectInput();
    session.clearChoiceState();
    session.setActivityState("working");

    expect(session.activityState).toBe("working");
    expect(session.pendingDirectInput).toBeNull();
    expect(session.choiceState).toBeNull();
  });

  test("finally block race condition: concurrent setActivityState calls", () => {
    session.setActivityState("working");

    let finallyExecuted = false;
    let errorHandlerExecuted = false;

    try {
      session.setActivityState("working");
      throw new Error("Simulated error");
    } catch {
      errorHandlerExecuted = true;
      session.setActivityState("idle");
    } finally {
      finallyExecuted = true;
      if (session.activityState !== "idle") {
        session.setActivityState("idle");
      }
    }

    expect(errorHandlerExecuted).toBe(true);
    expect(finallyExecuted).toBe(true);
    expect(session.activityState).toBe("idle");
  });
});

describe("ClaudeSession - injected steering restore (auto-continue)", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-injected-restore");
  });

  test("restoreInjectedSteering returns 0 when nothing to restore", () => {
    const count = session.restoreInjectedSteering();
    expect(count).toBe(0);
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("getSteeringCount returns correct buffer size", () => {
    expect(session.getSteeringCount()).toBe(0);

    session.addSteering("msg1", 1);
    expect(session.getSteeringCount()).toBe(1);

    session.addSteering("msg2", 2);
    expect(session.getSteeringCount()).toBe(2);
  });

  test("extractSteeringMessages returns and clears buffer", () => {
    session.addSteering("msg1", 1);
    session.addSteering("msg2", 2);

    const extracted = session.extractSteeringMessages();

    expect(extracted).toHaveLength(2);
    expect(extracted[0]!.content).toBe("msg1");
    expect(extracted[1]!.content).toBe("msg2");
    expect(session.hasSteeringMessages()).toBe(false);
    expect(session.getSteeringCount()).toBe(0);
  });

  test("extractSteeringMessages returns empty array when buffer empty", () => {
    const extracted = session.extractSteeringMessages();
    expect(extracted).toHaveLength(0);
  });

  test("clearInjectedSteeringTracking clears internal tracking", () => {
    // This is internal state, but we can test it indirectly
    // by checking that restoreInjectedSteering returns 0 after clearing
    session.clearInjectedSteeringTracking();
    expect(session.restoreInjectedSteering()).toBe(0);
  });

  test("peekSteering returns content without consuming", () => {
    session.addSteering("peek test", 1);

    const peeked = session.peekSteering();
    expect(peeked).toMatch(/peek test/);

    // Buffer should still have the message
    expect(session.hasSteeringMessages()).toBe(true);
    expect(session.getSteeringCount()).toBe(1);

    // Can still consume after peek
    const consumed = session.consumeSteering();
    expect(consumed).toMatch(/peek test/);
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("peekSteering returns null when buffer empty", () => {
    expect(session.peekSteering()).toBeNull();
  });

  test("full auto-continue simulation: text-only response", () => {
    // Simulate: user sends message during text-only Claude response
    // 1. Message added to buffer
    session.addSteering("user message during execution", 123);
    expect(session.hasSteeringMessages()).toBe(true);

    // 2. No tools used, so hook doesn't fire
    // 3. Query completes with messages in buffer
    // 4. restoreInjectedSteering called (nothing to restore)
    const restored = session.restoreInjectedSteering();
    expect(restored).toBe(0);

    // 5. hasSteeringMessages still true (messages never consumed)
    expect(session.hasSteeringMessages()).toBe(true);

    // 6. Auto-continue consumes and processes
    const content = session.consumeSteering();
    expect(content).toMatch(/user message during execution/);
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("full auto-continue simulation: tool-using response (hook fires)", () => {
    // Simulate: user sends message during tool-using Claude response
    // 1. Message added to buffer
    session.addSteering("message during tool", 123);
    expect(session.getSteeringCount()).toBe(1);

    // 2. Simulate postToolUseHook firing:
    //    - Copy to injectedSteeringDuringQuery (internal)
    //    - Consume buffer for systemMessage injection
    // We can't directly access injectedSteeringDuringQuery, but we can
    // simulate the behavior by extracting and manually tracking
    const messagesToInject = session.extractSteeringMessages();
    expect(messagesToInject).toHaveLength(1);
    expect(session.hasSteeringMessages()).toBe(false);

    // 3. Query completes, restoreInjectedSteering would restore
    //    But since we simulated extraction, buffer is empty
    //    In real code, injectedSteeringDuringQuery would have the messages

    // For proper testing, we need to directly test the session methods
    // This test confirms the individual pieces work correctly
  });

  test("multiple messages: some before hook, some after", () => {
    // Message 1 arrives before any tool
    session.addSteering("msg before tool", 1);

    // Simulate hook consuming msg1
    const beforeHook = session.consumeSteering();
    expect(beforeHook).toMatch(/msg before tool/);

    // Message 2 arrives after hook fired (between tools or after last tool)
    session.addSteering("msg after tool", 2);

    // At query end, buffer has msg2
    expect(session.hasSteeringMessages()).toBe(true);
    expect(session.getSteeringCount()).toBe(1);

    // restoreInjectedSteering would add msg1 back
    // (in real code, from injectedSteeringDuringQuery)
    // For this test, we manually add it back to simulate
    session.addSteering("msg before tool", 1); // simulating restore prepend

    // Now buffer has both messages
    expect(session.getSteeringCount()).toBe(2);

    // Auto-continue processes all
    const allMessages = session.consumeSteering();
    expect(allMessages).toMatch(/msg after tool/);
    expect(allMessages).toMatch(/msg before tool/);
  });

  test("kill returns lost messages for recovery", async () => {
    session.addSteering("important message 1", 1);
    session.addSteering("important message 2", 2);

    const result = await session.kill();

    expect(result.count).toBe(2);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.content).toBe("important message 1");
    expect(result.messages[1]!.content).toBe("important message 2");

    // Buffer should be cleared after kill
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("restoreFromData returns lost messages for recovery", () => {
    session.addSteering("message before restore", 1);

    const mockData: SessionData = {
      session_id: "new-session",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: null,
      contextWindowSize: 200000,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalQueries: 0,
    };

    const result = session.restoreFromData(mockData);

    expect(result.count).toBe(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.content).toBe("message before restore");
  });
});

describe("ClaudeSession - generation guard (soma-phy)", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-generation");
  });

  test("kill increments generation counter", async () => {
    const before = (session as any)._generation;
    await session.kill();
    const after = (session as any)._generation;
    expect(after).toBe(before + 1);
  });

  test("kill clears sessionId", async () => {
    (session as any).sessionId = "test-session-abc";
    expect(session.sessionId).toBe("test-session-abc");

    await session.kill();
    expect(session.sessionId).toBeNull();
  });

  test("kill sets stopRequested", async () => {
    expect((session as any).stopRequested).toBe(false);
    await session.kill();
    expect((session as any).stopRequested).toBe(true);
  });

  test("multiple kills increment generation each time", async () => {
    const initial = (session as any)._generation;
    await session.kill();
    await session.kill();
    await session.kill();
    expect((session as any)._generation).toBe(initial + 3);
  });

  test("kill resets all session state", async () => {
    (session as any).sessionId = "session-xyz";
    (session as any).totalInputTokens = 5000;
    (session as any).totalOutputTokens = 3000;
    (session as any).totalQueries = 10;
    session.addSteering("message", 1);

    await session.kill();

    expect(session.sessionId).toBeNull();
    expect(session.hasSteeringMessages()).toBe(false);
  });

  test("isActive returns false after kill", async () => {
    (session as any).sessionId = "active-session";
    expect(session.isActive).toBe(true);

    await session.kill();
    expect(session.isActive).toBe(false);
  });
});

describe("createSteeringMessage - factory validation", () => {
  test("creates valid steering message with all fields", () => {
    const msg = createSteeringMessage("test content", 123, "Bash");

    expect(msg.content).toBe("test content");
    expect(msg.messageId).toBe(123);
    expect(msg.receivedDuringTool).toBe("Bash");
    expect(typeof msg.timestamp).toBe("number");
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  test("creates valid steering message without optional tool", () => {
    const msg = createSteeringMessage("test content", 456);

    expect(msg.content).toBe("test content");
    expect(msg.messageId).toBe(456);
    expect(msg.receivedDuringTool).toBeUndefined();
  });

  test("trims whitespace from content", () => {
    const msg = createSteeringMessage("  spaced content  ", 789);

    expect(msg.content).toBe("spaced content");
  });

  test("throws error for empty content", () => {
    expect(() => createSteeringMessage("", 123)).toThrow("content cannot be empty");
  });

  test("throws error for whitespace-only content", () => {
    expect(() => createSteeringMessage("   ", 123)).toThrow("content cannot be empty");
  });

  test("throws error for negative messageId", () => {
    expect(() => createSteeringMessage("test", -1)).toThrow("positive integer");
  });

  test("throws error for zero messageId", () => {
    expect(() => createSteeringMessage("test", 0)).toThrow("positive integer");
  });

  test("throws error for non-integer messageId", () => {
    expect(() => createSteeringMessage("test", 12.5)).toThrow("positive integer");
  });

  test("converts empty tool string to undefined", () => {
    const msg = createSteeringMessage("test", 123, "");

    expect(msg.receivedDuringTool).toBeUndefined();
  });
});
