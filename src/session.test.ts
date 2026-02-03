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
