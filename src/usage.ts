/**
 * Multi-provider usage tracking module.
 * Fetches usage statistics from Claude Code, OpenAI Codex, and Gemini CLI.
 *
 * Based on https://github.com/zhugehyuk-contributions/claude-dashboard
 */

import { readFile } from "fs/promises";
import { execFileSync } from "child_process";
import { createHash } from "crypto";
import os from "os";
import path from "path";
import type { AllUsage, ClaudeUsage, CodexUsage, GeminiUsage } from "./types/provider";
import { getLlmuxSettings } from "./config/llmux";

const API_TIMEOUT_MS = 5000;
const DEFAULT_CACHE_TTL_SECONDS = 60;

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

const claudeCache: Map<string, CacheEntry<ClaudeUsage>> = new Map();
const codexCache: Map<string, CacheEntry<CodexUsage>> = new Map();
const geminiCache: Map<string, CacheEntry<GeminiUsage>> = new Map();

const pendingClaudeRequests: Map<string, Promise<ClaudeUsage | null>> = new Map();
const pendingCodexRequests: Map<string, Promise<CodexUsage | null>> = new Map();
const pendingGeminiRequests: Map<string, Promise<GeminiUsage | null>> = new Map();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").substring(0, 16);
}

// ============================================================================
// Claude Code Usage
// ============================================================================

async function getClaudeCredentials(): Promise<string | null> {
  try {
    if (process.platform === "darwin") {
      try {
        const result = execFileSync(
          "security",
          ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
        ).trim();
        const creds = JSON.parse(result);
        return creds?.claudeAiOauth?.accessToken ?? null;
      } catch {
        // Fallback to file
      }
    }

    const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const content = await readFile(credPath, "utf-8");
    const creds = JSON.parse(content);
    return creds?.claudeAiOauth?.accessToken ?? null;
  } catch {
    return null;
  }
}

export async function fetchClaudeUsage(
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
): Promise<ClaudeUsage | null> {
  const token = await getClaudeCredentials();
  if (!token) return null;

  const tokenHash = hashToken(token);

  const cached = claudeCache.get(tokenHash);
  if (cached && Date.now() - cached.timestamp < ttlSeconds * 1000) {
    return cached.data;
  }

  const pending = pendingClaudeRequests.get(tokenHash);
  if (pending) return pending;

  const request = (async (): Promise<ClaudeUsage | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          "anthropic-beta": "oauth-2025-04-20",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!response.ok) return null;

      const data = (await response.json()) as any;
      const usage: ClaudeUsage = {
        five_hour: data.five_hour ?? null,
        seven_day: data.seven_day ?? null,
        seven_day_sonnet: data.seven_day_sonnet ?? null,
      };

      claudeCache.set(tokenHash, { data: usage, timestamp: Date.now() });
      return usage;
    } catch {
      return null;
    }
  })();

  pendingClaudeRequests.set(tokenHash, request);
  try {
    return await request;
  } finally {
    pendingClaudeRequests.delete(tokenHash);
  }
}

// ============================================================================
// OpenAI Codex Usage
// ============================================================================

interface CodexAuth {
  accessToken: string;
  accountId: string;
}

