import { run } from "@grammyjs/runner";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import type { Bot, Context } from "grammy";
import { ALLOWED_USERS, RESTART_FILE, SYS_MSG_PREFIX, WORKING_DIR } from "../config";

const RESTART_MARKER_FILE = "/tmp/soma-restart-marker.json";
const CRASH_MARKER_FILE = "/tmp/soma-crash-marker.json";
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
  actualContextMax: number | null;
  totalQueries: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  hasSteeringMessages(): boolean;
  getSteeringCount(): number;
  consumeSteering(): string | null;
  formatToolStats(): string;
  nextQueryContext: { userId: number; context: string } | null;
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

export interface VerificationTask {
  command: string;
  bdTaskId: string;
  description: string;
}

export interface BootstrappedApplication {
  bot: Bot<Context>;
  runner: RunnerPort;
  formStore: FormStorePort;
  stopRunner: () => void;
  handleSigterm: () => Promise<void>;
  setVerificationTask: (task: VerificationTask | null) => void;
  /** Best-effort crash notification to user before process dies */
  notifyCrash?: (reason: string, error?: unknown) => void;
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
  execSync?: (command: string) => { status: number; stdout: string; stderr: string };
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
  const execSyncFn = dependencies.execSync ?? ((command: string) => {
    try {
      const result = Bun.spawnSync(["bash", "-c", command], {
        cwd: process.cwd(),
        timeout: 120_000,
      });
      return {
        status: result.exitCode,
        stdout: result.stdout?.toString() || "",
        stderr: result.stderr?.toString() || "",
      };
    } catch (e) {
      return { status: 1, stdout: "", stderr: String(e) };
    }
  });

  // Superpower: pending verification task to include in restart marker
  let pendingVerificationTask: VerificationTask | null = null;

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

  // Track whether a restart/crash marker was processed
  let restartMarkerProcessed = false;

  // Inject restart context so Claude knows not to re-execute previous commands
  if (fsOps.existsSync(RESTART_MARKER_FILE)) {
    restartMarkerProcessed = true;
    try {
      const marker = JSON.parse(fsOps.readFileSync(RESTART_MARKER_FILE, "utf-8"));
      const userId = ALLOWED_USERS[0];
      if (userId) {
        const session = manager.getSession(userId);

        // Superpower: auto-verify if verification task was set before SIGTERM
        if (marker.verificationTask) {
          const vt = marker.verificationTask as VerificationTask;
          console.log(`[SUPERPOWER] Running verification: ${vt.command}`);

          const result = execSyncFn(vt.command);
          const passed = result.status === 0;

          if (passed) {
            // SUCCESS: notify telegram
            console.log(`[SUPERPOWER] ✅ Verification PASSED for ${vt.bdTaskId}`);
            try {
              await bot.api.sendMessage(
                userId,
                `✅ **Verification PASSED** [${vt.bdTaskId}]\n\n` +
                  `\`${vt.description}\`\n` +
                  `Command: \`${vt.command}\`\n` +
                  `배포 후 자동 검증 성공.`,
                { parse_mode: "Markdown" }
              );
            } catch (e) {
              console.error(`[SUPERPOWER] Failed to send PASS notification:`, e);
            }
          } else {
            // FAILURE: notify telegram + inject fix request into session
            console.error(`[SUPERPOWER] ❌ Verification FAILED for ${vt.bdTaskId}`);
            const output = (result.stderr || result.stdout || "").slice(0, 500);
            try {
              await bot.api.sendMessage(
                userId,
                `❌ **Verification FAILED** [${vt.bdTaskId}]\n\n` +
                  `\`${vt.description}\`\n` +
                  `Command: \`${vt.command}\`\n` +
                  `Exit code: ${result.status}\n\n` +
                  `\`\`\`\n${output}\n\`\`\`\n\n` +
                  `자동 수정을 시도합니다.`,
                { parse_mode: "Markdown" }
              );
            } catch (e) {
              console.error(`[SUPERPOWER] Failed to send FAIL notification:`, e);
            }

            // Proactive boot: auto-trigger fix via sendMessageStreaming
            const fixPrompt =
              `[SYSTEM] 배포 후 자동 검증 실패. 자동 수정 필요.\n` +
              `Task: ${vt.bdTaskId} (${vt.description})\n` +
              `Command: ${vt.command}\n` +
              `Exit code: ${result.status}\n` +
              `Output:\n${output}\n\n` +
              `이전 세션의 명령(make up, restart 등)은 이미 완료됨. 절대 재실행하지 마세요.\n` +
              `위 검증 실패를 분석하고 코드를 수정하세요.`;
            session.nextQueryContext = { userId, context: fixPrompt };

            // Proactive: auto-start fix without waiting for user message
            try {
              console.log(`[SUPERPOWER] Proactive boot: auto-triggering fix for ${vt.bdTaskId}`);
              await session.sendMessageStreaming(
                fixPrompt,
                async () => {},
                userId,
                "general",
                userId,
              );
            } catch (e) {
              console.error(`[SUPERPOWER] Proactive fix trigger failed:`, e);
            }
          }
        } else {
          // No verification task — determine restart reason from crash marker
          let restartReason = "make up / systemctl restart";
          let restartType: "deploy" | "sigint" | "crash" = "deploy";
          let restartEmoji = "🔄";
          let crashError: string | null = null;

          if (fsOps.existsSync(CRASH_MARKER_FILE)) {
            try {
              const crashData = JSON.parse(fsOps.readFileSync(CRASH_MARKER_FILE, "utf-8"));
              const reason = crashData.reason as string;
              if (reason === "uncaughtException") {
                restartReason = "uncaughtException (프로세스 크래시)";
                restartType = "crash";
                restartEmoji = "💥";
                crashError = crashData.error || null;
              } else if (reason === "unhandledRejection") {
                restartReason = "unhandledRejection (프로세스 크래시)";
                restartType = "crash";
                restartEmoji = "💥";
                crashError = crashData.error || null;
              } else if (reason === "sigint") {
                restartReason = "Ctrl+C (SIGINT)";
                restartType = "sigint";
                restartEmoji = "⏹️";
              } else if (reason === "sigterm") {
                restartReason = "배포/재시작 (SIGTERM)";
                restartType = "deploy";
                restartEmoji = "▶️";
              }
              fsOps.unlinkSync(CRASH_MARKER_FILE);
            } catch {
              // ignore
            }
          }

          let contextMsg =
            `[SYSTEM] 서비스가 방금 재시작되었습니다.\n` +
            `재시작 원인: ${restartEmoji} ${restartReason}\n` +
            `이전 세션의 명령(make up, restart 등)은 이미 완료되었습니다. 절대 재실행하지 마세요.\n` +
            `이전 종료 시각: ${marker.timestamp || "unknown"}`;

          if (crashError) {
            contextMsg += `\n\n크래시 에러:\n${crashError.slice(0, 1000)}`;
          }

          session.nextQueryContext = { userId, context: contextMsg };

          // Send Telegram notification to user about restart type
          try {
            let telegramMsg = `${restartEmoji} **서비스 재시작**\n\n`;
            telegramMsg += `유형: ${restartReason}\n`;
            telegramMsg += `시각: ${marker.timestamp || "unknown"}`;

            if (restartType === "crash" && crashError) {
              telegramMsg += `\n\n\`\`\`\n${crashError.slice(0, 500)}\n\`\`\``;
            }

            await bot.api.sendMessage(userId, telegramMsg, { parse_mode: "Markdown" });
          } catch (notifyErr) {
            console.error("[STARTUP] Failed to send restart notification:", notifyErr);
          }
        }
        console.log("[STARTUP] Restart marker processed");
      }
      fsOps.unlinkSync(RESTART_MARKER_FILE);
    } catch (e) {
      console.warn("[STARTUP] Failed to process restart marker:", e);
      try { fsOps.unlinkSync(RESTART_MARKER_FILE); } catch (cleanupErr) {
        console.error("[STARTUP] Failed to delete restart marker:", cleanupErr);
      }
    }
  }

