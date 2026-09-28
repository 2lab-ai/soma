/**
 * bun test preload — isolate the suite from the operator's live bot state.
 *
 * Bun auto-loads `.env` from the repo root, and in a checkout used to run a
 * bot that file carries `CLAUDE_WORKING_DIR=<live bot dir>`. `src/config/model.ts`
 * resolves `model-config.yaml` from that directory at import time and
 * `loadConfig` writes back on migration, so an un-isolated `bun test` rewrites a
 * production bot's config while the running bot's file watcher rewrites it back
 * (2026-09-28: p9 config storm, 2560 writes, file left with a NUL tail).
 *
 * Point every test process at a fresh scratch directory instead. It lives
 * inside the repo (`.test-tmp/`, gitignored) rather than under the OS tmpdir
 * because the permission tests assert that `/var/folders` never appears in the
 * advertised roots, and because the repo is already inside any ALLOWED_PATHS
 * the operator's .env pins. Set SOMA_TEST_KEEP_WORKING_DIR=1 (exactly "1")
 * to opt out deliberately.
 *
 * Scratch dirs are not cleaned up here: `bun test` does not reliably run
 * `process.on("exit")` handlers, and wiping the shared root at startup would
 * delete the directory of another `bun test` still running in this checkout.
 * Leftovers are gitignored; remove `.test-tmp/` by hand when it bothers you.
 */
import { mkdirSync, mkdtempSync, realpathSync } from "fs";
import { join, resolve } from "path";

if (process.env.SOMA_TEST_KEEP_WORKING_DIR !== "1") {
  const scratchRoot = resolve(import.meta.dir, "..", ".test-tmp");
  mkdirSync(scratchRoot, { recursive: true });
  // realpath so ALLOWED_PATHS containment (canonical-vs-canonical) matches.
  process.env.CLAUDE_WORKING_DIR = realpathSync(mkdtempSync(join(scratchRoot, "run-")));
}
