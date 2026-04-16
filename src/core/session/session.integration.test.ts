/**
 * Integration tests for issue #61 lastUsedModel persistence.
 *
 * Covers:
 *  - P3-A: end-to-end SessionManager flow — legacy invalid model is filtered,
 *          first model-switch resets sessionId, persistence round-trips.
 *  - P3-E: restart + model switch across two "processes" using real fs with
 *          fresh FileSessionStore instances.
 *
 * ── Design notes ──
 *
 * The model-switch guard lives INSIDE sendMessageStreaming at session.ts:769.
 * Driving it end-to-end would require booting the Claude SDK, which is way
 * too heavy for a regression test and not the point. Instead, we replicate
 * the EXACT guard predicate from session.ts:769 via public getters/setters
 * (`getLastUsedModel`, `setLastUsedModel`, the public `sessionId` field).
 *
 * No private field reads — only public API. If the guard moves or changes,
 * tests must follow.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "fs";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ClaudeSession } from "./session";
import {
  FileSessionStore,
  getSessionFilePath,
  loadSession,
  saveSession,
} from "./session-store";
import type { SessionData } from "../../types/session";
import type { ModelId } from "../../config/model";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "soma-test-sessions-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Mirror of session.ts:769 model-switch guard. Public-API only.
 * Returns true if the guard would reset sessionId for this (session, model)
 * combination, false otherwise. Side-effect identical to the real path.
 */
function applyModelSwitchGuard(
  session: ClaudeSession,
  effectiveModel: ModelId
): boolean {
  const lastUsedModel = session.getLastUsedModel();
  if (session.sessionId && lastUsedModel && effectiveModel !== lastUsedModel) {
    session.sessionId = null;
    return true;
  }
  return false;
}

// ─── P3-A: end-to-end SessionManager flow ─────────────────────────────

describe("P3-A: lastUsedModel end-to-end flow (issue #61)", () => {
  test("legacy invalid model is filtered, first model-switch resets sessionId, save round-trips", async () => {
    const dir = await createTempDir();
    const sessionKey = "default:980000100:p3a";
    const fixturePath = getSessionFilePath(sessionKey, dir);

    // ── Arrange: write fixture with legacy/invalid lastUsedModel ──
    const legacyInvalidModel = "claude-opus-4-6"; // retired id, not in AVAILABLE_MODELS
    const workingDir = "/tmp/soma-test-p3a-workdir";
    const fixture: SessionData = {
      session_id: "fake-p3a-session-id",
      saved_at: new Date("2026-04-01T00:00:00Z").toISOString(),
      working_dir: workingDir,
      lastUsedModel: legacyInvalidModel as unknown as ModelId,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalQueries: 5,
      sessionStartTime: new Date("2026-04-01T00:00:00Z").toISOString(),
      contextWindowSize: 200_000,
      contextWindowUsage: null,
    };
    writeFileSync(fixturePath, JSON.stringify(fixture), "utf-8");

    // ── Act (1): load + restore into a ClaudeSession ──
    const loaded = loadSession(sessionKey, dir);
    expect(loaded).not.toBeNull();

    const session = new ClaudeSession(sessionKey, null, { workingDir });
    session.restoreFromData(loaded!);

    // ── Assert (1): parseLastUsedModel filters the unknown id to null ──
    expect(session.getLastUsedModel()).toBeNull();
    expect(session.sessionId).toBe("fake-p3a-session-id");

    // ── Act (2): trigger the model-switch guard with current default ──
    const currentDefaultModel: ModelId = "claude-opus-4-7";
    // First, simulate having a known model bound to the resumed sessionId.
    // In the real flow, query-flow.ts line 138 does exactly this: if
    // getLastUsedModel() !== effectiveModel, setLastUsedModel(effectiveModel)
    // and saveSession() so the persisted record is consistent.
    // That call means the first post-restart query doesn't actually trip
    // the model-switch guard yet — it RECORDS the current model for the
    // resumed sessionId. To also exercise the model-switch guard in the
    // same test, simulate a SECOND change (Opus 4.7 → Sonnet).
    session.setLastUsedModel(currentDefaultModel);
    saveSession(sessionKey, session, dir);

    // Now simulate a user /model switch to Sonnet.
    const sonnet: ModelId = "claude-sonnet-4-5-20250929";
    const wasReset = applyModelSwitchGuard(session, sonnet);

    // ── Assert (2): model-switch guard resets sessionId ──
    expect(wasReset).toBe(true);
    expect(session.sessionId).toBeNull();

    // ── Act (3): record new model + save, then reload ──
    session.setLastUsedModel(sonnet);
    // saveSession is a no-op when sessionId is null — simulate that a fresh
    // Claude session-id arrives from the SDK on the next query.
    session.sessionId = "fake-p3a-sonnet-session-id";
    saveSession(sessionKey, session, dir);

    const reloaded = loadSession(sessionKey, dir);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.lastUsedModel).toBe(sonnet);

    // Fresh session re-reads the persisted model.
    const sessionReloaded = new ClaudeSession(sessionKey, null, { workingDir });
    sessionReloaded.restoreFromData(reloaded!);
    expect(sessionReloaded.getLastUsedModel()).toBe(sonnet);
  });

  test("restoreFromData with a valid modern model preserves it", async () => {
    const dir = await createTempDir();
    const sessionKey = "default:980000101:p3a-modern";
    const fixturePath = getSessionFilePath(sessionKey, dir);

    const modernModel: ModelId = "claude-sonnet-4-5-20250929";
    const fixture: SessionData = {
      session_id: "fake-modern-id",
      saved_at: new Date("2026-04-15T00:00:00Z").toISOString(),
      working_dir: "/tmp/soma-test-p3a-modern",
      lastUsedModel: modernModel,
      totalInputTokens: 100,
      totalOutputTokens: 200,
      totalQueries: 2,
      sessionStartTime: new Date("2026-04-15T00:00:00Z").toISOString(),
    };
    writeFileSync(fixturePath, JSON.stringify(fixture), "utf-8");

    const session = new ClaudeSession(sessionKey, null, {
      workingDir: "/tmp/soma-test-p3a-modern",
    });
    session.restoreFromData(loadSession(sessionKey, dir)!);

    expect(session.getLastUsedModel()).toBe(modernModel);
  });
});

