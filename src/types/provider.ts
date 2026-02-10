export type Provider = "anthropic" | "codex" | "gemini";

// Claude usage from oauth/usage endpoint
export interface ClaudeUsage {
  five_hour: { utilization: number; resets_at: string | null } | null;
  seven_day: { utilization: number; resets_at: string | null } | null;
  seven_day_sonnet: { utilization: number; resets_at: string | null } | null;
}

// Codex usage from ChatGPT backend
export interface CodexUsage {
  model: string;
  planType: string;
  primary: { usedPercent: number; resetAt: number } | null;
  secondary: { usedPercent: number; resetAt: number } | null;
}

// Gemini usage from Code Assist API
export interface GeminiUsage {
  model: string;
  usedPercent: number | null;
  resetAt: string | null;
}

// Combined usage result
export interface AllUsage {
  claude: ClaudeUsage | null;
  codex: CodexUsage | null;
  gemini: GeminiUsage | null;
  fetchedAt: number;
}
