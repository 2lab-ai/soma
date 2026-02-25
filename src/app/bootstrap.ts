import { run } from "@grammyjs/runner";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import type { Bot, Context } from "grammy";
import { ALLOWED_USERS, RESTART_FILE, SYS_MSG_PREFIX, WORKING_DIR } from "../config";
import { createProviderOrchestrator } from "../providers/create-orchestrator";
import type { ProviderRetryPolicyMap } from "../providers/retry-policy";
import { addSystemReaction, sendSystemMessage } from "../utils/system-message";
import { PendingFormStore } from "../stores/pending-form-store";
import { sessionManager } from "../core/session/session-manager";
import { setBotUsername } from "../handlers";
import {
  createTelegramBot,
  registerBotCommands,
  registerBotHandlers,
  registerBotMiddleware,
} from "./telegram-bot";
import { configureAndStartScheduler, stopSchedulerRunner } from "./scheduler-runner";

interface SessionStatsSnapshot {
  totalSessions: number;
  totalQueries: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  sessions: Array<{
    sessionKey: string;
    queries: number;
    isActive: boolean;
    isRunning: boolean;
  }>;
}

interface SessionPort {
  isActive: boolean;
  sessionStartTime: Date | null;
  currentContextTokens: number;
  contextWindowSize: number;
  totalQueries: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  hasSteeringMessages(): boolean;
  getSteeringCount(): number;
  consumeSteering(): string | null;
  formatToolStats(): string;
  sendMessageStreaming(
    prompt: string,
    statusCallback: (
      statusType: string,
      content: string,
      segmentId?: number,
      metadata?: unknown
    ) => Promise<void>,
    chatId?: number,
    modelContext?: string
  ): Promise<string>;
}

interface SessionManagerPort {
  getGlobalStats(): SessionStatsSnapshot;
  getSession(userId: number): SessionPort;
  getSessionByKey(sessionKey: string): SessionPort;
  saveAllSessions(): void;
  setProviderOrchestrator?(
    orchestrator: ReturnType<typeof createProviderOrchestrator>
  ): void;
}

interface FormStorePort {
  loadForms(): Promise<number>;
}

interface RunnerPort {
  isRunning(): boolean;
  stop(): void;
}

interface FileOps {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: BufferEncoding): string;
  unlinkSync(path: string): void;
  writeFileSync(path: string, content: string, encoding?: BufferEncoding): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}

export interface BootstrappedApplication {
  bot: Bot<Context>;
  runner: RunnerPort;
  formStore: FormStorePort;
  stopRunner: () => void;
  handleSigterm: () => Promise<void>;
}

interface BootstrapDependencies {
  createTelegramBot?: () => Bot<Context>;
  registerBotMiddleware?: (bot: Bot<Context>) => void;
  registerBotCommands?: (bot: Bot<Context>) => Promise<void>;
  registerBotHandlers?: (bot: Bot<Context>) => void;
  configureAndStartScheduler?: (
    botApi: Bot<Context>["api"],
    manager: SessionManagerPort
  ) => void;
  stopSchedulerRunner?: () => void;
  startRunner?: (bot: Bot<Context>) => RunnerPort;
  sessionManager?: SessionManagerPort;
  createFormStore?: () => FormStorePort;
  fs?: FileOps;
  sendSystemMessage?: typeof sendSystemMessage;
  addSystemReaction?: typeof addSystemReaction;
  sleep?: (ms: number) => Promise<void>;
  createProviderOrchestrator?: typeof createProviderOrchestrator;
}

const defaultFileOps: FileOps = {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
};

function parseProviderRetryPoliciesFromEnv(
  raw: string | undefined
): Partial<ProviderRetryPolicyMap> | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      { maxRetries?: unknown; baseBackoffMs?: unknown }
    >;
    const entries = Object.entries(parsed).filter(([, policy]) => {
      return (
        typeof policy.maxRetries === "number" &&
        typeof policy.baseBackoffMs === "number"
      );
    });
    if (entries.length === 0) {
      return undefined;
    }
    return Object.fromEntries(entries) as Partial<ProviderRetryPolicyMap>;
  } catch (error) {
    console.warn(
      "[Provider] Failed to parse PROVIDER_RETRY_POLICIES_JSON, using defaults:",
      error
    );
    return undefined;
  }
}

