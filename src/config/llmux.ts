/**
 * llmux routing for spawned Claude CLI subprocesses.
 *
 * The Agent SDK spawns the Claude CLI as a child process. When `Options.env`
 * is omitted the child inherits `process.env` verbatim, which under launchd
 * means an expired OAuth context ("Not logged in") kills every query. Routing
 * through the local llmux proxy (https://github.com/2lab-ai/llmux) moves
 * upstream auth out of this process entirely.
 *
 * Why `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` must be DELETED and
 * not merely overwritten: the Claude CLI prefers an OAuth token over
 * `ANTHROPIC_API_KEY` when both are present, so an inherited (possibly stale)
 * token would silently bypass the proxy. Deleting the keys is what makes the
 * `ANTHROPIC_BASE_URL` + `ANTHROPIC_API_KEY` pair authoritative.
 *
 * Contract (mirrors soma-work `src/auth/query-env-builder.ts`):
 *   - NEVER mutates `process.env`.
 *   - Returns a NEW object on every call, so concurrent queries hold no alias
 *     to a shared map.
 *   - Env is read at call time (not module load), so a mode flip applies to
 *     the next dispatch.
 */

export type AuthMode = "llmux" | "oauth";

const DEFAULT_LLMUX_BASE_URL = "http://localhost:3456";
const DEFAULT_LLMUX_API_KEY = "llmux-local-placeholder";

/**
 * Auth backend for spawned CLI subprocesses. `llmux` is the default; only an
 * explicit `AUTH_MODE=oauth` opts back into inherited OAuth credentials.
 */
export function getAuthMode(): AuthMode {
  return process.env.AUTH_MODE?.trim().toLowerCase() === "oauth" ? "oauth" : "llmux";
}

export function isLlmuxMode(): boolean {
  return getAuthMode() === "llmux";
}

export function getLlmuxSettings(): { baseUrl: string; apiKey: string } {
  return {
    baseUrl: process.env.LLMUX_BASE_URL?.trim() || DEFAULT_LLMUX_BASE_URL,
    // The key is a throwaway: llmux owns the real upstream account pool. It
    // only has to be non-empty so the CLI takes the API-key path.
    apiKey: process.env.LLMUX_API_KEY?.trim() || DEFAULT_LLMUX_API_KEY,
  };
}

/**
 * Builds the `Options.env` value for an SDK query.
 *
 * - llmux mode: a fresh copy of `process.env` with the proxy endpoint + key
 *   set and every OAuth-token key removed.
 * - oauth mode: `undefined`, i.e. the SDK keeps inheriting `process.env`
 *   (current behaviour, unchanged).
 */
export function buildProviderEnv(): Record<string, string> | undefined {
  if (!isLlmuxMode()) return undefined;

  // Shallow-copy the owned string entries. `process.env` is a proxy whose
  // enumerable string values are exactly what Node forwards to subprocesses.
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }

  const llmux = getLlmuxSettings();
  env.ANTHROPIC_BASE_URL = llmux.baseUrl;
  env.ANTHROPIC_API_KEY = llmux.apiKey;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return env;
}
