import { existsSync } from "fs";
import { homedir } from "os";

const HOME = homedir();

export const HOME_DIR = HOME;

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
