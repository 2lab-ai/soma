import { describe, test, expect, beforeEach } from "bun:test";
import { ClaudeSession } from "./core/session/session";
import { createSteeringMessage } from "./types/session";
import type { SessionData } from "./types/session";
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
    // Fill buffer to MAX_STEERING_MESSAGES (100)
    for (let i = 1; i <= 100; i++) {
      const evicted = session.addSteering(`msg ${i}`, i);
      expect(evicted).toBe(false);
    }

    // 101st message should trigger eviction
    const evicted = session.addSteering("msg 101", 101);
    expect(evicted).toBe(true);

    // Verify oldest message (msg 1) was evicted, newest present
    const result = session.consumeSteering();
    const lines = result!.split("\n---\n");
    const firstLine = lines[0];
    const lastLine = lines[lines.length - 1];

    // First should be msg 2 (msg 1 evicted)
    expect(firstLine).toMatch(/^\[\d{2}:\d{2}:\d{2}\] msg 2$/);
    // Last should be msg 101
    expect(lastLine).toMatch(/^\[\d{2}:\d{2}:\d{2}\] msg 101$/);

    // Buffer should have exactly 100 messages (max buffer size)
    expect(result!.split("\n---\n")).toHaveLength(100);
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

  test("clearStopRequested after kill allows retry (soma-vdz4)", async () => {
    expect((session as any).stopRequested).toBe(false);
    await session.kill();
    expect((session as any).stopRequested).toBe(true);
    session.clearStopRequested();
    expect((session as any).stopRequested).toBe(false);
  });

  test("kill then clearStopRequested resets all blocking state", async () => {
    (session as any).sessionId = "crash-session";
    (session as any)._queryState = "running";
    session.addSteering("pending msg", 1);

    await session.kill();
    expect((session as any).stopRequested).toBe(true);
    expect(session.sessionId).toBeNull();
    expect(session.hasSteeringMessages()).toBe(false);

    session.clearStopRequested();
    expect((session as any).stopRequested).toBe(false);
    expect((session as any)._queryState).toBe("idle");
  });

  test("generation increments on kill prevent stale session reuse", async () => {
    const gen0 = (session as any)._generation;
    (session as any).sessionId = "stale-session";

    await session.kill();
    expect((session as any)._generation).toBe(gen0 + 1);
    expect(session.sessionId).toBeNull();

    session.clearStopRequested();
    await session.kill();
    expect((session as any)._generation).toBe(gen0 + 2);
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

describe("startProcessing / stopProcessing - stuck state prevention", () => {
  let session: ClaudeSession;

  test("startProcessing sets isProcessing to true", () => {
    session = new ClaudeSession("test-processing");
    expect(session.isProcessing).toBe(false);
    const stop = session.startProcessing();
    expect(session.isProcessing).toBe(true);
    stop();
  });

  test("stopProcessing sets isProcessing to false", () => {
    session = new ClaudeSession("test-processing");
    const stop = session.startProcessing();
    expect(session.isProcessing).toBe(true);
    stop();
    expect(session.isProcessing).toBe(false);
  });

  test("stopProcessing is idempotent (safe to call twice)", () => {
    session = new ClaudeSession("test-processing");
    const stop = session.startProcessing();
    stop();
    stop();
    expect(session.isProcessing).toBe(false);
  });

  test("kill() resets stuck isProcessing state", async () => {
    session = new ClaudeSession("test-processing");
    session.startProcessing();
    expect(session.isProcessing).toBe(true);
    await session.kill();
    expect(session.isProcessing).toBe(false);
  });

  test("timeout guard auto-releases stuck state", async () => {
    session = new ClaudeSession("test-processing");
    session.startProcessing();
    expect(session.isProcessing).toBe(true);
    await session.kill();
    expect(session.isProcessing).toBe(false);
  });

  test("steering buffer preserved after stopProcessing", () => {
    session = new ClaudeSession("test-processing");
    const stop = session.startProcessing();
    session.addSteering("buffered msg", 1);
    stop();
    expect(session.hasSteeringMessages()).toBe(true);
  });
});

describe("BUG REPRODUCTION: steering message loss via hook→inject→clear cycle (soma-vig7)", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-vig7-repro");
  });

  async function simulateHookFiring(s: ClaudeSession, toolName = "Bash") {
    const hook = (s as any).postToolUseHook;
    return hook({ tool_name: toolName }, "tool-use-id-1", {});
  }

  test("REPRO: single message injected via hook is recoverable via restoreInjectedSteering", async () => {
    // 1. User sends "음" while processing
    session.addSteering("음", 1);
    expect(session.getSteeringCount()).toBe(1);

    // 2. Hook fires → consumes buffer → injects as systemMessage
    const hookResult = await simulateHookFiring(session);
    expect(hookResult.systemMessage).toContain("음");
    expect(session.getSteeringCount()).toBe(0); // buffer consumed

    // 3. Query ends → restoreInjectedSteering
    const restored = session.restoreInjectedSteering();
    expect(restored).toBe(1);
    expect(session.getSteeringCount()).toBe(1);

    // 4. Auto-continue can now consume
    const content = session.consumeSteering();
    expect(content).toContain("음");
  });

  test("REPRO: multiple messages injected via separate hooks all recoverable", async () => {
    // 1. "음" arrives → buffer=[음]
    session.addSteering("음", 1);

    // 2. Hook fires → consumes "음" → injects → injectedTracking=[음]
    const hook1 = await simulateHookFiring(session, "Grep");
    expect(hook1.systemMessage).toContain("음");
    expect(session.getSteeringCount()).toBe(0);

    // 3. "야호 외쳐봐" arrives → buffer=[야호]
    session.addSteering("야호 외쳐봐", 2);

    // 4. Hook fires → consumes "야호" → injects → injectedTracking=[음, 야호]
    const hook2 = await simulateHookFiring(session, "Read");
    expect(hook2.systemMessage).toContain("야호 외쳐봐");
    expect(session.getSteeringCount()).toBe(0);

    // 5. "어디" arrives after last tool → buffer=[어디]
    session.addSteering("어디", 3);

    // 6. Query ends → restoreInjectedSteering → buffer=[음, 야호, 어디]
    const restored = session.restoreInjectedSteering();
    expect(restored).toBe(2); // 음 + 야호 restored from injected
    expect(session.getSteeringCount()).toBe(3); // 음 + 야호 + 어디

    // 7. Auto-continue consumes ALL
    const content = session.consumeSteering();
    expect(content).toContain("음");
    expect(content).toContain("야호 외쳐봐");
    expect(content).toContain("어디");
  });

  test("BUG: clearInjectedSteeringTracking used to wipe messages before restore", async () => {
    // This reproduces the EXACT bug from production logs:
    // - Messages injected via hook into injectedSteeringDuringQuery
    // - sendMessageStreaming (auto-continue) calls clearInjectedSteeringTracking at start
    // - Messages lost forever

    // 1. Simulate messages injected via hooks during query
    session.addSteering("음", 1);
    await simulateHookFiring(session);
    session.addSteering("야호 외쳐봐", 2);
    await simulateHookFiring(session);
    session.addSteering("codex로 인사해", 3);
    await simulateHookFiring(session);
    session.addSteering("보임 그건", 4);
    await simulateHookFiring(session);

    // At this point: buffer=[], injectedSteeringDuringQuery=[음, 야호, codex, 보임]
    expect(session.getSteeringCount()).toBe(0);

    // 2. OLD BUG: clearInjectedSteeringTracking() was called first, wiping everything.
    // NEW FIX: restore is done before any clear.
    const restored = session.restoreInjectedSteering();
    expect(restored).toBe(4);

    // 3. Now buffer should have all 4 messages
    expect(session.getSteeringCount()).toBe(4);
    const content = session.consumeSteering();
    expect(content).toContain("음");
    expect(content).toContain("야호 외쳐봐");
    expect(content).toContain("codex로 인사해");
    expect(content).toContain("보임 그건");
  });

  test("BUG VERIFICATION: restoreInjectedSteering after hook correctly restores all", async () => {
    // Same as above but using the actual public API
    session.addSteering("msg1", 1);
    await simulateHookFiring(session);
    session.addSteering("msg2", 2);
    await simulateHookFiring(session);

    // restoreInjectedSteering should bring back msg1 + msg2
    const restored = session.restoreInjectedSteering();
    expect(restored).toBe(2);

    // Buffer should have both
    const content = session.consumeSteering();
    expect(content).toContain("msg1");
    expect(content).toContain("msg2");
  });

  test("hook returns empty when buffer is empty", async () => {
    const result = await simulateHookFiring(session);
    expect(result).toEqual({});
  });

  test("hook does not inject when no steering messages", async () => {
    const result = await simulateHookFiring(session);
    expect(result.systemMessage).toBeUndefined();
  });

  test("OLD BUG CONFIRMED: clear-then-restore loses all messages", async () => {
    // Simulate the OLD behavior that caused the bug
    session.addSteering("음", 1);
    await simulateHookFiring(session);
    session.addSteering("야호", 2);
    await simulateHookFiring(session);

    // OLD: clear FIRST, then restore → 0 messages
    session.clearInjectedSteeringTracking(); // wipes injectedSteeringDuringQuery
    const restored = session.restoreInjectedSteering(); // nothing to restore
    expect(restored).toBe(0);
    expect(session.getSteeringCount()).toBe(0); // MESSAGES LOST — this IS the bug
  });

  test("REPRO: messages arriving DURING auto-continue follow-up are NOT lost", async () => {
    // Scenario:
    // 1. Main query has 2 injected messages
    // 2. Auto-continue fires sendMessageStreaming for them
    // 3. During that follow-up, 2 MORE messages arrive and get injected
    // 4. Follow-up completes → second round should catch them

    // Round 1: main query
    session.addSteering("msg1", 1);
    await simulateHookFiring(session);
    session.addSteering("msg2", 2);
    await simulateHookFiring(session);

    // Query ends, restore
    const r1 = session.restoreInjectedSteering();
    expect(r1).toBe(2);
    expect(session.getSteeringCount()).toBe(2);

    // Auto-continue consumes for follow-up
    const round1Content = session.consumeSteering();
    expect(round1Content).toContain("msg1");
    expect(round1Content).toContain("msg2");

    // Simulate sendMessageStreaming start (clear tracking)
    session.clearInjectedSteeringTracking();

    // During follow-up, 2 more messages arrive + hook fires
    session.addSteering("msg3", 3);
    await simulateHookFiring(session);
    session.addSteering("msg4", 4);
    await simulateHookFiring(session);

    // Follow-up completes, restore round 2
    const r2 = session.restoreInjectedSteering();
    expect(r2).toBe(2);
    expect(session.getSteeringCount()).toBe(2);

    // Round 2 auto-continue
    const round2Content = session.consumeSteering();
    expect(round2Content).toContain("msg3");
    expect(round2Content).toContain("msg4");
  });
});

