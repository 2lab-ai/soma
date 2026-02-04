import type { Context } from "grammy";
import type { Message } from "grammy/types";
import { InlineKeyboard } from "grammy";
import type { QueryMetadata, StatusCallback } from "../types";
import type { ClaudeSession } from "../session";
import { convertMarkdownToHtml, escapeHtml } from "../formatting";
import { UserChoiceExtractor } from "../utils/user-choice-extractor";
import { TelegramChoiceBuilder } from "../utils/telegram-choice-builder";
import type { UserChoice, UserChoices } from "../types/user-choice";
import {
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_SAFE_LIMIT,
  STREAMING_THROTTLE_MS,
  BUTTON_LABEL_MAX_LENGTH,
  DELETE_THINKING_MESSAGES,
  DELETE_TOOL_MESSAGES,
  PROGRESS_SPINNER_ENABLED,
  SHOW_ELAPSED_TIME,
  PROGRESS_REACTION_ENABLED,
} from "../config";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) + "..." : text;
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

function buildEnhancedFooter(
  startTime: Date,
  metadata?: QueryMetadata
): string {
  const endTime = new Date();
  const timeOpts = { hour: "2-digit", minute: "2-digit", second: "2-digit" } as const;
  const startStr = startTime.toLocaleTimeString("ko-KR", timeOpts);
  const endStr = endTime.toLocaleTimeString("ko-KR", timeOpts);

  const lines: string[] = [];

  // Time line
  lines.push(`⏰ ${startStr} → ${endStr} (${formatElapsed(startTime)})`);

  // Usage line (if available)
  if (metadata?.usageBefore && metadata?.usageAfter) {
    const b = metadata.usageBefore;
    const a = metadata.usageAfter;
    const d5 = Math.round(a.fiveHour - b.fiveHour);
    const d7 = Math.round(a.sevenDay - b.sevenDay);
    const sign5 = d5 >= 0 ? "+" : "";
    const sign7 = d7 >= 0 ? "+" : "";
    const ctxPart = (() => {
      if (metadata?.contextUsagePercent === undefined) return "";
      const ctxBefore = metadata.contextUsagePercentBefore ?? metadata.contextUsagePercent;
      const dCtx = Math.round((metadata.contextUsagePercent - ctxBefore) * 10) / 10;
      const signCtx = dCtx >= 0 ? "+" : "";
      return `Ctx: ${metadata.contextUsagePercent.toFixed(1)}% (${signCtx}${dCtx.toFixed(1)}%) | `;
    })();
    lines.push(`📊 ${ctxPart}5h: ${Math.round(a.fiveHour)}% (${sign5}${d5}%) | 7d: ${Math.round(a.sevenDay)}% (${sign7}${d7}%)`);
  } else if (metadata?.usageAfter) {
    const a = metadata.usageAfter;
    const ctxPart = metadata?.contextUsagePercent !== undefined
      ? `Ctx: ${metadata.contextUsagePercent.toFixed(1)}% | `
      : "";
    lines.push(`📊 ${ctxPart}5h: ${Math.round(a.fiveHour)}% | 7d: ${Math.round(a.sevenDay)}%`);
  }

  // Tools line (if available)
  if (metadata?.toolDurations) {
    const tools = Object.entries(metadata.toolDurations);
    if (tools.length > 0) {
      const parts = tools
        .sort((x, y) => y[1].totalMs - x[1].totalMs) // Sort by total time desc
        .slice(0, 5) // Top 5 tools
        .map(([name, { count, totalMs }]) => `${name}×${count}: ${formatDurationMs(totalMs)}`);
      lines.push(`🔧 ${parts.join(" | ")}`);
    }
  }

  return `\n\n<i>${lines.join("\n")}</i>`;
}

async function deleteMessage(ctx: Context, msg: Message): Promise<void> {
  try {
    await ctx.api.deleteMessage(msg.chat.id, msg.message_id);
  } catch {
    // Message already deleted or too old
  }
}

export async function cleanupToolMessages(
  ctx: Context,
  toolMessages: Message[]
): Promise<void> {
  for (const toolMsg of toolMessages) {
    try {
      await ctx.api.deleteMessage(toolMsg.chat.id, toolMsg.message_id);
    } catch (error) {
      console.warn(`Failed to delete tool message ${toolMsg.message_id}:`, error);
    }
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

  cleanup(): void {
    if (this.progressTimer) {
      clearInterval(this.progressTimer);
      this.progressTimer = null;
    }
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

  if (!state.startTime) {
    state.startTime = new Date();

    if (PROGRESS_REACTION_ENABLED) {
      await setReaction(ctx, "🔥");
    }

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

  return async (statusType: string, content: string, segmentId?: number, metadata?: QueryMetadata) => {
    try {
      if (statusType === "thinking") {
        const escaped = escapeHtml(truncate(content, 500));
        const thinkingMsg = await ctx.reply(`🧠 <i>${escaped}</i>`, {
          parse_mode: "HTML",
        });
        state.thinkingMessages.push(thinkingMsg);
        if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
        return;
      }

      if (statusType === "tool") {
        const toolMsg = await ctx.reply(content, { parse_mode: "HTML" });
        state.toolMessages.push(toolMsg);
        if (PROGRESS_SPINNER_ENABLED) await recreateProgressMessage();
        return;
      }

      if (statusType === "text" && segmentId !== undefined) {
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

      if (statusType === "done") {
        state.cleanup();
        if (state.progressMessage) await deleteMessage(ctx, state.progressMessage);

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

        if (PROGRESS_REACTION_ENABLED) {
          await setReaction(ctx, "🎉");
        }

        if (state.hasUserChoice && session) {
          const chatId = ctx.chat?.id;
          const threadId = (ctx.message as { message_thread_id?: number } | undefined)
            ?.message_thread_id;

          if (chatId) {
            const sessionKey = `${chatId}${threadId ? `:${threadId}` : ""}`;

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
