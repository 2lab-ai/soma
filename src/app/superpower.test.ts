/**
 * RED-GREEN tests for soma-86ew: Superpower — autonomous deploy + verify loop
 *
 * The "superpower" is the ability to:
 * 1. Save verification task before SIGTERM (what to verify after restart)
 * 2. Auto-run verification on boot
 * 3. Report result to telegram
 * 4. On failure: inject fix request into Claude session (auto-fix trigger)
 */
import { describe, test, expect, mock } from "bun:test";
import type { Bot, Context } from "grammy";
import { bootstrapApplication } from "./bootstrap";

// ─── Shared Test Helpers ───────────────────────────────────────────

function createFakeBot() {
  const sentMessages: Array<{ chatId: number; text: string }> = [];
  return {
    bot: {
      api: {
        getMe: mock(async () => ({ username: "soma_test_bot" })),
        editMessageText: mock(async () => true),
        sendMessage: mock(async (chatId: number, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 1 };
        }),
        setMessageReaction: mock(async () => true),
      },
    } as unknown as Bot<Context>,
    sentMessages,
  };
}

function createFakeSession() {
  let _nextQueryContext: string | null = null;
  return {
    isActive: false,
    sessionStartTime: null,
    currentContextTokens: 0,
    contextWindowSize: 200000,
    totalQueries: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    hasSteeringMessages: () => false,
    getSteeringCount: () => 0,
    consumeSteering: () => null,
    formatToolStats: () => "",
    sendMessageStreaming: mock(async () => "ok"),
    get nextQueryContext() {
      return _nextQueryContext;
    },
    set nextQueryContext(v: string | null) {
      _nextQueryContext = v;
    },
  };
}

function createFakeManager(session: ReturnType<typeof createFakeSession>) {
  return {
    getGlobalStats: () => ({
      totalSessions: 0,
      totalQueries: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      sessions: [],
    }),
    getSession: () => session,
    getSessionByKey: () => session,
    saveAllSessions: mock(() => {}),
  };
}

function createFakeFs(files: Record<string, string> = {}) {
  const written: Record<string, string> = {};
  const deleted: string[] = [];

  return {
    ops: {
      existsSync: (path: string) => path in files || path in written,
      readFileSync: (path: string) => files[path] || written[path] || "",
      unlinkSync: (path: string) => {
        deleted.push(path);
        delete files[path];
        delete written[path];
      },
      writeFileSync: (path: string, content: string) => {
        written[path] = content;
      },
      mkdirSync: () => {},
    },
    written,
    deleted,
  };
}

const RESTART_MARKER_FILE = "/tmp/soma-restart-marker.json";

// ─── Tests ─────────────────────────────────────────────────────────