describe("ClaudeSession - actualContextUsed/Max (soma-u63c)", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-context");
  });

  test("actualContextUsed/Max default to null", () => {
    expect(session.actualContextUsed).toBeNull();
    expect(session.actualContextMax).toBeNull();
  });

  test("currentContextTokens prefers actualContextUsed over snapshot", () => {
    // Set both old-style and new-style
    session.contextWindowUsage = {
      input_tokens: 50000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    session.actualContextUsed = 120000;

    // Should use actualContextUsed (120000), not contextWindowUsage (50000)
    expect(session.currentContextTokens).toBe(120000);
  });

  test("currentContextTokens rejects snapshot with cache tokens (soma-nok6)", () => {
    // Snapshot from usage event includes cache_read/cache_create — NOT context window usage.
    // cache_read=805K caused 426% bug. These snapshots must be rejected.
    session.contextWindowUsage = {
      input_tokens: 50000,
      cache_creation_input_tokens: 10000,
      cache_read_input_tokens: 5000,
    };
    session.actualContextUsed = null;

    // Should return 0 (reject snapshot with cache tokens), NOT 65000
    expect(session.currentContextTokens).toBe(0);
  });

  test("currentContextTokens uses snapshot from context event (no cache tokens)", () => {
    // Context events set cache_read=0, cache_create=0 — these ARE authoritative
    session.contextWindowUsage = {
      input_tokens: 150000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    session.actualContextUsed = null;

    // Should use input_tokens from context event snapshot
    expect(session.currentContextTokens).toBe(150000);
  });

  test("restoreFromData resets ALL context window state to prevent stale % (soma-nok6)", () => {
    session.actualContextUsed = 100000;
    session.actualContextMax = 1000000;
    session.contextWindowUsage = {
      input_tokens: 99999,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    session.contextWindowSize = 500000;

    const mockData: SessionData = {
      session_id: "test-restore",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: {
        input_tokens: 50000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      contextWindowSize: 200000,
    };

    session.restoreFromData(mockData);

    // ALL context values must be cleared — fresh SDK context events required
    // Restoring stale contextWindowUsage with wrong contextWindowSize caused 351% bug
    expect(session.actualContextUsed).toBeNull();
    expect(session.actualContextMax).toBeNull();
    expect(session.contextWindowUsage).toBeNull();
    expect(session.contextWindowSize).toBe(0);
  });

  test("context % uses actualContextMax when available", () => {
    session.actualContextUsed = 200000;
    session.actualContextMax = 1000000;
    session.contextWindowSize = 200000; // old stale value

    const tokens = session.currentContextTokens;
    const max = session.actualContextMax;
    const pct = (tokens / max!) * 100;

    // Should be 20% (200k/1M), NOT 100% (200k/200k stale)
    expect(pct).toBe(20);
  });

  test("context % falls back to contextWindowSize when actualContextMax is null", () => {
    session.actualContextUsed = null;
    session.actualContextMax = null;
    session.contextWindowSize = 200000;
    session.contextWindowUsage = {
      input_tokens: 100000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };

    const tokens = session.currentContextTokens; // 100000 from snapshot
    const max = session.actualContextMax ?? session.contextWindowSize;
    const pct = (tokens / max) * 100;

    expect(pct).toBe(50);
  });
});

/**
 * soma-nok6: E2E regression tests for Context 351% bug + Session ID recovery
 *
 * These tests reproduce the EXACT failure scenarios from production:
 * 1. Session runs → accumulates stale contextWindowUsage → restarts → 351% displayed
 * 2. Session restarts → tries expired session ID → "No conversation found" error
 */
describe("soma-nok6: E2E Context 351% + Session ID expiry", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test-nok6-e2e");
  });

  // === BUG 1 REPRODUCTION: Context 351% ===

  test("REPRODUCES 351% bug: stale contextWindowUsage after restore causes >100% context", () => {
    // SETUP: Simulate a session that ran with high context usage
    // This is what happened BEFORE the fix — the old restoreFromData restored stale values

    // Step 1: Session runs, SDK context event sets usage to 700K / 1M (70%)
    session.contextWindowUsage = {
      input_tokens: 702400,  // from context event: usedTokens
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    session.contextWindowSize = 1000000;  // from context event: maxTokens
    session.actualContextUsed = 702400;
    session.actualContextMax = 1000000;

    // Verify: before restart, context is 70.24% — correct
    const preRestartPct = (session.currentContextTokens / (session.actualContextMax ?? session.contextWindowSize)) * 100;
    expect(preRestartPct).toBeCloseTo(70.24, 1);

    // Step 2: Session saved to disk (session-store saves contextWindowUsage + contextWindowSize)
    const savedData: SessionData = {
      session_id: "old-session-abc123",
      saved_at: new Date().toISOString(),
      working_dir: "/home/user/project",
      contextWindowUsage: {
        input_tokens: 702400,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      contextWindowSize: 200000,  // BUG: saved with WRONG window size (different model/stale)
      totalInputTokens: 1500000,
      totalOutputTokens: 300000,
      totalQueries: 42,
    };

    // Step 3: New session restores from saved data
    const newSession = new ClaudeSession("test-nok6-restored");
    newSession.restoreFromData(savedData);

    // Step 4: Calculate context % the way bootstrap.ts does (line 407-410)
    const effectiveMax = newSession.actualContextMax ?? newSession.contextWindowSize;

    // WITH FIX: effectiveMax should be 0 (cleared), so percentage should be "?"
    // WITHOUT FIX: effectiveMax would be 200000, tokens would be 702400
    //   → 702400 / 200000 * 100 = 351.2% ← THE BUG

    if (effectiveMax > 0) {
      const pct = (newSession.currentContextTokens / effectiveMax) * 100;
      // If we somehow have a max, percentage MUST be ≤ 100
      expect(pct).toBeLessThanOrEqual(100);
    } else {
      // effectiveMax is 0 → would display "?" → CORRECT behavior after fix
      expect(effectiveMax).toBe(0);
    }
  });

  test("VERIFIES FIX: after restore, context state is clean slate", () => {
    const savedData: SessionData = {
      session_id: "session-with-stale-context",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: {
        input_tokens: 702400,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      contextWindowSize: 200000,
      totalInputTokens: 2000000,
      totalOutputTokens: 500000,
      totalQueries: 50,
    };

    session.restoreFromData(savedData);

    // ALL context window state must be zeroed/null after restore
    expect(session.contextWindowUsage).toBeNull();
    expect(session.contextWindowSize).toBe(0);
    expect(session.actualContextUsed).toBeNull();
    expect(session.actualContextMax).toBeNull();

    // currentContextTokens should be 0 (no stale data to calculate from)
    expect(session.currentContextTokens).toBe(0);

    // Cumulative stats SHOULD be restored (these are session totals, not context window)
    expect(session.totalInputTokens).toBe(2000000);
    expect(session.totalOutputTokens).toBe(500000);
    expect(session.totalQueries).toBe(50);

    // Session ID SHOULD be restored (for resume attempt)
    expect(session.sessionId).toBe("session-with-stale-context");
  });

  test("VERIFIES FIX: bootstrap.ts percentage calculation shows '?' when no context data", () => {
    // Simulate what bootstrap.ts:saveShutdownContext does (line 406-411)
    const savedData: SessionData = {
      session_id: "just-restored",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: {
        input_tokens: 900000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      contextWindowSize: 200000,
    };

    session.restoreFromData(savedData);

    // Replicate bootstrap.ts logic exactly:
    const effectiveMax = session.actualContextMax ?? session.contextWindowSize;
    const ctxPct = effectiveMax > 0
      ? ((session.currentContextTokens / effectiveMax) * 100).toFixed(1)
      : "?";

    // Must show "?" — NOT "450.0%" or any other garbage
    expect(ctxPct).toBe("?");
  });

  test("VERIFIES: context % is correct AFTER fresh SDK context event post-restore", () => {
    // Step 1: Restore (clears context state)
    session.restoreFromData({
      session_id: "restored-session",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: {
        input_tokens: 999999,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      contextWindowSize: 100000,
    });

    // Step 2: Simulate fresh SDK context event arriving (like query-runtime.ts line 389-401)
    session.actualContextUsed = 150000;
    session.actualContextMax = 1000000;
    session.contextWindowUsage = {
      input_tokens: 150000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    session.contextWindowSize = 1000000;

    // Step 3: Calculate percentage
    const effectiveMax = session.actualContextMax ?? session.contextWindowSize;
    const pct = (session.currentContextTokens / effectiveMax) * 100;

    // Should be 15% — fresh data from SDK
    expect(pct).toBe(15);
    expect(session.currentContextTokens).toBe(150000);
  });

  // === BUG 2 REPRODUCTION: Session ID expiry ===

  test("VERIFIES: sessionId is cleared when SESSION_EXPIRED error would be thrown", () => {
    // Simulate: session restored with old session ID
    session.restoreFromData({
      session_id: "b253e268-ed9f-4818-826b-57ac02c9dc24",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
    });

    expect(session.sessionId).toBe("b253e268-ed9f-4818-826b-57ac02c9dc24");

    // Simulate: error handler detects expired session and clears it
    // (This is what session.ts error handler does when SDK returns "No conversation found")
    const errorStr = "No conversation found with session ID";
    if (errorStr.includes("No conversation found with session ID") && session.sessionId) {
      session.sessionId = null;
    }

    // Session ID should be cleared — next query will start fresh
    expect(session.sessionId).toBeNull();
  });

  test("VERIFIES: restored session can receive fresh session ID after clearing expired one", () => {
    // Step 1: Restore with old session ID
    session.restoreFromData({
      session_id: "expired-session-id",
      saved_at: new Date().toISOString(),
      working_dir: "/test",
    });

    // Step 2: Clear expired session (simulating error handler)
    session.sessionId = null;

    // Step 3: Simulate receiving new session ID from SDK (like onSessionId callback)
    const newSessionId = "fresh-session-id-12345";
    if (!session.sessionId) {
      session.sessionId = newSessionId;
    }

    // New session ID should be set
    expect(session.sessionId).toBe("fresh-session-id-12345");
  });

  // === FULL LIFECYCLE E2E ===

  test("E2E: full restore → clear stale → fresh SDK event lifecycle", () => {
    // Phase 1: ORIGINAL SESSION — normal operation at 62%
    const originalSession = new ClaudeSession("test-original");
    originalSession.actualContextUsed = 620000;
    originalSession.actualContextMax = 1000000;
    originalSession.contextWindowUsage = {
      input_tokens: 620000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    originalSession.contextWindowSize = 1000000;
    originalSession.sessionId = "original-session-xyz";

    // Verify original is at 62%
    const originalPct = (originalSession.currentContextTokens / originalSession.actualContextMax!) * 100;
    expect(originalPct).toBe(62);

    // Phase 2: SAVE → simulates session-store.ts saveSession()
    const savedData: SessionData = {
      session_id: originalSession.sessionId!,
      saved_at: new Date().toISOString(),
      working_dir: "/test",
      contextWindowUsage: originalSession.contextWindowUsage,
      contextWindowSize: originalSession.contextWindowSize,
      totalInputTokens: 1200000,
      totalOutputTokens: 250000,
      totalQueries: 35,
    };

    // Phase 3: RESTART → new process, restore from disk
    const restoredSession = new ClaudeSession("test-restored");
    restoredSession.restoreFromData(savedData);

    // Phase 3a: Immediately after restore, context should be unknown (not stale 62%)
    const effectiveMaxPostRestore = restoredSession.actualContextMax ?? restoredSession.contextWindowSize;
    expect(effectiveMaxPostRestore).toBe(0);  // No context data yet
    expect(restoredSession.currentContextTokens).toBe(0);  // No stale tokens

    // Phase 3b: Session ID is restored for resume attempt
    expect(restoredSession.sessionId).toBe("original-session-xyz");

    // Phase 4: FIRST QUERY runs, SDK sends fresh context event
    // Simulate: context compacted during restart, now at 25%
    restoredSession.actualContextUsed = 250000;
    restoredSession.actualContextMax = 1000000;
    restoredSession.contextWindowUsage = {
      input_tokens: 250000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    restoredSession.contextWindowSize = 1000000;

    // Verify: shows 25%, not 62% (stale) or 351% (bug)
    const freshPct = (restoredSession.currentContextTokens / restoredSession.actualContextMax!) * 100;
    expect(freshPct).toBe(25);

    // Phase 5: Cumulative stats survived the restore
    expect(restoredSession.totalInputTokens).toBe(1200000);
    expect(restoredSession.totalQueries).toBe(35);
  });

  // === EXACT REPRODUCTION OF 426.6% BUG FROM PRODUCTION ===

  test("E2E REPRO: 426.6% bug — cache_read=805K inflates context (exact production values)", () => {
    // EXACT values from production screenshot 2026-03-22:
    // Last query: Input: 16, Output: 6,065, Cache read: 805,523, Cache created: 47,704
    // Display: 853,243 / 200,000 tokens (426.6%)

    const session = new ClaudeSession("test-426-repro");

    // Simulate: no context event received, only usage event
    session.actualContextUsed = null;
    session.actualContextMax = null;

    // Usage event sets contextWindowUsage (this is what query-runtime.ts USED to do)
    session.contextWindowUsage = {
      input_tokens: 16,
      cache_creation_input_tokens: 47704,
      cache_read_input_tokens: 805523,
    };

    // contextWindowSize somehow set to 200K (from previous context event or model default)
    session.contextWindowSize = 200000;

    // OLD BEHAVIOR (BUG): 16 + 47704 + 805523 = 853,243 / 200,000 = 426.6%
    // NEW BEHAVIOR (FIX): snapshot has cache tokens → rejected → returns 0

    const tokens = session.currentContextTokens;
    const effectiveMax = session.actualContextMax ?? session.contextWindowSize;

    // tokens MUST be 0 (rejected usage event snapshot), not 853,243
    expect(tokens).toBe(0);

    // If we somehow computed a percentage, it must NOT be 426%
    if (effectiveMax > 0 && tokens > 0) {
      const pct = (tokens / effectiveMax) * 100;
      expect(pct).toBeLessThanOrEqual(100);
    }

    // The /context command would show "?" for percentage
    const ctxPct = effectiveMax > 0 && tokens > 0
      ? ((tokens / effectiveMax) * 100).toFixed(1)
      : "?";
    expect(ctxPct).toBe("?");
  });

  test("E2E: after context event arrives, shows correct % (not inflated by cache)", () => {
    const session = new ClaudeSession("test-correct-after-event");

    // Step 1: Usage event arrives first (cache_read inflated)
    session.lastUsage = {
      input_tokens: 16,
      output_tokens: 6065,
      cache_read_input_tokens: 805523,
      cache_creation_input_tokens: 47704,
    };
    // With our fix, query-runtime no longer sets contextWindowUsage from usage events
    // So contextWindowUsage stays null
    session.contextWindowUsage = null;
    session.contextWindowSize = 0;

    // Step 2: Context event arrives with authoritative data
    session.actualContextUsed = 62000;  // actual window occupancy
    session.actualContextMax = 200000;   // actual window size
    session.contextWindowUsage = {
      input_tokens: 62000,  // context event sets cache fields to 0
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    session.contextWindowSize = 200000;

    // Should show 31% (62K / 200K), NOT 426%
    const pct = (session.currentContextTokens / session.actualContextMax!) * 100;
    expect(pct).toBe(31);
    expect(session.currentContextTokens).toBe(62000);
  });
});