async function getCodexAuth(): Promise<CodexAuth | null> {
  try {
    const authPath = path.join(os.homedir(), ".codex", "auth.json");
    const raw = await readFile(authPath, "utf-8");
    const json = JSON.parse(raw);

    const accessToken = json?.tokens?.access_token;
    const accountId = json?.tokens?.account_id;

    if (!accessToken || !accountId) return null;
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

async function getCodexModel(): Promise<string | null> {
  try {
    const configPath = path.join(os.homedir(), ".codex", "config.toml");
    const raw = await readFile(configPath, "utf-8");
    const match = raw.match(/^model\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

export async function fetchCodexUsage(
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
): Promise<CodexUsage | null> {
  const auth = await getCodexAuth();
  if (!auth) return null;

  const tokenHash = hashToken(auth.accessToken);

  const cached = codexCache.get(tokenHash);
  if (cached && Date.now() - cached.timestamp < ttlSeconds * 1000) {
    return cached.data;
  }

  const pending = pendingCodexRequests.get(tokenHash);
  if (pending) return pending;

  const request = (async (): Promise<CodexUsage | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${auth.accessToken}`,
          "ChatGPT-Account-Id": auth.accountId,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!response.ok) return null;

      const data = (await response.json()) as any;
      if (!data?.rate_limit || !data?.plan_type) return null;

      const model = await getCodexModel();
      const usage: CodexUsage = {
        model: model ?? "unknown",
        planType: data.plan_type,
        primary: data.rate_limit.primary_window
          ? {
              usedPercent: data.rate_limit.primary_window.used_percent,
              resetAt: data.rate_limit.primary_window.reset_at,
            }
          : null,
        secondary: data.rate_limit.secondary_window
          ? {
              usedPercent: data.rate_limit.secondary_window.used_percent,
              resetAt: data.rate_limit.secondary_window.reset_at,
            }
          : null,
      };

      codexCache.set(tokenHash, { data: usage, timestamp: Date.now() });
      return usage;
    } catch {
      return null;
    }
  })();

  pendingCodexRequests.set(tokenHash, request);
  try {
    return await request;
  } finally {
    pendingCodexRequests.delete(tokenHash);
  }
}

// ============================================================================
// Gemini Usage
// ============================================================================

interface GeminiCredentials {
  accessToken: string;
  refreshToken?: string;
  expiryDate?: number;
}

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const OAUTH_CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
const OAUTH_CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
const CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
const CODE_ASSIST_API_VERSION = "v1internal";

async function getGeminiCredentials(): Promise<GeminiCredentials | null> {
  try {
    if (process.platform === "darwin") {
      try {
        const result = execFileSync(
          "security",
          [
            "find-generic-password",
            "-s",
            "gemini-cli-oauth",
            "-a",
            "main-account",
            "-w",
          ],
          { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 }
        ).trim();
        const stored = JSON.parse(result);
        if (stored?.token?.accessToken) {
          return {
            accessToken: stored.token.accessToken,
            refreshToken: stored.token.refreshToken,
            expiryDate: stored.token.expiresAt,
          };
        }
      } catch {
        // Fallback to file
      }
    }

    const oauthPath = path.join(os.homedir(), ".gemini", "oauth_creds.json");
    const raw = await readFile(oauthPath, "utf-8");
    const json = JSON.parse(raw);
    if (!json?.access_token) return null;

    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiryDate: json.expiry_date,
    };
  } catch {
    return null;
  }
}

async function refreshGeminiToken(
  creds: GeminiCredentials
): Promise<GeminiCredentials | null> {
  if (!creds.refreshToken) return null;

  try {
    const response = await fetch(GOOGLE_TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: OAUTH_CLIENT_ID,
        client_secret: OAUTH_CLIENT_SECRET,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    const data = (await response.json()) as any;
    if (!data.access_token) return null;

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || creds.refreshToken,
      expiryDate: Date.now() + data.expires_in * 1000,
    };
  } catch {
    return null;
  }
}

async function getValidGeminiCredentials(): Promise<GeminiCredentials | null> {
  let creds = await getGeminiCredentials();
  if (!creds) return null;

  if (creds.expiryDate && creds.expiryDate < Date.now() + 5 * 60 * 1000) {
    const refreshed = await refreshGeminiToken(creds);
    if (refreshed) return refreshed;
    return null;
  }

  return creds;
}

async function getGeminiSettings(): Promise<{
  cloudaicompanionProject?: string;
  selectedModel?: string;
} | null> {
  try {
    const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
    const raw = await readFile(settingsPath, "utf-8");
    const json = JSON.parse(raw);
    return {
      cloudaicompanionProject: json?.cloudaicompanionProject,
      selectedModel: json?.selectedModel || json?.model,
    };
  } catch {
    return null;
  }
}

async function getGeminiProjectId(creds: GeminiCredentials): Promise<string | null> {
  const envProject =
    process.env["GOOGLE_CLOUD_PROJECT"] || process.env["GOOGLE_CLOUD_PROJECT_ID"];
  if (envProject) return envProject;

  const settings = await getGeminiSettings();
  if (settings?.cloudaicompanionProject) return settings.cloudaicompanionProject;

  try {
    const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:loadCodeAssist`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify({
        metadata: {
          ideType: "GEMINI_CLI",
          platform: "PLATFORM_UNSPECIFIED",
          pluginType: "GEMINI",
        },
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!response.ok) return null;
    const data = (await response.json()) as any;
    return data?.cloudaicompanionProject ?? null;
  } catch {
    return null;
  }
}

export async function fetchGeminiUsage(
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
): Promise<GeminiUsage | null> {
  const creds = await getValidGeminiCredentials();
  if (!creds) return null;

  const projectId = await getGeminiProjectId(creds);
  if (!projectId) return null;

  const tokenHash = hashToken(creds.accessToken);

  const cached = geminiCache.get(tokenHash);
  if (cached && Date.now() - cached.timestamp < ttlSeconds * 1000) {
    return cached.data;
  }

  const pending = pendingGeminiRequests.get(tokenHash);
  if (pending) return pending;

  const request = (async (): Promise<GeminiUsage | null> => {
    try {
      const url = `${CODE_ASSIST_ENDPOINT}/${CODE_ASSIST_API_VERSION}:retrieveUserQuota`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${creds.accessToken}`,
        },
        body: JSON.stringify({ project: projectId }),
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });

      if (!response.ok) return null;
      const data = (await response.json()) as any;

      const settings = await getGeminiSettings();
      const model = settings?.selectedModel ?? "unknown";

      let activeBucket = data?.buckets?.[0];
      if (settings?.selectedModel && data?.buckets) {
        for (const bucket of data.buckets as any[]) {
          if (bucket.modelId?.includes(settings.selectedModel)) {
            activeBucket = bucket;
            break;
          }
        }
      }

      const usage: GeminiUsage = {
        model,
        usedPercent:
          activeBucket?.remainingFraction !== undefined
            ? Math.round((1 - activeBucket.remainingFraction) * 100)
            : null,
        resetAt: activeBucket?.resetTime ?? null,
      };

      geminiCache.set(tokenHash, { data: usage, timestamp: Date.now() });
      return usage;
    } catch {
      return null;
    }
  })();

  pendingGeminiRequests.set(tokenHash, request);
  try {
    return await request;
  } finally {
    pendingGeminiRequests.delete(tokenHash);
  }
}

// ============================================================================
// llmux Pool Usage
// ============================================================================

/**
 * 5h/7d windows of the claude-group account currently serving llmux traffic,
 * plus pool availability. Shown in the turn footer instead of the host
 * machine's personal OAuth usage when soma runs in llmux mode — the personal
 * account numbers say nothing about what the bot actually consumes.
 */
export interface LlmuxUsage {
  /** 0..100, one decimal. */
  fiveHour: number;
  /** 0..100, integer. */
  sevenDay: number;
  account: string;
  poolOk: number;
  poolTotal: number;
}

interface LlmuxWindow {
  utilization?: number;
}

interface LlmuxAccount {
  name?: string;
  group?: string;
  status?: string;
  order?: number;
  five_hour?: LlmuxWindow | null;
  seven_day?: LlmuxWindow | null;
}

/**
 * Pure parser for `GET /llmux/status`. llmux reports `utilization` on a 0..1
 * scale (unlike the Anthropic OAuth endpoint, which is already 0..100), so
 * the x100 happens HERE and only here. Account choice: the current claude
 * slot when the daemon names one, else the first claude-group account in
 * selection order that has a live 5h window.
 */
export function parseLlmuxStatus(data: unknown): LlmuxUsage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as {
    current_by_group?: Record<string, unknown>;
    accounts?: unknown;
  };
  if (!Array.isArray(record.accounts)) return null;

  const claude = (record.accounts as LlmuxAccount[]).filter(
    (a) => a && a.group === "claude" && typeof a.name === "string"
  );
  if (claude.length === 0) return null;

  const currentName = record.current_by_group?.claude;
  const hasWindow = (a: LlmuxAccount): boolean =>
    typeof a.five_hour?.utilization === "number";

  const current = claude.find((a) => a.name === currentName && hasWindow(a));
  const fallback = claude
    .filter(hasWindow)
    .sort((a, b) => (a.order ?? Infinity) - (b.order ?? Infinity))[0];
  const picked = current ?? fallback;
  if (!picked) return null;

  const five = picked.five_hour?.utilization ?? 0;
  const seven = picked.seven_day?.utilization ?? 0;
  return {
    fiveHour: Math.round(five * 1000) / 10,
    sevenDay: Math.round(seven * 100),
    account: picked.name as string,
    poolOk: claude.filter((a) => a.status === "active" || a.status === "ok").length,
    poolTotal: claude.length,
  };
}

/**
 * Admin credential for llmux control-plane reads (`/llmux/status` rejects
 * data-plane/keyless callers). `LLMUX_ADMIN_KEY` env wins; otherwise read
 * `proxy.api_key` from the daemon's own config (`$XDG_CONFIG_HOME/llmux.json`,
 * default `~/.config/llmux.json`) — same-host, same class of read as the
 * Claude credentials file above. NOT `getLlmuxSettings().apiKey`, which is a
 * data-plane placeholder.
 */
async function getLlmuxAdminKey(): Promise<string | null> {
  const fromEnv = process.env.LLMUX_ADMIN_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const configDir =
      process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
    const raw = await readFile(path.join(configDir, "llmux.json"), "utf-8");
    const json = JSON.parse(raw);
    const key = json?.proxy?.api_key;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

const llmuxCache: Map<string, CacheEntry<LlmuxUsage>> = new Map();
const pendingLlmuxRequests: Map<string, Promise<LlmuxUsage | null>> = new Map();

export async function fetchLlmuxUsage(
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
): Promise<LlmuxUsage | null> {
  const key = await getLlmuxAdminKey();
  if (!key) return null;
  const { baseUrl } = getLlmuxSettings();

  const cacheKey = hashToken(`${baseUrl}\n${key}`);
  const cached = llmuxCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < ttlSeconds * 1000) {
    return cached.data;
  }

  const pending = pendingLlmuxRequests.get(cacheKey);
  if (pending) return pending;

  const request = (async (): Promise<LlmuxUsage | null> => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

      const response = await fetch(`${baseUrl}/llmux/status`, {
        method: "GET",
        headers: {
          Accept: "application/json",
          // llmux's client_auth reads ONLY `x-api-key` — an Authorization
          // Bearer header is ignored and the caller downgrades to keyless
          // loopback (data plane only), which 403s on /llmux/status.
          "x-api-key": key,
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);
      if (!response.ok) return null;

      const usage = parseLlmuxStatus(await response.json());
      if (usage) llmuxCache.set(cacheKey, { data: usage, timestamp: Date.now() });
      return usage;
    } catch {
      return null;
    }
  })();

  pendingLlmuxRequests.set(cacheKey, request);
  try {
    return await request;
  } finally {
    pendingLlmuxRequests.delete(cacheKey);
  }
}

// ============================================================================
// Combined Usage
// ============================================================================

export async function fetchAllUsage(
  ttlSeconds: number = DEFAULT_CACHE_TTL_SECONDS
): Promise<AllUsage> {
  const [claude, codex, gemini] = await Promise.all([
    fetchClaudeUsage(ttlSeconds),
    fetchCodexUsage(ttlSeconds),
    fetchGeminiUsage(ttlSeconds),
  ]);

  return {
    claude,
    codex,
    gemini,
    fetchedAt: Date.now(),
  };
}
