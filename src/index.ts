/**
 * Claude Telegram Bot - TypeScript/Bun Edition
 *
 * Control Claude Code from your phone via Telegram.
 */

import { Bot, GrammyError } from "grammy";
import { run, sequentialize } from "@grammyjs/runner";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import Bottleneck from "bottleneck";
import { TELEGRAM_TOKEN, WORKING_DIR, ALLOWED_USERS, RESTART_FILE } from "./config";
import {
  unlinkSync,
  readFileSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from "fs";
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
  setBotUsername,
  handleVoice,
  handlePhoto,
  handleDocument,
  handleCallback,
} from "./handlers";
import { initScheduler, startScheduler, stopScheduler } from "./scheduler";
import { sessionManager } from "./session-manager";
import { escapeHtml } from "./formatting";
import { PendingFormStore } from "./stores/pending-form-store";

// Create bot instance
const bot = new Bot(TELEGRAM_TOKEN);

// Configure rate limiting for outbound Telegram API calls
const throttler = apiThrottler({
  global: {
    maxConcurrent: 25,
    minTime: 40, // ~25/sec (under 30/sec limit)
  },
  group: {
    maxConcurrent: 1,
    minTime: 3100, // ~19/min (under 20/min limit)
    reservoir: 19,
    reservoirRefreshAmount: 19,
    reservoirRefreshInterval: 60000,
    highWater: 50,
    strategy: Bottleneck.strategy.OVERFLOW,
  },
  out: {
    maxConcurrent: 1,
    minTime: 1050, // ~57/min per chat (under 1/sec limit)
    highWater: 100,
    strategy: Bottleneck.strategy.OVERFLOW,
  },
});

bot.api.config.use(throttler);

// 429 fallback handler (if throttler fails to prevent rate limit)
bot.api.config.use(async (prev, method, payload, signal) => {
  try {
    return await prev(method, payload, signal);
  } catch (err) {
    if (err instanceof GrammyError && err.error_code === 429) {
      const retry = err.parameters?.retry_after ?? 30;
      console.warn(`⚠️ 429 rate limit despite throttle. Waiting ${retry}s`);
      await new Promise((r) => setTimeout(r, retry * 1000));
      return prev(method, payload, signal);
    }
    throw err;
  }
});

// Sequentialize non-command messages per user (prevents race conditions)
// Commands bypass sequentialization so they work immediately
bot.use(
  sequentialize((ctx) => {
    // Commands are not sequentialized - they work immediately
    if (ctx.message?.text?.startsWith("/")) {
      return undefined;
    }
    // Messages with ! prefix bypass queue (interrupt)
    if (ctx.message?.text?.startsWith("!")) {
      return undefined;
    }
    // Callback queries (button clicks) are not sequentialized
    if (ctx.callbackQuery) {
      return undefined;
    }
    // STEERING FIX: If session is processing, bypass queue to enable steering
    // The text handler will buffer this as steering instead of treating as new query
    const chatId = ctx.chat?.id;
    if (chatId && ctx.message?.text) {
      const session = sessionManager.getSession(chatId);
      if (session.isProcessing) {
        console.log(`[SEQUENTIALIZE] Bypassing queue for steering (chat ${chatId})`);
        return undefined;
      }
    }
    // Other messages are sequentialized per chat
    return ctx.chat?.id.toString();
  })
);

// ============== Command Handlers ==============

// Register Telegram command autocomplete menu
await bot.api.setMyCommands([
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
]);

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

// ============== Message Handlers ==============

// Text messages
bot.on("message:text", handleText);

// Voice messages
bot.on("message:voice", handleVoice);

// Photo messages
bot.on("message:photo", handlePhoto);

// Document messages
bot.on("message:document", handleDocument);

// ============== Callback Queries ==============

bot.on("callback_query:data", handleCallback);

// ============== Error Handler ==============

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ============== Startup ==============

console.log("=".repeat(50));
console.log("Claude Telegram Bot - TypeScript Edition");
console.log("=".repeat(50));
console.log(`Working directory: ${WORKING_DIR}`);
console.log(`Allowed users: ${ALLOWED_USERS.length}`);
console.log("Starting bot...");

// Get bot info first
const botInfo = await bot.api.getMe();
console.log(`Bot started: @${botInfo.username}`);

// Set bot username for @mention detection in handlers
if (botInfo.username) {
  setBotUsername(botInfo.username);
}

// Load any persisted sessions (lazy - loaded on demand by sessionManager)

// Initialize and start cron scheduler
initScheduler(bot.api);
startScheduler();

// Initialize pending form store and load persisted forms
export const formStore = new PendingFormStore();
(async () => {
  const loaded = await formStore.loadForms();
  console.log(`[Startup] Loaded ${loaded} pending forms`);
})();