// ─── P3-E: restart + model switch with real fs ────────────────────────

describe("P3-E: restart + model switch across processes (issue #61)", () => {
  test("sonnet persisted → restart → switch to opus → restart → opus persisted", async () => {
    const dir = await createTempDir();
    const sessionKey = "default:980000200:p3e";
    const workingDir = "/tmp/soma-test-p3e-workdir";

    // ── Arrange: seed fs with a Sonnet session ──
    const sonnetModel: ModelId = "claude-sonnet-4-5-20250929";
    const initialFixture: SessionData = {
      session_id: "fake-p3e-sonnet-id",
      saved_at: new Date("2026-04-10T00:00:00Z").toISOString(),
      working_dir: workingDir,
      lastUsedModel: sonnetModel,
      totalInputTokens: 10,
      totalOutputTokens: 20,
      totalQueries: 1,
      sessionStartTime: new Date("2026-04-10T00:00:00Z").toISOString(),
      contextWindowSize: 200_000,
    };
    writeFileSync(
      getSessionFilePath(sessionKey, dir),
      JSON.stringify(initialFixture),
      "utf-8"
    );

    // ── Process 1: startup, load, confirm sonnet ──
    const store1 = new FileSessionStore(dir);
    const loaded1 = store1.loadSession(sessionKey);
    expect(loaded1).not.toBeNull();
    const session1 = new ClaudeSession(sessionKey, null, { workingDir });
    session1.restoreFromData(loaded1!);
    expect(session1.getLastUsedModel()).toBe(sonnetModel);
    expect(session1.sessionId).toBe("fake-p3e-sonnet-id");

    // ── Process 2: "restart" — second FileSessionStore instance reads the
    //    same file. Simulates a bot restart with the pre-migration state. ──
    const store2 = new FileSessionStore(dir);
    const loaded2 = store2.loadSession(sessionKey);
    const session2 = new ClaudeSession(sessionKey, null, { workingDir });
    session2.restoreFromData(loaded2!);
    expect(session2.getLastUsedModel()).toBe(sonnetModel);
    expect(session2.sessionId).toBe("fake-p3e-sonnet-id");

    // ── Act: simulate a new query with Opus as the effective model ──
    const opusModel: ModelId = "claude-opus-4-7";
    const wasReset = applyModelSwitchGuard(session2, opusModel);
    expect(wasReset).toBe(true);
    expect(session2.sessionId).toBeNull();

    // Record the new model (what query-flow.ts:138 does) + simulate the SDK
    // handing us a fresh session id on the first successful query.
    session2.setLastUsedModel(opusModel);
    session2.sessionId = "fake-p3e-opus-id";
    store2.saveSession(sessionKey, session2);

    // ── Process 3: another "restart" — read the now-updated file. ──
    const store3 = new FileSessionStore(dir);
    const loaded3 = store3.loadSession(sessionKey);
    expect(loaded3).not.toBeNull();
    expect(loaded3!.lastUsedModel).toBe(opusModel);
    expect(loaded3!.session_id).toBe("fake-p3e-opus-id");

    const session3 = new ClaudeSession(sessionKey, null, { workingDir });
    session3.restoreFromData(loaded3!);

    // ── Assert: post-restart state matches the last persisted write. ──
    expect(session3.getLastUsedModel()).toBe(opusModel);
    expect(session3.sessionId).toBe("fake-p3e-opus-id");

    // And the same-model guard does NOT reset — no spurious churn.
    const wasResetSameModel = applyModelSwitchGuard(session3, opusModel);
    expect(wasResetSameModel).toBe(false);
    expect(session3.sessionId).toBe("fake-p3e-opus-id");

    // Disk file still exists after the whole dance.
    expect(existsSync(getSessionFilePath(sessionKey, dir))).toBe(true);
  });
});