export async function bootstrapApplication(
  dependencies: BootstrapDependencies = {}
): Promise<BootstrappedApplication> {
  const createBot = dependencies.createTelegramBot ?? createTelegramBot;
  const registerMiddleware =
    dependencies.registerBotMiddleware ?? registerBotMiddleware;
  const registerCommands = dependencies.registerBotCommands ?? registerBotCommands;
  const registerHandlers = dependencies.registerBotHandlers ?? registerBotHandlers;
  const configureScheduler =
    dependencies.configureAndStartScheduler ??
    ((botApi: Bot<Context>["api"], managerPort: SessionManagerPort) =>
      configureAndStartScheduler(
        botApi,
        managerPort as Parameters<typeof configureAndStartScheduler>[1]
      ));
  const stopScheduler = dependencies.stopSchedulerRunner ?? stopSchedulerRunner;
  const startRunner =
    dependencies.startRunner ??
    ((bot: Bot<Context>): RunnerPort => run(bot) as unknown as RunnerPort);
  const manager = dependencies.sessionManager ?? (sessionManager as SessionManagerPort);
  const createFormStore =
    dependencies.createFormStore ?? (() => new PendingFormStore());
  const fsOps = dependencies.fs ?? defaultFileOps;
  const sendSystemMessageFn = dependencies.sendSystemMessage ?? sendSystemMessage;
  const addSystemReactionFn = dependencies.addSystemReaction ?? addSystemReaction;
  const sleep = dependencies.sleep ?? ((ms: number) => Bun.sleep(ms));
  const buildProviderOrchestrator =
    dependencies.createProviderOrchestrator ?? createProviderOrchestrator;

  if (typeof manager.setProviderOrchestrator === "function") {
    const retryPolicies = parseProviderRetryPoliciesFromEnv(
      process.env.PROVIDER_RETRY_POLICIES_JSON
    );
    manager.setProviderOrchestrator(
      buildProviderOrchestrator({
        retryPolicies,
      })
    );
  }

  const bot = createBot();
  registerMiddleware(bot);
  await registerCommands(bot);
  registerHandlers(bot);

  console.log("=".repeat(50));
  console.log("Claude Telegram Bot - TypeScript Edition");
  console.log("=".repeat(50));
  console.log(`Working directory: ${WORKING_DIR}`);
  console.log(`Allowed users: ${ALLOWED_USERS.length}`);
  console.log("Starting bot...");

  const botInfo = await bot.api.getMe();
  console.log(`Bot started: @${botInfo.username}`);
  if (botInfo.username) {
    setBotUsername(botInfo.username);
  }

  configureScheduler(bot.api, manager);

  const formStore = createFormStore();
  const loadedForms = await formStore.loadForms();
  console.log(`[Startup] Loaded ${loadedForms} pending forms`);

  if (fsOps.existsSync(RESTART_FILE)) {
    try {
      const data = JSON.parse(fsOps.readFileSync(RESTART_FILE, "utf-8")) as {
        chat_id?: number;
        message_id?: number;
        timestamp?: number;
      };
      const age = Date.now() - Number(data.timestamp ?? 0);
      if (age < 30000 && data.chat_id && data.message_id) {
        await bot.api.editMessageText(
          data.chat_id,
          data.message_id,
          "✅ Bot restarted"
        );
      }
      fsOps.unlinkSync(RESTART_FILE);
    } catch (error) {
      console.warn("Failed to update restart message:", error);
      try {
        fsOps.unlinkSync(RESTART_FILE);
      } catch {
        // Ignore cleanup errors.
      }
    }
  }

  const startTs = new Date().toISOString();
  console.log(`\n[${startTs}] ========== BOT STARTUP ==========`);
  console.log(`[STARTUP] PID: ${process.pid}`);
  console.log(`[STARTUP] Working dir: ${WORKING_DIR}`);
  console.log(`[STARTUP] Allowed users: ${ALLOWED_USERS.length}`);

  const runner = startRunner(bot);
  console.log("[STARTUP] Bot runner started");

  const stopRunner = () => {
    console.log("[SHUTDOWN] Step 1: Stopping scheduler...");
    stopScheduler();
    console.log("[SHUTDOWN] Step 2: Saving all sessions...");
    const stats = manager.getGlobalStats();
    console.log(
      `[SHUTDOWN] Sessions to save: ${stats.totalSessions}, Total queries: ${stats.totalQueries}`
    );
    manager.saveAllSessions();
    console.log("[SHUTDOWN] Step 3: Sessions saved");
    if (runner.isRunning()) {
      console.log("[SHUTDOWN] Step 4: Stopping bot runner...");
      runner.stop();
      console.log("[SHUTDOWN] Step 5: Bot runner stopped");
    } else {
      console.log("[SHUTDOWN] Step 4: Bot runner already stopped");
    }
  };

  const saveShutdownContext = async (): Promise<void> => {
    console.log("\n[CONTEXT-SAVE] ========== SAVING CONTEXT ==========");
    const userId = ALLOWED_USERS[0];

    try {
      const saveDir = `${WORKING_DIR}/docs/tasks/save`;
      fsOps.mkdirSync(saveDir, { recursive: true });

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
      const saveFile = `${saveDir}/restart-context-${timestamp}.md`;
      const now = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
      const stats = manager.getGlobalStats();

      let contextInfo = "";
      let ctxPct = "0";
      if (userId) {
        const session = manager.getSession(userId);
        ctxPct = (
          (session.currentContextTokens / session.contextWindowSize) *
          100
        ).toFixed(1);
        contextInfo = `Context: ${ctxPct}% (${session.currentContextTokens.toLocaleString()}/${session.contextWindowSize.toLocaleString()} tokens)`;
      }

      const content = [
        `# Restart Context - ${now}`,
        ``,
        `## Message from Previous Session`,
        ``,
        `Gracefully shut down via make up. Sessions will be restored automatically.`,
        ``,
        `Active sessions: ${stats.totalSessions}`,
        contextInfo,
        `Total queries: ${stats.totalQueries}`,
        ``,
        `---`,
        `*Auto-generated by SIGTERM handler*`,
      ].join("\n");

      fsOps.writeFileSync(saveFile, content, "utf-8");
      console.log(`[CONTEXT-SAVE] ✅ File saved: ${saveFile}`);

      if (userId) {
        const shortFile = saveFile.replace(WORKING_DIR, ".");
        await Promise.race([
          sendSystemMessageFn(
            { api: bot.api, chatId: userId },
            `**Context Saved**\n\n` +
              `📁 \`${shortFile}\`\n` +
              `📊 Context: ${ctxPct}%\n` +
              `🔢 Queries: ${stats.totalQueries}`,
            { parse_mode: "Markdown" }
          ),
          new Promise<null>((_, reject) =>
            setTimeout(() => reject(new Error("Timeout")), 3000)
          ),
        ]).catch((error) => {
          console.error(`[CONTEXT-SAVE] Failed to notify user: ${error}`);
          return null;
        });
      }
    } catch (error) {
      console.error(`[CONTEXT-SAVE] ❌ Failed to save: ${error}`);
      if (userId) {
        await sendSystemMessageFn(
          { api: bot.api, chatId: userId },
          `**Context Save Failed**\n\n⚠️ ${String(error).slice(0, 200)}`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }
  };

  const sendShutdownMessage = async (): Promise<void> => {
    if (ALLOWED_USERS.length === 0) {
      return;
    }

    const userId = ALLOWED_USERS[0]!;
    const session = manager.getSession(userId);
    const now = new Date();

    let duration = "N/A";
    let startTimeStr = "N/A";
    const endTimeStr = now.toLocaleTimeString("ko-KR", {
      timeZone: "Asia/Seoul",
      hour12: true,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    if (session.sessionStartTime) {
      startTimeStr = session.sessionStartTime.toLocaleTimeString("ko-KR", {
        timeZone: "Asia/Seoul",
        hour12: true,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const diffMs = now.getTime() - session.sessionStartTime.getTime();
      const hours = Math.floor(diffMs / 3600000);
      const minutes = Math.floor((diffMs % 3600000) / 60000);
      const seconds = Math.floor((diffMs % 60000) / 1000);
      duration =
        hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}:${String(seconds).padStart(2, "0")}`;
    }

    const contextTokens = session.currentContextTokens;
    const contextSize = session.contextWindowSize;
    const contextPct =
      contextTokens > 0 ? ((contextTokens / contextSize) * 100).toFixed(1) : "0";
    const toolStats = session.formatToolStats();

    const lines = [
      `${SYS_MSG_PREFIX} ━━━━━━━━━━━━━━━━━━━━━━`,
      "🔄 서비스를 재시작합니다.",
      `⏰ ${startTimeStr} → ${endTimeStr} (${duration})`,
      `📊 Context: ${contextPct}% (${contextTokens.toLocaleString()}/${contextSize.toLocaleString()} tokens)`,
      `📈 Queries: ${session.totalQueries} | Tokens: ${(session.totalInputTokens + session.totalOutputTokens).toLocaleString()}`,
    ];
    if (toolStats) {
      lines.push(`🔧 ${toolStats}`);
    }
    lines.push("━━━━━━━━━━━━━━━━━━━━━━");

    try {
      const shutdownMsg = await Promise.race([
        bot.api.sendMessage(userId, lines.join("\n"), { parse_mode: "HTML" }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Timeout")), 5000)
        ),
      ]);

      if (shutdownMsg?.message_id) {
        addSystemReactionFn(bot.api, userId, shutdownMsg.message_id).catch(() => {});
      }
    } catch (error) {
      console.error("[SHUTDOWN-MSG] ❌ Failed:", error);
    }
  };

  const savePendingSteering = () => {
    const userId = ALLOWED_USERS[0];
    if (!userId) return;

    const session = manager.getSession(userId);
    if (!session.hasSteeringMessages()) return;

    const count = session.getSteeringCount();
    const content = session.consumeSteering();
    if (!content) return;

    const steeringFile = "/tmp/soma-pending-steering.json";
    fsOps.writeFileSync(
      steeringFile,
      JSON.stringify({ count, content, timestamp: new Date().toISOString() }),
      "utf-8"
    );
    console.log(
      `[SIGTERM] Saved ${count} pending steering message(s) to ${steeringFile}`
    );
  };

  const handleSigterm = async (): Promise<void> => {
    const ts = new Date().toISOString();
    console.log(`\n[${ts}] ========== SIGTERM RECEIVED ==========`);
    console.log(
      "[SIGTERM] Graceful shutdown initiated (likely from make up or systemctl)"
    );
    console.log("[SIGTERM] PID:", process.pid);

    savePendingSteering();
    await sendShutdownMessage();
    await saveShutdownContext();
    stopRunner();
    await sleep(1000);
  };

  return {
    bot,
    runner,
    formStore,
    stopRunner,
    handleSigterm,
  };
}