  // Handle crash marker WITHOUT restart marker — OS killed process (OOM, SIGKILL, etc.)
  // No SIGTERM was caught, so no restart marker exists, but crash marker might.
  if (!restartMarkerProcessed && fsOps.existsSync(CRASH_MARKER_FILE)) {
    restartMarkerProcessed = true;
    try {
      const crashData = JSON.parse(fsOps.readFileSync(CRASH_MARKER_FILE, "utf-8"));
      const reason = crashData.reason as string;
      const userId = ALLOWED_USERS[0];

      if (userId) {
        const session = manager.getSession(userId);
        let reasonLabel = `프로세스 크래시 (${reason})`;
        if (reason === "uncaughtException") reasonLabel = "💥 uncaughtException";
        else if (reason === "unhandledRejection") reasonLabel = "💥 unhandledRejection";

        const errorStr = crashData.error ? `\n\n크래시 에러:\n${String(crashData.error).slice(0, 1000)}` : "";

        session.nextQueryContext = {
          userId,
          context: `[SYSTEM] 서비스가 비정상 종료 후 재시작되었습니다.\n` +
            `종료 원인: ${reasonLabel}\n` +
            `종료 시각: ${crashData.timestamp || "unknown"}` +
            errorStr +
            `\n\n이전 세션의 명령은 이미 완료되었습니다. 절대 재실행하지 마세요.`,
        };

        // Send Telegram notification — OS-level crash (no SIGTERM caught)
        try {
          let telegramMsg = `🔥 **비정상 종료 후 재시작**\n\n`;
          telegramMsg += `원인: ${reasonLabel}\n`;
          telegramMsg += `시각: ${crashData.timestamp || "unknown"}`;
          if (crashData.error) {
            telegramMsg += `\n\n\`\`\`\n${String(crashData.error).slice(0, 500)}\n\`\`\``;
          }
          await bot.api.sendMessage(userId, telegramMsg, { parse_mode: "Markdown" });
        } catch {
          // best effort
        }
      }

      fsOps.unlinkSync(CRASH_MARKER_FILE);
      console.log(`[STARTUP] Crash marker processed: reason=${reason}`);
    } catch {
      try { fsOps.unlinkSync(CRASH_MARKER_FILE); } catch {}
    }
  }

