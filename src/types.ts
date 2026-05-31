/**
 * Shared TypeScript types for the Claude Telegram Bot.
 */

import type { Context } from "grammy";
import type { Message } from "grammy/types";

export * from "./types/audit";
export * from "./types/provider";
export * from "./types/runtime";
export * from "./types/session";

// Rate limit bucket for token bucket algorithm
export interface RateLimitBucket {
  tokens: number;
  lastUpdate: number;
}

// MCP server configuration types
export type McpServerConfig = McpStdioConfig | McpHttpConfig;

export interface McpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

// Pending media group for buffering albums
export interface PendingMediaGroup {
  items: string[];
  ctx: Context;
  caption?: string;
  statusMsg?: Message;
  timeout: Timer;
}

// Cron schedule configuration
export interface CronSchedule {
  name: string;
  cron: string;
  prompt: string;
  enabled?: boolean;
  notify?: boolean; // Send result to Telegram (default: false)
  // Start a brand-new session on every run instead of resuming the persistent
  // cron:scheduler:<name> session (default: false). Use for stateless daily
  // generators (e.g. ES) so the resumed transcript never accumulates past the
  // model's context window → avoids "Prompt is too long".
  freshSession?: boolean;
}

export interface CronConfig {
  schedules: CronSchedule[];
}