describe("Superpower: autonomous deploy + verify (soma-86ew)", () => {
  test("RED: SIGTERM handler writes verification task to restart marker", async () => {
    const { bot, sentMessages } = createFakeBot();
    const session = createFakeSession();
    const manager = createFakeManager(session);
    const fs = createFakeFs();

    const app = await bootstrapApplication({
      createTelegramBot: () => bot,
      registerBotMiddleware: () => {},
      registerBotCommands: async () => {},
      registerBotHandlers: () => {},
      configureAndStartScheduler: () => {},
      stopSchedulerRunner: () => {},
      startRunner: () => ({ isRunning: () => true, stop: () => {} }),
      sessionManager: manager,
      createFormStore: () => ({ loadForms: async () => 0 }),
      fs: fs.ops,
      sendSystemMessage: mock(async () => null),
      addSystemReaction: mock(async () => {}),
      sleep: async () => {},
    });

    // Set a pending verification task before SIGTERM
    // This is what "make up" should do: register what to verify after restart
    (app as any).setVerificationTask?.({
      command: "bun test src/handlers/text/steering-flow.integration.test.ts",
      bdTaskId: "soma-uqb9",
      description: "steering buffer duplication fix",
    });

    await app.handleSigterm();

    // The restart marker should now include verification task
    const markerContent = fs.written[RESTART_MARKER_FILE];
    expect(markerContent).toBeDefined();

    const marker = JSON.parse(markerContent!);
    expect(marker.verificationTask).toBeDefined();
    expect(marker.verificationTask.command).toContain("bun test");
    expect(marker.verificationTask.bdTaskId).toBe("soma-uqb9");
  });

  test("RED: boot auto-runs verification and reports SUCCESS to telegram", async () => {
    const { bot, sentMessages } = createFakeBot();
    const session = createFakeSession();
    const manager = createFakeManager(session);

    // Simulate restart marker WITH verification task
    const markerData = JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: 12345,
      verificationTask: {
        command: "echo PASS",
        bdTaskId: "soma-uqb9",
        description: "steering fix",
      },
    });

    const fs = createFakeFs({
      [RESTART_MARKER_FILE]: markerData,
    });

    // Mock execSync for verification
    const execResults: Array<{ command: string; exitCode: number }> = [];
    const mockExecSync = mock((cmd: string) => {
      execResults.push({ command: cmd, exitCode: 0 });
      return { status: 0, stdout: "PASS", stderr: "" };
    });

    const app = await bootstrapApplication({
      createTelegramBot: () => bot,
      registerBotMiddleware: () => {},
      registerBotCommands: async () => {},
      registerBotHandlers: () => {},
      configureAndStartScheduler: () => {},
      stopSchedulerRunner: () => {},
      startRunner: () => ({ isRunning: () => true, stop: () => {} }),
      sessionManager: manager,
      createFormStore: () => ({ loadForms: async () => 0 }),
      fs: fs.ops,
      sendSystemMessage: mock(async () => null),
      addSystemReaction: mock(async () => {}),
      sleep: async () => {},
      execSync: mockExecSync,
    });

    // Verification should have been executed
    expect(execResults.length).toBeGreaterThan(0);
    expect(execResults[0]!.command).toContain("echo PASS");

    // Should have sent success notification to telegram
    const successMsg = sentMessages.find(
      (m) => m.text.includes("✅") && m.text.includes("soma-uqb9")
    );
    expect(successMsg).toBeDefined();
  });

  test("RED: boot auto-runs verification and injects FIX REQUEST on FAILURE", async () => {
    const { bot, sentMessages } = createFakeBot();
    const session = createFakeSession();
    const manager = createFakeManager(session);

    // Marker with verification that will FAIL
    const markerData = JSON.stringify({
      timestamp: new Date().toISOString(),
      pid: 12345,
      verificationTask: {
        command: "exit 1",
        bdTaskId: "soma-86ew",
        description: "should fail",
      },
    });

    const fs = createFakeFs({
      [RESTART_MARKER_FILE]: markerData,
    });

    const mockExecSync = mock((cmd: string) => {
      return { status: 1, stdout: "", stderr: "FAILED" };
    });

    const app = await bootstrapApplication({
      createTelegramBot: () => bot,
      registerBotMiddleware: () => {},
      registerBotCommands: async () => {},
      registerBotHandlers: () => {},
      configureAndStartScheduler: () => {},
      stopSchedulerRunner: () => {},
      startRunner: () => ({ isRunning: () => true, stop: () => {} }),
      sessionManager: manager,
      createFormStore: () => ({ loadForms: async () => 0 }),
      fs: fs.ops,
      sendSystemMessage: mock(async () => null),
      addSystemReaction: mock(async () => {}),
      sleep: async () => {},
      execSync: mockExecSync,
    });

    // Should have sent failure notification to telegram
    const failMsg = sentMessages.find(
      (m) => m.text.includes("❌") && m.text.includes("soma-86ew")
    );
    expect(failMsg).toBeDefined();

    // CRITICAL: should inject fix request into session context
    // So next Claude message will auto-trigger fix attempt
    expect(session.nextQueryContext).not.toBeNull();
    expect(session.nextQueryContext).toContain("검증 실패");
    expect(session.nextQueryContext).toContain("자동 수정");
  });

  test("RED: setVerificationTask is exposed on bootstrapped application", async () => {
    const { bot } = createFakeBot();
    const session = createFakeSession();
    const manager = createFakeManager(session);
    const fs = createFakeFs();

    const app = await bootstrapApplication({
      createTelegramBot: () => bot,
      registerBotMiddleware: () => {},
      registerBotCommands: async () => {},
      registerBotHandlers: () => {},
      configureAndStartScheduler: () => {},
      stopSchedulerRunner: () => {},
      startRunner: () => ({ isRunning: () => true, stop: () => {} }),
      sessionManager: manager,
      createFormStore: () => ({ loadForms: async () => 0 }),
      fs: fs.ops,
      sendSystemMessage: mock(async () => null),
      addSystemReaction: mock(async () => {}),
      sleep: async () => {},
    });

    // setVerificationTask must exist as a function
    expect(typeof (app as any).setVerificationTask).toBe("function");
  });
});