// Check for pending restart message to update
if (existsSync(RESTART_FILE)) {
  try {
    const data = JSON.parse(readFileSync(RESTART_FILE, "utf-8"));
    const age = Date.now() - data.timestamp;

    // Only update if restart was recent (within 30 seconds)
    if (age < 30000 && data.chat_id && data.message_id) {
      await bot.api.editMessageText(data.chat_id, data.message_id, "✅ Bot restarted");
    }
    unlinkSync(RESTART_FILE);
  } catch (e) {
    console.warn("Failed to update restart message:", e);
    try {
      unlinkSync(RESTART_FILE);
    } catch {}
  }
}

// Start with concurrent runner (commands work immediately)
const startTs = new Date().toISOString();
console.log(`\n[${startTs}] ========== BOT STARTUP ==========`);
console.log(`[STARTUP] PID: ${process.pid}`);
console.log(`[STARTUP] Working dir: ${WORKING_DIR}`);
console.log(`[STARTUP] Allowed users: ${ALLOWED_USERS.length}`);
const runner = run(bot);
console.log(`[STARTUP] Bot runner started`);

// Send startup notification to Claude and user
if (ALLOWED_USERS.length > 0) {
  const userId = ALLOWED_USERS[0]!;
  setTimeout(async () => {
    try {
      const statusCallback = async () => {};
      const session = sessionManager.getSession(userId);

      // PRIORITY 1: Check for .last-save-id (auto-load mechanism)
      const saveIdFile = `${WORKING_DIR}/.last-save-id`;
      if (existsSync(saveIdFile)) {
        try {
          const saveId = readFileSync(saveIdFile, "utf-8").trim();

          // S1 FIX: Validate save ID format (security - path traversal/command injection)
          if (!/^\d{8}_\d{6}$/.test(saveId)) {
            console.error(`Invalid save ID format in .last-save-id: ${saveId}`);
            unlinkSync(saveIdFile); // Remove malicious file
            throw new Error(`Invalid save ID format: ${saveId}`);
          }

          console.log(`📥 Found .last-save-id: ${saveId} - Triggering auto-load`);

          // Send /load command to Claude
          await bot.api.sendMessage(
            userId,
            `🔄 **Auto-restoring context**\n\nSave ID: \`${saveId}\`\n\nExecuting /load...`,
            { parse_mode: "Markdown" }
          );

          const loadResponse = await session.sendMessageStreaming(
            `Skill tool with skill='oh-my-claude:load' and args='${saveId}'`,
            "startup",
            userId,
            statusCallback
          );

          // C4 FIX: Validate /load succeeded
          if (!loadResponse.includes("Loaded Context:")) {
            console.error(`/load failed - response doesn't contain "Loaded Context:"`);
            console.error(`Response: ${loadResponse.slice(0, 500)}`);
            throw new Error(`/load validation failed for save ID: ${saveId}`);
          }

          console.log(`✅ Context restored from ${saveId}`);

          // ORACLE: Add telemetry
          console.log("[TELEMETRY] auto_load_success", {
            saveId,
            timestamp: new Date().toISOString(),
          });

          session.markRestored(); // Activate cooldown

          // C3 FIX: Delete .last-save-id AFTER verification
          unlinkSync(saveIdFile);

          await bot.api.sendMessage(
            userId,
            `✅ **Context Restored**\n\nResumed from save: \`${saveId}\``,
            { parse_mode: "Markdown" }
          );

          return; // Skip normal startup message
        } catch (err) {
          console.error("CRITICAL: Auto-load failed:", err);
          console.error("Stack:", err instanceof Error ? err.stack : "N/A");

          // S2 FIX: Sanitize error message (don't expose internal paths)
          const errorStr = String(err);
          const sanitized = errorStr.replace(
            process.env.HOME || "/home/zhugehyuk",
            "~"
          );

          await bot.api.sendMessage(
            userId,
            `🚨 **Auto-load Failed**\n\n` +
              `Error: ${sanitized.slice(0, 300)}\n\n` +
              `⚠️ Starting fresh session. Check logs for recovery.`,
            { parse_mode: "Markdown" }
          );
          // Fall through to normal startup
        }
      }

      // PRIORITY 2: Check for saved restart context (manual save-and-restart.sh)
      console.log(`[STARTUP] Checking for restart context in ${WORKING_DIR}/docs/tasks/save`);
      let contextMessage = "";
      const saveDir = `${WORKING_DIR}/docs/tasks/save`;
      if (existsSync(saveDir)) {
        try {
          const files = readdirSync(saveDir)
            .filter((f) => f.startsWith("restart-context-") && f.endsWith(".md"))
            .map((f) => ({
              name: f,
              path: `${saveDir}/${f}`,
              mtime: statSync(`${saveDir}/${f}`).mtimeMs,
            }))
            .sort((a, b) => b.mtime - a.mtime);

          console.log(`[STARTUP] Found ${files.length} restart-context file(s)`);
          if (files.length > 0) {
            const latestFile = files[0]!;
            console.log(`[STARTUP] Using latest: ${latestFile.name} (mtime: ${new Date(latestFile.mtime).toISOString()})`);
            const content = readFileSync(latestFile.path, "utf-8");
            contextMessage = `\n\n📋 **Saved Context Found:**\n${latestFile.name}\n\n${content}`;
          }
        } catch (err) {
          console.warn("[STARTUP] Failed to read restart context:", err);
        }
      } else {
        console.log(`[STARTUP] Save directory does not exist`);
      }

      // Determine startup type for clear messaging
      let startupType = "";
      if (contextMessage.includes("restart-context")) {
        startupType = "🔄 **SIGTERM Restart** (graceful shutdown via make up)";
        console.log(`[STARTUP] Type: SIGTERM Restart (found restart-context)`);
      } else if (session.isActive) {
        startupType = "♻️ **Session Resumed** (no saved context found)";
        console.log(`[STARTUP] Type: Session Resumed (active session exists)`);
      } else {
        startupType = "🆕 **Fresh Start** (new session)";
        console.log(`[STARTUP] Type: Fresh Start (new session)`);
      }

      const startupPrompt = session.isActive
        ? `${startupType}\n\nBot restarted. Session ID: ${session.sessionId?.slice(0, 8)}...\n\n현재 시간과 함께 간단히 상태를 알려주세요.${contextMessage}`
        : `${startupType}\n\nBot restarted. New session starting.\n\n현재 시간과 함께 간단한 인사말을 써주세요.${contextMessage}`;

      const response = await session.sendMessageStreaming(
        startupPrompt,
        "startup",
        userId,
        statusCallback
      );

      if (response && response !== "[Waiting for user selection]") {
        await bot.api.sendMessage(userId, escapeHtml(response), { parse_mode: "HTML" });
      }
    } catch (e) {
      console.error("Startup notification failed:", e);
      await bot.api.sendMessage(userId, "✅ Bot restarted").catch(() => {});
    }
  }, 2000);
}

