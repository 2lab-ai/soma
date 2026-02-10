import { describe, expect, test } from "bun:test";
import { createTelegramAuthPolicy } from "./auth-policy";

describe("createTelegramAuthPolicy", () => {
  test("delegates authorization to injected authorize function", () => {
    const calls: Array<{ userId: number; chatId: number; chatType?: string }> = [];
    const policy = createTelegramAuthPolicy((userId, chatId, chatType) => {
      calls.push({ userId, chatId, chatType });
      return chatType === "private";
    });

    expect(
      policy.evaluate({ userId: 1, chatId: 100, chatType: "private" }).authorized
    ).toBe(true);
    expect(
      policy.evaluate({ userId: 1, chatId: 200, chatType: "group" }).authorized
    ).toBe(false);
    expect(calls).toEqual([
      { userId: 1, chatId: 100, chatType: "private" },
      { userId: 1, chatId: 200, chatType: "group" },
    ]);
  });
});