  // Handle startup WITHOUT any markers — OS reboot, OOM kill, SIGKILL, power loss
  if (!restartMarkerProcessed) {
    // Check if there was a previous session (if session data exists but no markers = unexpected restart)
    const userId = ALLOWED_USERS[0];
    if (userId) {
      const session = manager.getSession(userId);
      if (session.totalQueries > 0) {
        // Had previous session but no markers = OS-level kill (OOM, SIGKILL, reboot)
        session.nextQueryContext = {
          userId,
          context: `[SYSTEM] 서비스가 재시작되었습니다.\n` +
            `재시작 원인: 🖥️ OS 재시작 또는 프로세스 강제 종료 (SIGKILL/OOM)\n` +
            `마커 파일 없음 — SIGTERM이 캐치되지 않았으므로 OS 레벨 종료로 추정됩니다.\n` +
            `이전 세션의 명령은 이미 완료되었습니다. 절대 재실행하지 마세요.`,
        };

        try {
          await bot.api.sendMessage(
            userId,
            `🖥️ **OS 재시작/강제 종료 후 복구**\n\n` +
            `SIGTERM 마커가 없어 OS 레벨 종료로 추정됩니다.\n` +
            `(OOM kill, SIGKILL, 서버 재부팅 등)`,
            { parse_mode: "Markdown" }
          );
        } catch {
          // best effort
        }
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
        const effectiveMax = session.actualContextMax ?? session.contextWindowSize;
        ctxPct = effectiveMax > 0
          ? ((session.currentContextTokens / effectiveMax) * 100).toFixed(1)
          : "?";
        contextInfo = `Context: ${ctxPct}% (${session.currentContextTokens.toLocaleString()}/${effectiveMax.toLocaleString()} tokens)`;
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
    const contextSize = session.actualContextMax ?? session.contextWindowSize;
    const contextPct =
      (contextTokens > 0 && contextSize > 0) ? ((contextTokens / contextSize) * 100).toFixed(1) : "?";
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

    // Write restart marker so next boot injects a system message.
    // Without this, Claude Code session resumes with "make up 해줘"
    // still in context and re-executes it → infinite restart loop.
    try {
      const markerData: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        pid: process.pid,
      };

      // Superpower: check for verification task — either set in-process
      // or written to /tmp/soma-verification-task.json by external tool (e.g., Claude Code Bash)
      const VERIFICATION_TASK_FILE = "/tmp/soma-verification-task.json";
      if (!pendingVerificationTask && fsOps.existsSync(VERIFICATION_TASK_FILE)) {
        try {
          pendingVerificationTask = JSON.parse(
            fsOps.readFileSync(VERIFICATION_TASK_FILE, "utf-8")
          ) as VerificationTask;
          console.log(`[SIGTERM] Loaded verification task from file: ${pendingVerificationTask.bdTaskId}`);
          fsOps.unlinkSync(VERIFICATION_TASK_FILE);
        } catch (e) {
          console.warn("[SIGTERM] Failed to read verification task file:", e);
        }
      }

      if (pendingVerificationTask) {
        markerData.verificationTask = pendingVerificationTask;
        console.log(`[SIGTERM] Including verification task: ${pendingVerificationTask.bdTaskId}`);
      }
      fsOps.writeFileSync(
        RESTART_MARKER_FILE,
        JSON.stringify(markerData),
        "utf-8"
      );
      console.log("[SIGTERM] Restart marker written");
    } catch (e) {
      console.error("[SIGTERM] Failed to write restart marker:", e);
    }

    stopRunner();
    await sleep(1000);
  };

  const setVerificationTask = (task: VerificationTask | null): void => {
    pendingVerificationTask = task;
    if (task) {
      console.log(`[SUPERPOWER] Verification task set: ${task.bdTaskId} — ${task.description}`);
    } else {
      console.log("[SUPERPOWER] Verification task cleared");
    }
  };

  // Best-effort crash notification — called from uncaughtException/unhandledRejection
  // before process dies. Synchronous Telegram call via fetch (no await needed).
  const notifyCrash = (reason: string, error?: unknown): void => {
    const userId = ALLOWED_USERS[0];
    if (!userId) return;

    const errorStr = error instanceof Error
      ? `${error.name}: ${error.message}`
      : error != null ? String(error).slice(0, 500) : "unknown";

    const reasonLabel =
      reason === "uncaughtException" ? "💥 Uncaught Exception" :
      reason === "unhandledRejection" ? "💥 Unhandled Promise Rejection" :
      `💥 Crash (${reason})`;

    const text =
      `${reasonLabel}\n\n` +
      `\`\`\`\n${errorStr.slice(0, 800)}\n\`\`\`\n\n` +
      `프로세스가 종료됩니다. systemd가 10초 후 재시작합니다.`;

    // Fire-and-forget — process is about to die
    bot.api.sendMessage(userId, text, { parse_mode: "Markdown" }).catch(() => {});
  };

  return {
    bot,
    runner,
    formStore,
    stopRunner,
    handleSigterm,
    setVerificationTask,
    notifyCrash,
  };
}
