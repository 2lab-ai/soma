/**
 * Contract: the query identity a caller hands to `sendMessageStreaming`.
 *
 * The old signature took the actor as an OPTIONAL 5th positional argument
 * (`sendMessageStreaming(msg, cb, chatId, modelContext, queryUserId)`). Every
 * media handler forgot it once already (issue #79): in a group the permission
 * prompt then fell back to chat-level authorization and any authorized member
 * could approve another member's tool call. Optional-and-easy-to-forget is the
 * defect; `QueryContext.userId` is therefore REQUIRED, so an omitted actor is
 * a compile error rather than a silent authorization downgrade.
 *
 * The `@ts-expect-error` assertions below are the real test: `bun run
 * typecheck` fails if the omission ever stops being an error.
 */
import { describe, expect, test } from "bun:test";
import type { QueryContext } from "../../types/runtime";

describe("QueryContext — actor is structurally required", () => {
  test("omitting userId does not compile", () => {
    // @ts-expect-error — userId is required: a group query with no actor must
    // not compile into chat-level authorization.
    const missingActor: QueryContext = { chatId: -1009900001 };
    expect(missingActor.chatId).toBe(-1009900001);
  });

  test("an explicit chat-level context is still expressible", () => {
    // Deliberate, visible, greppable — not an accident of a forgotten argument.
    const chatLevel: QueryContext = { chatId: 555, userId: undefined };
    expect(chatLevel.userId).toBeUndefined();
  });

  test("a fully bound context carries chat and actor", () => {
    const bound: QueryContext = {
      chatId: -1009900001,
      userId: 990101,
      modelContext: "general",
    };
    expect(bound).toEqual({
      chatId: -1009900001,
      userId: 990101,
      modelContext: "general",
    });
  });
});
