/**
 * P3-B + P3-C regression tests for the tool-use-invariant recovery branch
 * (issue #61).
 *
 * P3-B: false-positive guards — each arm of the 4-AND predicate must
 *       reject recovery independently.
 * P3-C: disk cleanup — recovery must unlinkSync() the transcript file and
 *       tolerate ENOENT silently.
 *
 * The recovery logic is refactored into two exported pure functions:
 *  - shouldRecoverFromToolInvariantError(error, sessionIdAtStart, state,
 *      attempt, maxRetries) — the 4-AND predicate.
 *  - performToolInvariantRecovery(session, transcriptPath) — disk + memory
 *      cleanup (unlink + sessionId = null).
 *
 * Both are called from the single production branch in runQueryFlow, so
 * unit-testing them IS the regression test for the branch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ClaudeSession } from "../../core/session/session";
import { getSessionFilePath } from "../../core/session/session-store";
import { StreamingState } from "../streaming";
import {
  performToolInvariantRecovery,
  shouldRecoverFromToolInvariantError,
} from "./query-flow";

const MAX_RETRIES = 1;

// Realistic tool-use invariant error messages seen in production (issue #61).
const TOOL_USE_INVARIANT_ERRORS: readonly Error[] = [
  new Error("API Error: 400 due to tool use concurrency issues. Retryable: false"),
  new Error("messages: tool_use ids were found without tool_result blocks"),
  new Error("Each tool_use_id must have a matching tool_result"),
];

const FAKE_RESUMED_SESSION_ID = "fake-resumed-session-id";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soma-test-query-flow-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeEmptyState(): StreamingState {
  return new StreamingState();
}

// ─── P3-B: false-positive guards ──────────────────────────────────────

describe("P3-B: shouldRecoverFromToolInvariantError false-positive guards (issue #61)", () => {
  test("happy path: all 4 conditions met → returns true", () => {
    const state = makeEmptyState();
    for (const error of TOOL_USE_INVARIANT_ERRORS) {
      expect(
        shouldRecoverFromToolInvariantError(
          error,
          FAKE_RESUMED_SESSION_ID,
          state,
          0,
          MAX_RETRIES
        )
      ).toBe(true);
    }
  });

  test("Test 1: sessionIdAtStart === null → recovery must NOT fire", () => {
    const state = makeEmptyState();
    for (const error of TOOL_USE_INVARIANT_ERRORS) {
      expect(
        shouldRecoverFromToolInvariantError(
          error,
          null, // R1: fresh session, not a resume → can't be stale tool_use from disk
          state,
          0,
          MAX_RETRIES
        )
      ).toBe(false);
    }
  });

  test("Test 2: state.textMessages.size > 0 → recovery must NOT fire", () => {
    const state = makeEmptyState();
    // Simulate that at least one text segment has been streamed to the user.
    state.textMessages.set(1, { message_id: 42 } as never);
    expect(state.textMessages.size).toBeGreaterThan(0);

    for (const error of TOOL_USE_INVARIANT_ERRORS) {
      expect(
        shouldRecoverFromToolInvariantError(
          error,
          FAKE_RESUMED_SESSION_ID,
          state,
          0,
          MAX_RETRIES
        )
      ).toBe(false);
    }
  });

  test("Test 3: state.toolMessages.length > 0 → recovery must NOT fire", () => {
    const state = makeEmptyState();
    state.toolMessages.push({ message_id: 100 } as never);
    expect(state.toolMessages.length).toBeGreaterThan(0);

    for (const error of TOOL_USE_INVARIANT_ERRORS) {
      expect(
        shouldRecoverFromToolInvariantError(
          error,
          FAKE_RESUMED_SESSION_ID,
          state,
          0,
          MAX_RETRIES
        )
      ).toBe(false);
    }
  });

  test("retry budget exhausted (attempt >= maxRetries) → recovery must NOT fire", () => {
    const state = makeEmptyState();
    expect(
      shouldRecoverFromToolInvariantError(
        TOOL_USE_INVARIANT_ERRORS[0]!,
        FAKE_RESUMED_SESSION_ID,
        state,
        MAX_RETRIES, // attempt === maxRetries → no budget left
        MAX_RETRIES
      )
    ).toBe(false);
  });

  test("error that is not a tool-use invariant → recovery must NOT fire", () => {
    const state = makeEmptyState();
    const unrelatedErrors: Error[] = [
      new Error("429 rate limit exceeded"),
      new Error("EISDIR: directory error"),
      new Error("exited with code 1"),
      new Error("operation aborted"),
    ];
    for (const error of unrelatedErrors) {
      expect(
        shouldRecoverFromToolInvariantError(
          error,
          FAKE_RESUMED_SESSION_ID,
          state,
          0,
          MAX_RETRIES
        )
      ).toBe(false);
    }
  });
});

// ─── P3-C: disk cleanup ───────────────────────────────────────────────

describe("P3-C: performToolInvariantRecovery disk cleanup (issue #61)", () => {
  test("Test 1: existing transcript .json is unlinked + sessionId cleared", async () => {
    const dir = await createTempDir();
    const sessionKey = "default:980000300:p3c-exists";
    const transcriptPath = getSessionFilePath(sessionKey, dir);

    const validJson = JSON.stringify({
      session_id: FAKE_RESUMED_SESSION_ID,
      saved_at: new Date().toISOString(),
      working_dir: "/tmp/soma-test-p3c",
      totalQueries: 3,
    });
    writeFileSync(transcriptPath, validJson, "utf-8");
    expect(existsSync(transcriptPath)).toBe(true);

    const session = new ClaudeSession(sessionKey);
    session.sessionId = FAKE_RESUMED_SESSION_ID;

    performToolInvariantRecovery(session, transcriptPath);

    expect(existsSync(transcriptPath)).toBe(false);
    expect(session.sessionId).toBeNull();
  });

  test("Test 2: missing transcript — ENOENT is silent + sessionId cleared", async () => {
    const dir = await createTempDir();
    const sessionKey = "default:980000301:p3c-missing";
    const transcriptPath = getSessionFilePath(sessionKey, dir);

    // Precondition: no file on disk.
    expect(existsSync(transcriptPath)).toBe(false);

    const session = new ClaudeSession(sessionKey);
    session.sessionId = FAKE_RESUMED_SESSION_ID;

    // Must not throw on ENOENT.
    expect(() => performToolInvariantRecovery(session, transcriptPath)).not.toThrow();

    // In-memory reset still happens.
    expect(session.sessionId).toBeNull();
    expect(existsSync(transcriptPath)).toBe(false);
  });

  test("performToolInvariantRecovery is idempotent — second call is a no-op on fs", async () => {
    const dir = await createTempDir();
    const sessionKey = "default:980000302:p3c-idempotent";
    const transcriptPath = getSessionFilePath(sessionKey, dir);

    writeFileSync(
      transcriptPath,
      JSON.stringify({ session_id: "x", working_dir: "/tmp", saved_at: "" }),
      "utf-8"
    );

    const session = new ClaudeSession(sessionKey);
    session.sessionId = FAKE_RESUMED_SESSION_ID;

    performToolInvariantRecovery(session, transcriptPath);
    expect(existsSync(transcriptPath)).toBe(false);
    expect(session.sessionId).toBeNull();

    // Restore a sessionId to mimic a fresh-session handshake, then call again.
    session.sessionId = "new-session-after-recovery";
    expect(() => performToolInvariantRecovery(session, transcriptPath)).not.toThrow();
    expect(session.sessionId).toBeNull();
  });
});
