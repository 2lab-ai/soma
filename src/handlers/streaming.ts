import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { streamApi } from "@grammyjs/stream";
import { sessionManager } from "../core/session/session-manager";
import type { QueryMetadata, StatusCallback } from "../types/runtime";
import type { ClaudeSession } from "../core/session/session";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import { UserChoiceExtractor } from "../utils/user-choice-extractor";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";
import type { UserChoice, UserChoices } from "../types/user-choice";
import { DeltaQueue } from "./stream-bridge";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  DELETE_THINKING_MESSAGES,
  DELETE_TOOL_MESSAGES,
  PROGRESS_SPINNER_ENABLED,
  SHOW_ELAPSED_TIME,
  SHOW_CURRENT_PROVIDER_USAGE,
  SHOW_ANTHROPIC_USAGE,
  SHOW_CODEX_USAGE,
  SHOW_GEMINI_USAGE,
  USE_NATIVE_STREAMING,
} from "../config";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const sliced = text.slice(0, limit);
  return closeOpenMarkdown(sliced) + "...";
}

export function closeOpenMarkdown(text: string): string {
  let result = text;
  const codeBlockCount = (result.match(/```/g) || []).length;
  if (codeBlockCount % 2 !== 0) result += "\n```";
  const backtickCount = (result.match(/(?<!`)`(?!`)/g) || []).length;
  if (backtickCount % 2 !== 0) result += "`";
  const boldDblCount = (result.match(/\*\*/g) || []).length;
  if (boldDblCount % 2 !== 0) result += "**";
  const underscoreDblCount = (result.match(/__/g) || []).length;
  if (underscoreDblCount % 2 !== 0) result += "__";
  return result;
}

function formatElapsed(startTime: Date): string {
  const elapsed = Math.floor((Date.now() - startTime.getTime()) / 1000);
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function buildProgressBar(elapsedMs: number): string {
  // Animated progress bar that cycles every ~60 seconds
  const cycleMs = 60_000;
  const progress = (elapsedMs % cycleMs) / cycleMs;
  const filled = Math.floor(progress * 20);
  const empty = 20 - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  const elapsedSec = Math.floor(elapsedMs / 1000);
  return `⏱️ ${elapsedSec}s [${bar}]`;
}

export function renderBar(percent: number, width = 14): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

function isAiMcpTool(content: string): boolean {
  return /🔮.*MCP.*(?:codex|gemini|claude)/i.test(content);
}

function buildEnhancedFooter(startTime: Date, metadata?: QueryMetadata): string {
  const endTime = new Date();
  const timeOpts = { hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;
  const startStr = startTime.toLocaleTimeString("ko-KR", timeOpts);
  const endStr = endTime.toLocaleTimeString("ko-KR", timeOpts);

  const lines: string[] = [];

  // Time line
  lines.push(`⏰ ${startStr} → ${endStr} (${formatElapsed(startTime)})`);

  // Usage line (if available)
  const shouldShowUsage = (() => {
    const provider = metadata?.currentProvider;
    if (SHOW_CURRENT_PROVIDER_USAGE && provider) return true;
    if (SHOW_ANTHROPIC_USAGE && provider === "anthropic") return true;
    if (SHOW_CODEX_USAGE && provider === "codex") return true;
    if (SHOW_GEMINI_USAGE && provider === "gemini") return true;
    return false;
  })();

  if (shouldShowUsage && metadata?.usageBefore && metadata?.usageAfter) {
    const b = metadata.usageBefore;
    const a = metadata.usageAfter;
    const d5 = Math.round(a.fiveHour - b.fiveHour);
    const d7 = Math.round(a.sevenDay - b.sevenDay);
    const sign5 = d5 >= 0 ? "+" : "";
    const sign7 = d7 >= 0 ? "+" : "";
    if (metadata?.contextUsagePercent !== undefined) {
      const ctxBefore =
        metadata.contextUsagePercentBefore ?? metadata.contextUsagePercent;
      const dCtx = Math.round((metadata.contextUsagePercent - ctxBefore) * 10) / 10;
      const signCtx = dCtx >= 0 ? "+" : "";
      lines.push(
        `Ctx ${renderBar(metadata.contextUsagePercent)} ${metadata.contextUsagePercent.toFixed(1)}% ${signCtx}${dCtx.toFixed(1)}`
      );
    }
    lines.push(
      `5h  ${renderBar(a.fiveHour)} ${String(Math.round(a.fiveHour)).padStart(3)}% ${sign5}${d5}  7d ${renderBar(a.sevenDay, 8)} ${String(Math.round(a.sevenDay)).padStart(3)}% ${sign7}${d7}`
    );
  } else if (shouldShowUsage && metadata?.usageAfter) {
    const a = metadata.usageAfter;
    if (metadata?.contextUsagePercent !== undefined) {
      lines.push(
        `Ctx ${renderBar(metadata.contextUsagePercent)} ${metadata.contextUsagePercent.toFixed(1)}%`
      );
    }
    lines.push(
      `5h  ${renderBar(a.fiveHour)} ${String(Math.round(a.fiveHour)).padStart(3)}%  7d ${renderBar(a.sevenDay, 8)} ${String(Math.round(a.sevenDay)).padStart(3)}%`
    );
  }

  // Tools line (if available)
  if (metadata?.toolDurations) {
    const tools = Object.entries(metadata.toolDurations);
    if (tools.length > 0) {
      const parts = tools
        .sort((x, y) => y[1].totalMs - x[1].totalMs)
        .slice(0, 5)
        .map(
          ([name, { count, totalMs }]) =>
            `${name}×${count}: ${formatDurationMs(totalMs)}`
        );
      lines.push(`🔧 ${parts.join(" | ")}`);
    }
  }

  return `\n\n<pre>${lines.join("\n")}</pre>`;
}

async function deleteMessage(ctx: Context, msg: Message): Promise<void> {
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch {
    // Message already deleted or too old
  }
}

/**
 * Clean up tool status messages (fire-and-forget, doesn't block response).
 * Deletion happens in background to improve responsiveness.
 */
export function cleanupToolMessages(ctx: Context, toolMessages: Message[]): void {
  // Fire and forget - don't block on message deletion
  for (const toolMsg of toolMessages) {
    ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id).catch((error) => {
      console.debug(`Failed to delete tool message ${toolMsg.message_id}:`, error);
    });
  }
}

type TelegramEmoji =
  | "👍"
  | "👎"
  | "❤"
  | "🔥"
  | "🥰"
  | "👏"
  | "😁"
  | "🤔"
  | "🤯"
  | "😱"
  | "🤬"
  | "😢"
  | "🎉"
  | "🤩"
  | "🤮"
  | "💩"
  | "🙏"
  | "👌"
  | "🕊"
  | "🤡"
  | "🥱"
  | "🥴"
  | "😍"
  | "🐳"
  | "❤‍🔥"
  | "🌚"
  | "🌭";

async function setReaction(ctx: Context, emoji: TelegramEmoji): Promise<void> {
  const msgId = ctx.message?.message_id;
  const chatId = ctx.chat?.id;
  if (msgId === undefined || chatId === undefined) return;

  try {
    await ctx.api.setMessageReaction(chatId, msgId, [{ type: "emoji", emoji }]);
  } catch {
    // Reaction failed (rate limited or not allowed)
  }
}

export class StreamingState {
  textMessages = new Map<number, Message>();
  thinkingMessages: Message[] = [];
  toolMessages: Message[] = [];
  lastEditTimes = new Map<number, number>();
  lastContent = new Map<number, string>();
  progressMessage: Message | null = null;
  progressTimer: Timer | null = null;
  startTime: Date | null = null;
  rateLimitNotified = false;
  extractedChoice: UserChoice | null = null;
  extractedChoices: UserChoices | null = null;
  hasUserChoice = false;
  hasSteeringPending = false;
  steeringPendingCount = 0;

  // MCP progress tracking
  mcpToolMessage: Message | null = null;
  mcpToolStartTime: number | null = null;
  mcpToolBaseContent: string | null = null;
  mcpProgressTimer: Timer | null = null;

  // Native streaming (sendMessageDraft) state
  isNativeStreaming = false;
  streamQueues = new Map<number, DeltaQueue>();
  streamPromises = new Map<number, Promise<Message[]>>();
  streamAbortControllers = new Map<number, AbortController>();
  // For multi-message segments: track first message separately (header goes here)
  streamFirstMessages = new Map<number, Message>();

  cleanup(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
    if (this.mcpProgressTimer) {
      clearInterval(this.mcpProgressTimer);
      this.mcpProgressTimer = null;
    }
    // Abort any active native streams and suppress unhandled rejections
    for (const queue of this.streamQueues.values()) {
      queue.abort();
    }
    for (const controller of this.streamAbortControllers.values()) {
      try { controller.abort(); } catch { /* already aborted */ }
    }
    for (const promise of this.streamPromises.values()) {
      promise.catch(() => { /* suppress rejection from aborted stream */ });
    }
    this.streamQueues.clear();
    this.streamPromises.clear();
    this.streamAbortControllers.clear();
    this.streamFirstMessages.clear();
  }

  stopMcpProgress(): void {
    if (this.mcpProgressTimer) {
      clearInterval(this.mcpProgressTimer);
      this.mcpProgressTimer = null;
    }
    this.mcpToolMessage = null;
    this.mcpToolStartTime = null;
    this.mcpToolBaseContent = null;
  }
}

export async function handleRateLimitError(
  ctx: Context,
  error: unknown,
  state: StreamingState
): Promise<boolean> {
  const errorStr = String(error);
  if (!errorStr.includes("429") && !errorStr.includes("Too Many Requests")) {
    return false;
  }

  if (state.rateLimitNotified) return true;
  state.rateLimitNotified = true;

  const match = errorStr.match(/retry after (\d+)/i);
  const retryAfter = match?.[1] ? parseInt(match[1], 10) : 60;

  await setReaction(ctx, "🥱");
  console.warn(`[RATE LIMIT] Telegram 429 - retry after ${retryAfter}s`);
  return true;
}

export async function createStatusCallback(
  ctx: Context,
  state: StreamingState,
  session?: ClaudeSession
): Promise<StatusCallback> {
  let frameIndex = 0;

  const recreateProgressMessage = async (): Promise<void> => {
    if (state.progressMessage) await deleteMessage(ctx, state.progressMessage);

    if (state.startTime) {
      const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
      const text = `${spinner} Working... (${formatElapsed(state.startTime)})`;
      try {
        state.progressMessage = await ctx.reply(text);
      } catch {
        // Progress message creation failed
      }
    }
  };

  // Determine native streaming eligibility (private chats only)
  const isPrivateChat = ctx.chat?.type === "private";
  const chatId = ctx.chat?.id;
  if (USE_NATIVE_STREAMING && isPrivateChat && chatId) {
    state.isNativeStreaming = true;
  }

  if (!state.startTime) {
    state.startTime = new Date();

    // Emoji reactions now handled exclusively by query-flow.ts via Reactions constants
    // (Previously set 🔥 here, but that conflicted with reactions.ts PROCESSING emoji)

    if (PROGRESS_SPINNER_ENABLED) {
      await recreateProgressMessage();

      state.progressTimer = setInterval(async () => {
        if (!state.startTime || !state.progressMessage) return;

        frameIndex++;
        const spinner = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
        const text = `${spinner} Working... (${formatElapsed(state.startTime)})`;

        try {
          await ctx.api.editMessageText(
            state.progressMessage.chat.id,
            state.progressMessage.message_id,
            text
          );
        } catch {
          // Progress update failed
        }
      }, 1000);
    }
  }

  return async (
    statusType: string,
    content: string,
    segmentId?: number,
    metadata?: QueryMetadata
  ) => {
    try {
      if (statusType === "thinking") {
        state.stopMcpProgress(); // Stop any MCP progress timer
        const escaped = escapeHtml(truncate(content, 500));
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.thinkingMessages.push(thinkingMsg);
        if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
        return;
      }

      if (statusType === "tool") {
        // Stop any previous MCP progress timer
        state.stopMcpProgress();

        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);

        // For AI MCP tools, start progress timer
        if (isAiMcpTool(content)) {
          state.mcpToolMessage = toolMsg;
          state.mcpToolStartTime = Date.now();
          state.mcpToolBaseContent = content;

          // Update every 10 seconds
          state.mcpProgressTimer = setInterval(async () => {
            if (
              !state.mcpToolMessage ||
              !state.mcpToolStartTime ||
              !state.mcpToolBaseContent
            )
              return;

            const elapsed = Date.now() - state.mcpToolStartTime;
            const progressLine = `\n\n🔮 <b>MCP 실행 중</b>\n${buildProgressBar(elapsed)}`;

            try {
              await ctx.api.editMessageText(
                state.mcpToolMessage.chat.id,
                state.mcpToolMessage.message_id,
                state.mcpToolBaseContent + progressLine,
                { parse_mode: "HTML" }
              );
            } catch {
              // Progress update failed (message deleted or too old)
              state.stopMcpProgress();
            }
          }, 10_000);
        }

        if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
        return;
      }

      if (statusType === "text" && segmentId !== undefined) {
        state.stopMcpProgress(); // Stop any MCP progress timer

        // Native streaming path (private chats via sendMessageDraft)
        if (state.isNativeStreaming && chatId) {
          if (!state.streamQueues.has(segmentId)) {
            const queue = new DeltaQueue();
            const abortController = new AbortController();
            state.streamQueues.set(segmentId, queue);
            state.streamAbortControllers.set(segmentId, abortController);

            const updateId = (ctx as { update?: { update_id?: number } }).update?.update_id;
            // Use multiplication (not << 8) to avoid signed 32-bit overflow on large update_ids
            const draftIdOffset = ((updateId ?? Math.floor(Date.now() / 1000)) * 256) + segmentId;
            const methods = streamApi(ctx.api.raw);
            const promise = methods.streamMessage(
              chatId,
              draftIdOffset,
              queue,
              undefined,
              undefined,
              // @grammyjs/stream re-exports AbortSignal from abort-controller polyfill;
              // native AbortSignal is runtime-compatible but types diverge — cast required
              abortController.signal as never
            );
            state.streamPromises.set(segmentId, promise);
          }
          state.streamQueues.get(segmentId)!.pushCumulative(content);
          return;
        }

        // Existing editMessageText path (groups, or native streaming disabled)
        const now = Date.now();
        const lastEdit = state.lastEditTimes.get(segmentId) || 0;
        const display = truncate(content, TELEGRAM_SAFE_LIMIT);
        const formatted = convertMarkdownToHtml(display);

        if (!state.textMessages.has(segmentId)) {
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch {
            const msg = await ctx.reply(display);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, display);
          }
          state.lastEditTimes.set(segmentId, now);
          if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
          return;
        }

        if (now - lastEdit <= STREAMING_THROTTLE_MS) return;
        if (formatted === state.lastContent.get(segmentId)) return;

        const msg = state.textMessages.get(segmentId)!;
        try {
          await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
            parse_mode: "HTML",
          });
          state.lastContent.set(segmentId, formatted);
        } catch {
          try {
            await ctx.api.editMessageText(msg.chat.id, msg.message_id, display);
            state.lastContent.set(segmentId, display);
          } catch {
            // Edit failed
          }
        }
        state.lastEditTimes.set(segmentId, now);
        return;
      }

      if (statusType === "segment_end" && segmentId !== undefined) {
        if (!content) return;

        const extracted = UserChoiceExtractor.extractUserChoice(content);
        if (extracted.choice || extracted.choices) {
          state.extractedChoice = extracted.choice;
          state.extractedChoices = extracted.choices;
          state.hasUserChoice = true;
        }

        const displayContent = extracted.textWithoutChoice || content;

        // Native streaming: finalize the stream and re-edit with HTML
        if (state.isNativeStreaming && state.streamQueues.has(segmentId)) {
          const queue = state.streamQueues.get(segmentId)!;
          queue.pushCumulative(content); // Flush remaining — use full content to match streamed offsets
          queue.end();

          try {
            const messages = await state.streamPromises.get(segmentId)!;

            if (messages.length > 0) {
              // Store last message for footer/reaction in done handler
              const lastMsg = messages[messages.length - 1]!;
              state.textMessages.set(segmentId, lastMsg);
              // Store first message for header placement
              if (messages.length > 1) {
                state.streamFirstMessages.set(segmentId, messages[0]!);
              }

              // Re-edit each message with HTML formatting (streamed content was raw text)
              const formatted = convertMarkdownToHtml(displayContent);

              if (messages.length === 1 && formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
                // Single message, fits in limit: re-edit with full HTML
                try {
                  await ctx.api.editMessageText(
                    lastMsg.chat.id,
                    lastMsg.message_id,
                    formatted,
                    { parse_mode: "HTML" }
                  );
                  state.lastContent.set(segmentId, formatted);
                } catch {
                  // HTML edit failed, keep raw text
                  state.lastContent.set(segmentId, lastMsg.text ?? displayContent);
                }
              } else if (messages.length > 1) {
                // Multi-message: re-edit each chunk with HTML
                // Use `content` (not displayContent) for offset calc since streams were fed content
                let offset = 0;
                for (const msg of messages) {
                  const rawLen = msg.text?.length ?? 0;
                  let chunkText = content.slice(offset, offset + rawLen);
                  offset += rawLen;
                  if (!chunkText) continue;
                  // Strip any choice JSON that may appear in the last chunk
                  const chunkExtracted = UserChoiceExtractor.extractUserChoice(chunkText);
                  if (chunkExtracted.textWithoutChoice) {
                    chunkText = chunkExtracted.textWithoutChoice;
                  }
                  const chunkHtml = convertMarkdownToHtml(chunkText);
                  try {
                    await ctx.api.editMessageText(
                      msg.chat.id,
                      msg.message_id,
                      chunkHtml,
                      { parse_mode: "HTML" }
                    );
                  } catch { /* HTML edit failed for chunk, keep raw */ }
                }
                state.lastContent.set(segmentId, lastMsg.text ?? displayContent);
              } else {
                // Single message but content > limit: keep as-is
                state.lastContent.set(segmentId, lastMsg.text ?? displayContent);
              }
            }
          } catch (error) {
            console.error("[NATIVE-STREAM] Stream finalization failed, falling back:", error);
            // Fallback: existing messages may have been partially sent by the plugin.
            // Send a fresh complete message as best-effort recovery.
            const formatted = convertMarkdownToHtml(displayContent);
            try {
              const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
              state.textMessages.set(segmentId, msg);
              state.lastContent.set(segmentId, formatted);
            } catch {
              const msg = await ctx.reply(displayContent);
              state.textMessages.set(segmentId, msg);
              state.lastContent.set(segmentId, displayContent);
            }
          }

          // Clean up stream resources for this segment
          state.streamQueues.delete(segmentId);
          state.streamPromises.delete(segmentId);
          state.streamAbortControllers.delete(segmentId);
          return;
        }

        // Existing editMessageText path (groups, or native streaming disabled)
        const formatted = convertMarkdownToHtml(displayContent);

        if (!state.textMessages.has(segmentId)) {
          try {
            const msg = await ctx.reply(formatted, { parse_mode: "HTML" });
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, formatted);
          } catch {
            const msg = await ctx.reply(displayContent);
            state.textMessages.set(segmentId, msg);
            state.lastContent.set(segmentId, displayContent);
          }
          if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
          return;
        }

        if (formatted === state.lastContent.get(segmentId)) return;

        const msg = state.textMessages.get(segmentId)!;

        if (formatted.length <= TELEGRAM_MESSAGE_LIMIT) {
          try {
            await ctx.api.editMessageText(msg.chat.id, msg.message_id, formatted, {
              parse_mode: "HTML",
            });
            state.lastContent.set(segmentId, formatted);
          } catch {
            try {
              await ctx.api.editMessageText(msg.chat.id, msg.message_id, content);
              state.lastContent.set(segmentId, content);
            } catch {
              // Edit failed
            }
          }
          return;
        }

        await deleteMessage(ctx, msg);
        state.textMessages.delete(segmentId);
        state.lastContent.delete(segmentId);

        let lastChunkMsg: Message | null = null;
        let lastChunkContent: string | null = null;
        for (let i = 0; i < formatted.length; i += TELEGRAM_SAFE_LIMIT) {
          const chunk = formatted.slice(i, i + TELEGRAM_SAFE_LIMIT);
          try {
            lastChunkMsg = await ctx.reply(chunk, { parse_mode: "HTML" });
            lastChunkContent = chunk;
          } catch {
            lastChunkMsg = await ctx.reply(chunk);
            lastChunkContent = chunk;
          }
        }
        if (lastChunkMsg && lastChunkContent !== null) {
          state.textMessages.set(segmentId, lastChunkMsg);
          state.lastContent.set(segmentId, lastChunkContent);
        }
        if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
        return;
      }

      if (statusType === "system") {
        state.stopMcpProgress();
        const sysMsg = await ctx.reply(`⚡ ${content}`, { parse_mode: "HTML" });
        state.toolMessages.push(sysMsg);
        if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
        return;
      }

      if (statusType === "steering_pending") {
        // User sent messages during execution but Claude responded with text-only
        // Their messages weren't delivered via PreToolUse hook
        // FIX (soma-t5d): Immediately restore steering to prevent race condition
        const steeringCount =
          (metadata as { steeringCount?: number })?.steeringCount || 0;

        // CRITICAL: Restore steering immediately to avoid async race condition
        // where clearInjectedSteeringTracking() is called before restoration
        if (session) {
          const injected = session.restoreInjectedSteering();
          console.log(
            `[STEERING PENDING] ${steeringCount} message(s) restored immediately (injected: ${injected})`
          );
        } else {
          console.log(
            `[STEERING PENDING] ${steeringCount} message(s) in buffer - session unavailable`
          );
        }

        // Store flag but don't show notification - auto-continue handles immediately
        // Old behavior showed "다음 응답에서 처리됩니다" which was misleading
        state.hasSteeringPending = true;
        state.steeringPendingCount = steeringCount;
        return;
      }

      if (statusType === "done") {
        // Capture stream-derived state before cleanup clears it
        const savedFirstMessages = new Map(state.streamFirstMessages);
        state.cleanup();
        if (state.progressMessage) await deleteMessage(ctx, state.progressMessage);

        if (metadata?.modelDisplayName && state.textMessages.size > 0) {
          const firstSegmentId = Math.min(...state.textMessages.keys());
          // For multi-message native streams, header goes on the FIRST message (not last)
          const firstMsg = savedFirstMessages.get(firstSegmentId)
            ?? state.textMessages.get(firstSegmentId);
          const firstContent = firstMsg
            ? (firstMsg.text ?? state.lastContent.get(firstSegmentId))
            : state.lastContent.get(firstSegmentId);

          if (firstMsg && firstContent) {
            const modelHeader = `<pre>${escapeHtml(metadata.modelDisplayName)}</pre>\n`;
            const newContent = modelHeader + firstContent;
            if (newContent.length <= TELEGRAM_MESSAGE_LIMIT) {
              try {
                await ctx.api.editMessageText(
                  firstMsg.chat.id,
                  firstMsg.message_id,
                  newContent,
                  { parse_mode: "HTML" }
                );
                state.lastContent.set(firstSegmentId, newContent);
              } catch {
                // Model header prepend failed
              }
            }
          }
        }

        if (SHOW_ELAPSED_TIME && state.startTime && state.textMessages.size > 0) {
          const footer = buildEnhancedFooter(state.startTime, metadata);

          const lastSegmentId = Math.max(...state.textMessages.keys());
          const lastMsg = state.textMessages.get(lastSegmentId);
          const lastContent = state.lastContent.get(lastSegmentId);

          if (lastMsg && lastContent) {
            try {
              await ctx.api.editMessageText(
                lastMsg.chat.id,
                lastMsg.message_id,
                lastContent + footer,
                { parse_mode: "HTML" }
              );
            } catch {
              // Footer append failed
            }
          }
        }

        if (DELETE_THINKING_MESSAGES) {
          for (const msg of state.thinkingMessages) await deleteMessage(ctx, msg);
        }

        if (DELETE_TOOL_MESSAGES) {
          for (const msg of state.toolMessages) await deleteMessage(ctx, msg);
        }

        // Completion emoji (👍) now handled by query-flow.ts via Reactions.COMPLETE
        // (Previously set 🎉 here, but that raced with reactions.ts COMPLETE emoji)

        if (state.hasUserChoice && session) {
          const chatId = ctx.chat?.id;
          const threadId = (ctx.message as { message_thread_id?: number } | undefined)
            ?.message_thread_id;

          if (chatId) {
            const sessionKey = sessionManager.deriveKey(chatId, threadId);

            try {
              if (state.extractedChoice) {
                const keyboard = TelegramChoiceBuilder.buildSingleChoiceKeyboard(
                  state.extractedChoice,
                  sessionKey
                );
                const msg = await ctx.reply(state.extractedChoice.question, {
                  reply_markup: keyboard,
                });
                session.choiceState = {
                  type: "single",
                  messageIds: [msg.message_id],
                  extractedChoice: state.extractedChoice,
                };
                session.setActivityState("waiting");
              } else if (state.extractedChoices) {
                const keyboards = TelegramChoiceBuilder.buildMultiChoiceKeyboards(
                  state.extractedChoices,
                  sessionKey
                );

                if (
                  state.extractedChoices.title ||
                  state.extractedChoices.description
                ) {
                  const header = [
                    state.extractedChoices.title &&
                      `**${state.extractedChoices.title}**`,
                    state.extractedChoices.description,
                  ]
                    .filter(Boolean)
                    .join("\n");
                  await ctx.reply(convertMarkdownToHtml(header), {
                    parse_mode: "HTML",
                  });
                }

                const questionMsgs = [];
                for (let i = 0; i < state.extractedChoices.questions.length; i++) {
                  const msg = await ctx.reply(
                    state.extractedChoices.questions[i]!.question,
                    { reply_markup: keyboards[i]! }
                  );
                  questionMsgs.push(msg);
                }

                session.choiceState = {
                  type: "multi",
                  messageIds: questionMsgs.map((m) => m.message_id),
                  extractedChoices: state.extractedChoices,
                  selections: {},
                };
                session.setActivityState("waiting");
              }
            } catch (error) {
              console.error("Failed to display choice keyboard:", error);

              // Fallback: Text-based numbered list
              try {
                if (state.extractedChoice) {
                  const options = state.extractedChoice.choices
                    .map(
                      (opt, idx) =>
                        `${idx + 1}️⃣ ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`
                    )
                    .join("\n");

                  const fallbackMsg = await ctx.reply(
                    `${state.extractedChoice.question}\n\n${options}\n\n` +
                      `💬 Reply with the number (1, 2, 3, etc.)`
                  );

                  session.parseTextChoiceState = {
                    type: "single",
                    extractedChoice: state.extractedChoice,
                    messageId: fallbackMsg.message_id,
                    createdAt: Date.now(),
                  };
                  session.setActivityState("waiting");
                } else if (state.extractedChoices) {
                  // Multi-form fallback
                  if (
                    state.extractedChoices.title ||
                    state.extractedChoices.description
                  ) {
                    const header = [
                      state.extractedChoices.title,
                      state.extractedChoices.description,
                    ]
                      .filter(Boolean)
                      .join("\n");
                    await ctx.reply(header);
                  }

                  const questionMsgs = [];
                  for (const question of state.extractedChoices.questions) {
                    const options = question.choices
                      .map(
                        (opt, idx) =>
                          `${idx + 1}️⃣ ${opt.label}${opt.description ? ` - ${opt.description}` : ""}`
                      )
                      .join("\n");

                    const msg = await ctx.reply(
                      `${question.question}\n\n${options}\n\n` +
                        `💬 Reply with the number (1, 2, 3, etc.)`
                    );
                    questionMsgs.push(msg);
                  }

                  session.parseTextChoiceState = {
                    type: "multi",
                    extractedChoices: state.extractedChoices,
                    messageId: questionMsgs[0]!.message_id, // Track first message
                    createdAt: Date.now(),
                  };
                  session.setActivityState("waiting");
                }
              } catch (fallbackError) {
                console.error("Fallback text display also failed:", fallbackError);
                await ctx.reply(
                  "⚠️ Unable to display options. Please describe your choice."
                );
              }
            }
          }
        }

        if (state.textMessages.size > 0) {
          const lastSegmentId = Math.max(...state.textMessages.keys());
          const lastMsg = state.textMessages.get(lastSegmentId);
          if (lastMsg) {
            try {
              await ctx.api.setMessageReaction(lastMsg.chat.id, lastMsg.message_id, [
                { type: "emoji", emoji: "👍" },
              ]);
            } catch {
              // Reaction failed
            }
          }
        }
      }
    } catch (error) {
      const isRateLimited = await handleRateLimitError(ctx, error, state);
      if (!isRateLimited) {
        console.error("Status callback error:", error);
      }
    }
  };
}
