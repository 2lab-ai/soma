/**
 * P3-D: Serializer parity contract (issue #61)
 *
 * session.ts::saveSession and session-store.ts::saveSession must BOTH go
 * through `serializeSessionData`, so persisted files are byte-equal regardless
 * of which call site wrote them (saved_at excluded — it's a timestamp).
 *
 * Guards against accidental field drift between the two save paths.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "./session";
import { serializeSessionData } from "./session-serialize";
import type { ModelId } from "../../config/model";

const EXPECTED_FIELDS: readonly string[] = [
  "session_id",
  "saved_at",
  "working_dir",
  "contextWindowUsage",
  "contextWindowSize",
  "totalInputTokens",
  "totalOutputTokens",
  "totalQueries",
  "sessionStartTime",
  "lastUsedModel",
];

function createFullySetSession(): ClaudeSession {
  const session = new ClaudeSession("test:serialize:parity");
  session.sessionId = "fake-serialize-session-id";
  session.totalInputTokens = 111;
  session.totalOutputTokens = 222;
  session.totalQueries = 3;
  session.sessionStartTime = new Date("2026-04-17T00:00:00.000Z");
  session.contextWindowSize = 200_000;
  session.contextWindowUsage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
  };
  session.setLastUsedModel("claude-opus-4-7" as ModelId);
  return session;
}

describe("serializeSessionData parity (P3-D, issue #61)", () => {
  test("two consecutive calls produce identical output (saved_at excluded)", () => {
    const session = createFullySetSession();

    const first = serializeSessionData(session);
    const second = serializeSessionData(session);

    // Clone + blank saved_at on both sides so JSON.stringify can compare
    // the remaining fields byte-for-byte.
    const firstNormalized = { ...first, saved_at: "<timestamp>" };
    const secondNormalized = { ...second, saved_at: "<timestamp>" };
    expect(JSON.stringify(firstNormalized)).toBe(JSON.stringify(secondNormalized));
  });

  test("exposes exactly the expected 10 fields — no drift", () => {
    const session = createFullySetSession();
    const serialized = serializeSessionData(session);
    const keys = Object.keys(serialized);

    expect(keys.length).toBe(EXPECTED_FIELDS.length);
    for (const field of EXPECTED_FIELDS) {
      expect(keys).toContain(field);
    }
  });

  test("throws when session has no sessionId (contract)", () => {
    const session = new ClaudeSession("test:serialize:no-session-id");
    expect(() => serializeSessionData(session)).toThrow(/sessionId/);
  });

  test("lastUsedModel is present when set; absent-style (undefined) when null", () => {
    const sessionWithModel = createFullySetSession();
    const withModel = serializeSessionData(sessionWithModel);
    expect(withModel.lastUsedModel).toBe("claude-opus-4-7");

    const sessionNoModel = new ClaudeSession("test:serialize:no-model");
    sessionNoModel.sessionId = "sid-no-model";
    const noModel = serializeSessionData(sessionNoModel);
    expect(noModel.lastUsedModel).toBeUndefined();
  });

  test("saved_at is a valid ISO8601 string within plausible range", () => {
    const session = createFullySetSession();
    const before = Date.now();
    const serialized = serializeSessionData(session);
    const after = Date.now();

    const parsed = new Date(serialized.saved_at).getTime();
    expect(Number.isNaN(parsed)).toBe(false);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });
});
