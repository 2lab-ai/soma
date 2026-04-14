/**
 * Voice message handler for Claude Telegram Bot.
 */

import type { Context } from "grammy";
import { unlinkSync } from "fs";
import { sessionManager } from "../core/session/session-manager";
import { TEMP_DIR, TRANSCRIPTION_AVAILABLE } from "../config";
import {
  type ChatType,
  isAuthorizedForChat,
  rateLimiter,
  shouldRespondInChat,
} from "../security";
import { auditLog, auditLogRateLimit } from "../utils/audit";
import { scrubBotToken } from "../utils/scrub-token";
import { addTimestamp } from "../utils/interrupt";
import { startTypingIndicator } from "../utils/typing";
import { transcribeVoice } from "../utils/voice";
import { StreamingState, createStatusCallback } from "./streaming";
import { botUsername } from "./text";
import { handleAbortError } from "../utils/error-classification";
import { Reactions } from "../constants/reactions";
import { downloadTelegramFile } from "../utils/telegram-file";

/**
 * Handle incoming voice messages.
 */
export async function handleVoice(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;
  const voice = ctx.message?.voice;

  if (!userId || !voice || !chatId) {
    return;
  }

  // 1. Authorization check (per-chat)
  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
    }
    return;
  }

  // 1.1. Check if bot should respond (for groups - voice replies are always directed)
  const isReplyToBot = Boolean(
    ctx.message?.reply_to_message?.from?.is_bot &&
    ctx.message?.reply_to_message?.from?.username === botUsername
  );
  if (!shouldRespondInChat(chatId, chatType, undefined, botUsername, isReplyToBot)) {
    return;
  }

  // 1.5. React to user message to show it's received
  try {
    await ctx.react(Reactions.READ);
  } catch (error) {
    console.debug("Failed to add reaction to user message:", error);
  }

  // Get session for this chat/thread
  const session = sessionManager.getSession(chatId, threadId);

  // 2. Check if transcription is available
  if (!TRANSCRIPTION_AVAILABLE) {
    await ctx.reply(
      "Voice transcription is not configured. Set OPENAI_API_KEY in .env"
    );
    return;
  }

  // 3. Rate limit check
  const [allowed, retryAfter] = rateLimiter.check(userId);
  if (!allowed) {
    await auditLogRateLimit(userId, username, retryAfter!);
    await ctx.reply(`⏳ Rate limited. Please wait ${retryAfter!.toFixed(1)} seconds.`);
    return;
  }

  // 4. Mark processing started (allows /stop to work during transcription/classification)
  const stopProcessing = session.startProcessing();

  // 4.5. Update reaction to show processing
  try {
    await ctx.react(Reactions.PROCESSING);
  } catch {
    // Ignore reaction errors
  }

  // 5. Start typing indicator for transcription
  const typing = startTypingIndicator(ctx);
  const state = new StreamingState();

  let voicePath: string | null = null;

  try {
    // 6. Download voice file via secure helper (token never exposed in errors)
    const timestamp = Date.now();
    voicePath = `${TEMP_DIR}/voice_${timestamp}.ogg`;

    const buffer = await downloadTelegramFile(ctx);
    await Bun.write(voicePath, buffer);

    // 7. Transcribe
    const statusMsg = await ctx.reply("🎤 Transcribing...");

    let transcript: string;
    try {
      transcript = await transcribeVoice(voicePath);
    } catch (transcriptionError) {
      const reason = transcriptionError instanceof Error
        ? transcriptionError.message
        : String(transcriptionError);
      console.error("Transcription failed:", transcriptionError);
      await ctx.api.editMessageText(
        chatId,
        statusMsg.message_id,
        `❌ Transcription failed: ${reason.slice(0, 200)}`
      );
      stopProcessing();
      return;
    }

    // 8. Show transcript
    await ctx.api.editMessageText(chatId, statusMsg.message_id, `🎤 "${transcript}"`);

    // 9. Create streaming callback
    const statusCallback = await createStatusCallback(ctx, state, session);

    // 10. Send to Claude (with timestamp)
    const claudeResponse = await session.sendMessageStreaming(
      addTimestamp(transcript),
      statusCallback,
      chatId
    );

    // 11. Audit log
    await auditLog(userId, username, "VOICE", transcript, claudeResponse);

    // 12. Update reaction to show complete
    try {
      await ctx.react(Reactions.COMPLETE);
    } catch {
      // Ignore reaction errors
    }
  } catch (error) {
    console.error("Error processing voice:", scrubBotToken(error, ctx.api.token));

    if (await handleAbortError(ctx, error, session)) {
      // Abort handled (reaction added by handleAbortError)
    } else {
      // Add error reaction for non-abort errors
      try {
        await ctx.react(Reactions.ERROR_MODEL);
      } catch {
        // Ignore reaction errors
      }
      await ctx.reply(`❌ Error: ${scrubBotToken(error, ctx.api.token).slice(0, 200)}`);
    }
  } finally {
    state.cleanup();
    stopProcessing();
    typing.stop();

    // Clean up voice file
    if (voicePath) {
      try {
        unlinkSync(voicePath);
      } catch (error) {
        console.debug("Failed to delete voice file:", error);
      }
    }
  }
}
