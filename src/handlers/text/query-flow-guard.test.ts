import { describe, expect, test } from "bun:test";

describe("BUG soma-reentry-v2: re-entrancy guard handled gracefully", () => {
  test("RED: isReentrancyError detects the guard error message", () => {
    const { isReentrancyError } = require("./query-flow-guard");
    expect(
      isReentrancyError(
        new Error(
          "sendMessageStreaming is already running. Concurrent calls are not supported."
        )
      )
    ).toBe(true);
    expect(isReentrancyError(new Error("some other error"))).toBe(false);
    expect(isReentrancyError(new Error("already running"))).toBe(true);
  });
});
