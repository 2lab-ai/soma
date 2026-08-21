import { describe, expect, test } from "bun:test";
import { POLLED_UPDATE_TYPES } from "./bootstrap";

/**
 * Regression: choa-bot (2026-08-21) polled a token whose persisted
 * `allowed_updates` was a stale `["message"]`, so the /model menu rendered but
 * every button press was dropped by Telegram before reaching the bot — no
 * error, no log line. The runner must therefore name every update type the
 * handlers rely on instead of inheriting per-token server state.
 */
describe("POLLED_UPDATE_TYPES", () => {
  test("asks for callback_query — inline keyboards (/model, /skills) are dead without it", () => {
    expect(POLLED_UPDATE_TYPES).toContain("callback_query");
  });

  test("covers every update type registerBotHandlers listens for", () => {
    expect([...POLLED_UPDATE_TYPES].sort()).toEqual([
      "callback_query",
      "message",
      "my_chat_member",
    ]);
  });
});