// Graceful shutdown
const stopRunner = () => {
  console.log("[SHUTDOWN] Step 1: Stopping scheduler...");
  stopScheduler();
  console.log("[SHUTDOWN] Step 2: Saving all sessions...");
  const stats = sessionManager.getGlobalStats();
  console.log(`[SHUTDOWN] Sessions to save: ${stats.totalSessions}, Total queries: ${stats.totalQueries}`);
  sessionManager.saveAllSessions();
  console.log("[SHUTDOWN] Step 3: Sessions saved");
  if (runner.isRunning()) {
    console.log("[SHUTDOWN] Step 4: Stopping bot runner...");
    runner.stop();
    console.log("[SHUTDOWN] Step 5: Bot runner stopped");
  } else {
    console.log("[SHUTDOWN] Step 4: Bot runner already stopped");
  }
};

/**
 * Save graceful shutdown context to be restored on next startup.
 */
function saveShutdownContext(): void {
  console.log("[SIGTERM-SAVE] Starting context save...");
  try {
    const saveDir = `${WORKING_DIR}/docs/tasks/save`;
    console.log(`[SIGTERM-SAVE] Save directory: ${saveDir}`);
    mkdirSync(saveDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const saveFile = `${saveDir}/restart-context-${timestamp}.md`;

    const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
    const stats = sessionManager.getGlobalStats();
    const sessionInfo = `Active sessions: ${stats.totalSessions}`;
    console.log(`[SIGTERM-SAVE] Stats: sessions=${stats.totalSessions}, totalQueries=${stats.totalQueries}`);

    const content = [
      `# Restart Context - ${now}`,
      ``,
      `## Message from Previous Session`,
      ``,
      `Gracefully shut down via make up. Sessions will be restored automatically.`,
      ``,
      sessionInfo,
      ``,
      `---`,
      `*Auto-generated by SIGTERM handler*`,
    ].join("\n");

    writeFileSync(saveFile, content, "utf-8");
    console.log(`[SIGTERM-SAVE] ✅ Context saved to ${saveFile}`);
    console.log(`[SIGTERM-SAVE] File content length: ${content.length} bytes`);
  } catch (error) {
    console.error(`[SIGTERM-SAVE] ❌ Failed to save: ${error}`);
  }
}

process.on("SIGINT", () => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] ========== SIGINT RECEIVED ==========`);
  console.log("[SIGINT] Ctrl+C detected, stopping without save...");
  stopRunner();
  console.log("[SIGINT] Exiting with code 0");
  process.exit(0);
});

process.on("SIGTERM", () => {
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] ========== SIGTERM RECEIVED ==========`);
  console.log("[SIGTERM] Graceful shutdown initiated (likely from make up or systemctl)");
  console.log("[SIGTERM] PID:", process.pid);
  saveShutdownContext();
  stopRunner();
  console.log("[SIGTERM] All cleanup complete, exiting with code 0");
  process.exit(0);
});
