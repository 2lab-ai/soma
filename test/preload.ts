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
 * Everything the suite can write or read on the operator's machine is pointed
 * at a fresh scratch directory instead: the working dir, HOME, the attachment
 * staging dir and the audit log. It lives inside the repo (`.test-tmp/`,
 * gitignored) rather than under the OS tmpdir because the permission tests
 * assert that `/var/folders` never appears in the advertised roots. Set
 * SOMA_TEST_KEEP_WORKING_DIR=1 (exactly "1") to keep CLAUDE_WORKING_DIR only.
 *
 * Scratch dirs are not cleaned up here: `bun test` does not reliably run
 * `process.on("exit")` handlers, and wiping the shared root at startup would
 * delete the directory of another `bun test` still running in this checkout.
 * Leftovers are gitignored; remove `.test-tmp/` by hand when it bothers you.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";
import { parseDotenv } from "./parse-dotenv";

const repoRoot = resolve(import.meta.dir, "..");
const scratchRoot = join(repoRoot, ".test-tmp");
mkdirSync(scratchRoot, { recursive: true });
const scratch = (prefix: string) =>
  realpathSync(mkdtempSync(join(scratchRoot, prefix)));

// 1. Undo Bun's .env auto-load. It runs before this preload and would hand the
//    suite the operator's bot token, ALLOWED_PATHS, AUDIT_LOG_PATH, provider
//    keys… A variable is dropped only when its value is exactly what the file
//    says, so anything the caller exported explicitly (e.g. `make test`'s
//    TELEGRAM_* placeholders) survives.
for (const name of [".env", `.env.${process.env.NODE_ENV ?? "test"}`, ".env.local"]) {
  const file = join(repoRoot, name);
  if (!existsSync(file)) continue;
  for (const [key, value] of Object.entries(parseDotenv(readFileSync(file, "utf8")))) {
    if (process.env[key] === value) delete process.env[key];
  }
}
// Pin test mode after the undo: Bun keeps an inherited NODE_ENV (e.g.
// production), and the undo above deletes a NODE_ENV=test that came from .env.
// config/env.ts resolveTempDir honours SOMA_TEMP_DIR only in test mode.
process.env.NODE_ENV = "test";
// usage.ts resolves llmux.json under $XDG_CONFIG_HOME before $HOME/.config.
delete process.env.XDG_CONFIG_HOME;
// Provider usage snapshots: tests that drive the real sendMessageStreaming call
// captureUsageSnapshot. An inherited AUTH_MODE=oauth reads the macOS Keychain
// and calls Anthropic; the default llmux mode calls the local llmux daemon.
// Default mode + an unroutable llmux URL makes both a fast, local null.
delete process.env.AUTH_MODE;
process.env.LLMUX_BASE_URL = "http://127.0.0.1:9";
// config/index.ts exits without these; tests mock the Telegram API anyway.
process.env.TELEGRAM_BOT_TOKEN ||= "test-telegram-token";
process.env.TELEGRAM_ALLOWED_USERS ||= "1";

// 2. Tests own their path allowlist: the defaults (WORKING_DIR + HOME subdirs)
//    are what they assert against.
delete process.env.ALLOWED_PATHS;

if (process.env.SOMA_TEST_KEEP_WORKING_DIR !== "1") {
  // realpath so ALLOWED_PATHS containment (canonical-vs-canonical) matches.
  process.env.CLAUDE_WORKING_DIR = scratch("run-");
}

// 3. HOME, unconditionally: services/skills-registry.ts works on
//    ~/.claude/skills-registry.json and its test writes "{ invalid json ]" on
//    purpose — against the real home that corrupt file was left in the
//    operator's ~/.claude. Bun caches os.homedir() at startup, so modules that
//    resolve the home directory read $HOME first (config/env.ts HOME_DIR).
process.env.HOME = scratch("home-");

// 4. Attachment staging dir and audit log: handler tests that reach the real
//    download path would otherwise write into the live bot's /tmp/soma (a
//    fixed name like image.png overwrites a staged attachment) and append
//    fixture conversations to its audit log.
process.env.SOMA_TEMP_DIR = scratch("attachments-");
process.env.AUDIT_LOG_PATH = join(scratch("audit-"), "audit.log");
