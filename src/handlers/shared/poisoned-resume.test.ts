/**
 * Tests for the shared poisoned-resume recovery wrapper.
 *
 * The tool-use-invariant / thinking-block-invariant 400s poison a resumed
 * session for EVERY entry point that resumes it (voice, photo, document,
 * callback, direct-input, scheduler, boot), not just the text handler. The
 * recovery used to live only inside runQueryFlow; `withPoisonedResumeRecovery`
 * lifts the unlink-transcript + reset-sessionId + retry-once-fresh behaviour
 * into one reusable wrapper those handlers share.
 */
import { describe, expect, test } from "bun:test";
import { ClaudeSession } from "../../core/session/session";
import {
  isPoisonedResumeError,
  withPoisonedResumeRecovery,
} from "./poisoned-resume";

const POISONED_ERRORS: readonly Error[] = [
  new Error("messages: tool_use ids were found without tool_result blocks"),
  new Error(
    "messages.1.content.23: `thinking` or `redacted_thinking` blocks must be the first content block"
  ),
];

const FAKE_RESUMED_ID = "fake-resumed-session-id";

function makeResumedSession(suffix: string): ClaudeSession {
  // Fake sessionKey → getSessionFilePath points at a non-existent transcript,
  // so performPoisonedResumeRecovery's unlink hits ENOENT (silent) and the test
  // stays hermetic while still asserting the in-memory sessionId reset.
  const session = new ClaudeSession(`default:999999999:poisoned-resume-${suffix}`);
  session.sessionId = FAKE_RESUMED_ID;
  return session;
}

describe("isPoisonedResumeError", () => {
  test("matches both tool-use and thinking-block invariant families", () => {
    for (const err of POISONED_ERRORS) {
      expect(isPoisonedResumeError(err)).toBe(true);
    }
  });

  test("does not match unrelated errors", () => {
    expect(isPoisonedResumeError(new Error("429 rate limit exceeded"))).toBe(false);
    expect(isPoisonedResumeError(new Error("EISDIR: directory"))).toBe(false);
  });
});

describe("withPoisonedResumeRecovery", () => {
  test("recovers on a resumed poisoned 400: resets sessionId + retries once fresh", async () => {
    for (const err of POISONED_ERRORS) {
      const session = makeResumedSession("recover");
      let calls = 0;
      let onRecoverCalls = 0;

      const result = await withPoisonedResumeRecovery(
        session,
        async () => {
          calls += 1;
          if (calls === 1) throw err;
          return "ok-after-recovery";
        },
        { onRecover: () => { onRecoverCalls += 1; } }
      );

      expect(result).toBe("ok-after-recovery");
      expect(calls).toBe(2); // first throws, retry succeeds
      expect(onRecoverCalls).toBe(1);
      expect(session.sessionId).toBeNull(); // transcript discarded → fresh session
    }
  });

  test("does NOT recover a fresh session (sessionIdAtStart === null) — rethrows", async () => {
    const session = makeResumedSession("fresh");
    session.sessionId = null; // never a resume
    let calls = 0;

    await expect(
      withPoisonedResumeRecovery(session, async () => {
        calls += 1;
        throw POISONED_ERRORS[0]!;
      })
    ).rejects.toThrow();
    expect(calls).toBe(1); // no retry
  });

  test("does NOT recover when canRecover() is false (output already streamed) — rethrows", async () => {
    const session = makeResumedSession("output");
    let calls = 0;

    await expect(
      withPoisonedResumeRecovery(
        session,
        async () => {
          calls += 1;
          throw POISONED_ERRORS[1]!;
        },
        { canRecover: () => false }
      )
    ).rejects.toThrow();
    expect(calls).toBe(1);
    expect(session.sessionId).toBe(FAKE_RESUMED_ID); // untouched
  });

  test("does NOT recover unrelated errors — rethrows immediately", async () => {
    const session = makeResumedSession("unrelated");
    let calls = 0;

    await expect(
      withPoisonedResumeRecovery(session, async () => {
        calls += 1;
        throw new Error("429 rate limit exceeded");
      })
    ).rejects.toThrow("429");
    expect(calls).toBe(1);
    expect(session.sessionId).toBe(FAKE_RESUMED_ID);
  });

  test("retries exactly once — a second poisoned failure is rethrown", async () => {
    const session = makeResumedSession("twice");
    let calls = 0;

    await expect(
      withPoisonedResumeRecovery(session, async () => {
        calls += 1;
        throw POISONED_ERRORS[0]!;
      })
    ).rejects.toThrow();
    expect(calls).toBe(2); // original + one retry, then give up
  });

  test("passes through the result untouched on the happy path (no error)", async () => {
    const session = makeResumedSession("happy");
    let calls = 0;
    const result = await withPoisonedResumeRecovery(session, async () => {
      calls += 1;
      return "first-try";
    });
    expect(result).toBe("first-try");
    expect(calls).toBe(1);
    expect(session.sessionId).toBe(FAKE_RESUMED_ID);
  });
});
