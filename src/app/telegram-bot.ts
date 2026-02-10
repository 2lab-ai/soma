import { Bot, GrammyError, type Context } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import Bottleneck from "bottleneck";
import { TELEGRAM_TOKEN } from "../config";
import {
  handleStart,
  handleNew,
  handleStop,
  handleStatus,
  handleStats,
  handleContext,
  handleHelp,
  handleResume,
  handleRestart,
  handleRetry,
  handleCron,
  handleSessions,
  handleModel,
  handleSkills,
  handleText,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
} from "../handlers";
import { sessionManager } from "../core/session/session-manager";

const TELEGRAM_COMMANDS = [
  { command: "skills", description: "Quick access to SuperClaude skills" },
  { command: "start", description: "Welcome message and status" },
  { command: "new", description: "Start fresh Claude session" },
  { command: "stop", description: "Stop current query" },
  { command: "status", description: "Show session details" },
  { command: "stats", description: "Token usage & cost statistics" },
  { command: "context", description: "Context window usage (200K limit)" },
  { command: "model", description: "Configure model & reasoning settings" },
  { command: "help", description: "Show all available commands" },
  { command: "resume", description: "Resume last saved session" },
  { command: "restart", description: "Restart the bot process" },
  { command: "retry", description: "Retry last message" },
  { command: "cron", description: "Scheduled jobs status/reload" },
  { command: "sessions", description: "List all active sessions (admin)" },
] as const;

export function createTelegramBot(): Bot<Context> {
  return new Bot<Context>(TELEGRAM_TOKEN);
}

export function registerBotMiddleware(bot: Bot<Context>): void {
  const throttler = apiThrottler({
    global: {
      maxConcurrent: 25,
      minTime: 40,
    },
    group: {
      maxConcurrent: 1,
      minTime: 3100,
      reservoir: 19,
      reservoirRefreshAmount: 19,
      reservoirRefreshInterval: 60000,
      highWater: 50,
      strategy: Bottleneck.strategy.OVERFLOW,
    },
    out: {
      maxConcurrent: 1,
      minTime: 1050,
      highWater: 100,
      strategy: Bottleneck.strategy.OVERFLOW,
    },
  });

  bot.api.config.use(throttler);

  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (err) {
      if (err instanceof GrammyError && err.error_code === 429) {
        const retry = err.parameters?.retry_after ?? 30;
        console.warn(`⚠️ 429 rate limit despite throttle. Waiting ${retry}s`);
        await new Promise((resolve) => setTimeout(resolve, retry * 1000));
        return prev(method, payload, signal);
      }
      throw err;
    }
  });

  bot.use(
    sequentialize((ctx) => {
      if (ctx.message?.text?.startsWith("/")) {
        return undefined;
      }
      if (ctx.message?.text?.startsWith("!")) {
        return undefined;
      }
      if (ctx.callbackQuery) {
        return undefined;
      }

      const chatId = ctx.chat?.id;
      if (chatId && ctx.message?.text) {
        const session = sessionManager.getSession(chatId);
        if (session.isProcessing) {
          console.log(`[SEQUENTIALIZE] Bypassing queue for steering (chat ${chatId})`);
          return undefined;
        }
      }

      return ctx.chat?.id.toString();
    })
  );
}

export async function registerBotCommands(bot: Bot<Context>): Promise<void> {
  await bot.api.setMyCommands([...TELEGRAM_COMMANDS]);

  bot.command("start", handleStart);
  bot.command("new", handleNew);
  bot.command("stop", handleStop);
  bot.command("status", handleStatus);
  bot.command("stats", handleStats);
  bot.command("context", handleContext);
  bot.command("model", handleModel);
  bot.command("skills", handleSkills);
  bot.command("help", handleHelp);
  bot.command("resume", handleResume);
  bot.command("restart", handleRestart);
  bot.command("retry", handleRetry);
  bot.command("cron", handleCron);
  bot.command("sessions", handleSessions);
}

export function registerBotHandlers(bot: Bot<Context>): void {
  bot.on("message:text", handleText);
  bot.on("message:voice", handleVoice);
  bot.on("message:photo", handlePhoto);
  bot.on("message:document", handleDocument);
  bot.on("callback_query:data", handleCallback);

  bot.catch((err) => {
    console.error("Bot error:", err);
  });
}
