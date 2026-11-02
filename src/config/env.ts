import { existsSync } from "fs";
import { homedir } from "os";
import type { SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { TrustMode } from "./safety-prompt";

// $HOME first: Bun caches os.homedir() at process start, so test/preload.ts can
// only redirect the home directory through the env var. Same value in production.
const HOME = process.env.HOME || homedir();

export const HOME_DIR = HOME;

/**
 * Attachment staging root. Always /tmp/soma in production; under `bun test`
 * (NODE_ENV=test) test/preload.ts points SOMA_TEMP_DIR at a scratch dir so
 * handler tests never write into a live bot's staging dir.
 */
export function resolveTempDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.NODE_ENV === "test" ? env.SOMA_TEMP_DIR?.trim() : undefined;
  return override || "/tmp/soma";
}

export function parseEnvList(key: string): string[] {
  return (process.env[key] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function parseEnvNumbers(key: string): number[] {
  return parseEnvList(key)
    .map((value) => parseInt(value, 10))
    .filter((value) => !isNaN(value));
}

export function parseEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (!value) return defaultValue;
  return value.toLowerCase() === "true";
}

export function parseEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const TRUST_MODES: readonly TrustMode[] = ["standard", "owner"];

/**
 * SOMA_TRUST_MODE: which model-facing safety prompt the bot sends
 * (config/safety-prompt.ts). Unset = `standard`; `owner` is for a
 * single-owner bot. An unknown value warns and falls back to `standard`.
 */
export function parseTrustMode(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn
): TrustMode {
  const raw = env.SOMA_TRUST_MODE?.trim().toLowerCase();
  if (!raw) return "standard";
  if ((TRUST_MODES as readonly string[]).includes(raw)) return raw as TrustMode;
  warn(
    `[CONFIG] SOMA_TRUST_MODE="${env.SOMA_TRUST_MODE}" is not one of ${TRUST_MODES.join("|")}. Using standard.`
  );
  return "standard";
}

const SETTING_SOURCE_NAMES: readonly SettingSource[] = ["user", "project", "local"];

/**
 * SOMA_SETTING_SOURCES: comma list of the filesystem settings the spawned CLI
 * loads (`user` = ~/.claude, `project` = <cwd>/.claude and CLAUDE.md,
 * `local` = <cwd>/.claude/settings.local.json). Unset = `[]`, the SDK
 * isolation the bot always ran with. Invalid entries warn and are dropped.
 */
export function parseSettingSources(
  env: NodeJS.ProcessEnv = process.env,
  warn: (message: string) => void = console.warn
): SettingSource[] {
  const sources: SettingSource[] = [];
  const invalid: string[] = [];
  for (const entry of (env.SOMA_SETTING_SOURCES || "").split(",")) {
    const name = entry.trim().toLowerCase();
    if (!name) continue;
    if (!(SETTING_SOURCE_NAMES as readonly string[]).includes(name)) {
      invalid.push(entry.trim());
    } else if (!sources.includes(name as SettingSource)) {
      sources.push(name as SettingSource);
    }
  }
  if (invalid.length) {
    warn(
      `[CONFIG] SOMA_SETTING_SOURCES: ignoring ${invalid.join(", ")} (valid: ${SETTING_SOURCE_NAMES.join(", ")}).`
    );
  }
  return sources;
}

const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

export function resolveWorkingDir(): string {
  const configured = process.env.CLAUDE_WORKING_DIR?.trim();
  if (!configured) return HOME;
  if (existsSync(configured)) return configured;

  const fallback = process.cwd();
  console.warn(
    `[CONFIG] CLAUDE_WORKING_DIR does not exist: ${configured}. Falling back to ${fallback}`
  );
  return fallback;
}

export function findClaudeCli(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  return Bun.which("claude") || "/usr/local/bin/claude";
}
