import { describe, expect, test } from "bun:test";
import { createTelegramOrderPolicy } from "./order-policy";

describe("createTelegramOrderPolicy", () => {
  test("accepts first message and newer messages", () => {
    const policy = createTelegramOrderPolicy();

    expect(
      policy.evaluate({
        chatId: 100,
        threadId: undefined,
        timestampMs: 1000,
        text: "first",
      })
    ).toEqual({
      accepted: true,
      interruptBypassApplied: false,
    });

    expect(
      policy.evaluate({
        chatId: 100,
        threadId: undefined,
        timestampMs: 2000,
        text: "newer",
      })
    ).toEqual({
      accepted: true,
      interruptBypassApplied: false,
    });
  });

  test("rejects out-of-order non-interrupt but allows interrupt bypass", () => {
    const policy = createTelegramOrderPolicy();
    policy.evaluate({
      chatId: 100,
      threadId: 5,
      timestampMs: 3000,
      text: "latest",
    });

    expect(
      policy.evaluate({
        chatId: 100,
        threadId: 5,
        timestampMs: 2000,
        text: "older",
      })
    ).toEqual({
      accepted: false,
      interruptBypassApplied: false,
    });

    expect(
      policy.evaluate({
        chatId: 100,
        threadId: 5,
        timestampMs: 1000,
        text: "! stop",
      })
    ).toEqual({
      accepted: true,
      interruptBypassApplied: true,
    });

    expect(
      policy.evaluate({
        chatId: 100,
        threadId: 5,
        timestampMs: 2500,
        text: "still old",
      })
    ).toEqual({
      accepted: false,
      interruptBypassApplied: false,
    });
  });
});
