import type { ClaudeUsage, CodexUsage, GeminiUsage } from "../../types/provider";

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) return `${hours}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

export function formatTimeRemaining(resetTime: string | number | null): string {
  if (!resetTime) return "";

  const resetMs =
    typeof resetTime === "number" ? resetTime * 1000 : new Date(resetTime).getTime();
  const diffMs = resetMs - Date.now();

  if (diffMs <= 0) return "now";

  const diffSec = Math.floor(diffMs / 1000);
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function formatClaudeUsage(usage: ClaudeUsage): string[] {
  const lines: string[] = ["<b>Claude Code:</b>"];

  if (usage.five_hour) {
    const reset = formatTimeRemaining(usage.five_hour.resets_at);
    lines.push(
      `   5h: ${Math.round(usage.five_hour.utilization)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }
  if (usage.seven_day) {
    const reset = formatTimeRemaining(usage.seven_day.resets_at);
    lines.push(
      `   7d: ${Math.round(usage.seven_day.utilization)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }
  if (usage.seven_day_sonnet) {
    const reset = formatTimeRemaining(usage.seven_day_sonnet.resets_at);
    lines.push(
      `   7d Sonnet: ${Math.round(usage.seven_day_sonnet.utilization)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }

  return lines;
}

export function formatCodexUsage(usage: CodexUsage): string[] {
  const lines: string[] = [`<b>OpenAI Codex</b> (${usage.planType}):`];

  if (usage.primary) {
    const reset = formatTimeRemaining(usage.primary.resetAt);
    lines.push(
      `   5h: ${Math.round(usage.primary.usedPercent)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }
  if (usage.secondary) {
    const reset = formatTimeRemaining(usage.secondary.resetAt);
    lines.push(
      `   7d: ${Math.round(usage.secondary.usedPercent)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }

  return lines;
}

export function formatGeminiUsage(usage: GeminiUsage): string[] {
  const lines: string[] = [`<b>Gemini</b> (${usage.model}):`];

  if (usage.usedPercent !== null) {
    const reset = formatTimeRemaining(usage.resetAt);
    lines.push(
      `   Usage: ${Math.round(usage.usedPercent)}%${reset ? ` (resets in ${reset})` : ""}`
    );
  }

  return lines;
}
