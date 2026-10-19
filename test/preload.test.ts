/**
 * The suite must not touch the operator's real home directory.
 *
 * src/services/skills-registry.test.ts exercises ~/.claude/skills-registry.json
 * and its last case writes "{ invalid json ]". Against the real home, with no
 * registry to back up first, that corrupt file was left in the operator's
 * ~/.claude, which the live bot's /skills command then refuses to load.
 *
 * Bun caches os.homedir() at process start, so test/preload.ts can only
 * redirect $HOME; modules that resolve the home directory read $HOME first.
 */
import { expect, test } from "bun:test";
import { realpathSync } from "fs";
import { resolve, sep } from "path";
import { HOME_DIR } from "../src/config/env";

const scratchRoot = realpathSync(resolve(import.meta.dir, "..", ".test-tmp"));

test("$HOME points at a per-run scratch directory, not the operator's home", () => {
  expect((process.env.HOME ?? "").startsWith(scratchRoot + sep)).toBe(true);
});

test("config HOME_DIR (ALLOWED_PATHS defaults, skills registry root) follows $HOME", () => {
  expect(HOME_DIR).toBe(process.env.HOME ?? "");
});

test("CLAUDE_WORKING_DIR points at a per-run scratch directory", () => {
  expect((process.env.CLAUDE_WORKING_DIR ?? "").startsWith(scratchRoot + sep)).toBe(
    true
  );
});
