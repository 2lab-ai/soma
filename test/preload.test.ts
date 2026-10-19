/**
 * The suite must not touch the operator's machine state.
 *
 * - src/services/skills-registry.test.ts exercises ~/.claude/skills-registry.json
 *   and its last case writes "{ invalid json ]"; against the real home that
 *   corrupt file was left in the operator's ~/.claude.
 * - Handler tests that reach the real download path write attachments under
 *   TEMP_DIR and append to the audit log — the live bot's /tmp/soma and log.
 * - Bun auto-loads the repo's .env (bot token, ALLOWED_PATHS, …) before the
 *   preload runs.
 *
 * Bun caches os.homedir() at process start, so test/preload.ts can only
 * redirect $HOME; modules that resolve the home directory read $HOME first.
 */
import { expect, test } from "bun:test";
import { realpathSync } from "fs";
import { resolve, sep } from "path";
import { AUDIT_LOG_PATH, TEMP_DIR } from "../src/config";
import { HOME_DIR } from "../src/config/env";

const scratchRoot = realpathSync(resolve(import.meta.dir, "..", ".test-tmp"));
const inScratch = (p: string | undefined) => (p ?? "").startsWith(scratchRoot + sep);

test("$HOME points at a per-run scratch directory, not the operator's home", () => {
  expect(inScratch(process.env.HOME)).toBe(true);
});

test("config HOME_DIR (ALLOWED_PATHS defaults, skills registry root) follows $HOME", () => {
  expect(HOME_DIR).toBe(process.env.HOME ?? "");
});

test.skipIf(process.env.SOMA_TEST_KEEP_WORKING_DIR === "1")(
  "CLAUDE_WORKING_DIR points at a per-run scratch directory",
  () => {
    expect(inScratch(process.env.CLAUDE_WORKING_DIR)).toBe(true);
  }
);

test("attachment staging dir and audit log are scratch paths", () => {
  expect(inScratch(TEMP_DIR)).toBe(true);
  expect(inScratch(AUDIT_LOG_PATH)).toBe(true);
});

test("the operator's ALLOWED_PATHS never reaches the suite", () => {
  expect(process.env.ALLOWED_PATHS).toBeUndefined();
});
