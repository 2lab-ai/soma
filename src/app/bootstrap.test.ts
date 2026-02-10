import { describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";
import { bootstrapApplication } from "./bootstrap";

describe("bootstrapApplication", () => {
  test("invokes middleware/command/handler registration and scheduler wiring", async () => {
    const fakeBot = {
      api: {
        getMe: mock(async () => ({ username: "soma_test_bot" })),
        editMessageText: mock(async () => true),
        sendMessage: mock(async () => ({ message_id: 1 })),
        setMessageReaction: mock(async () => true),
      },
    } as unknown as Bot<Context>;

    const registerMiddleware = mock(() => {});
    const registerCommands = mock(async () => {});
    const registerHandlers = mock(() => {});
    const configureScheduler = mock(() => {});
    const stopScheduler = mock(() => {});
    const runnerStop = mock(() => {});
    const startRunner = mock(() => ({
      isRunning: () => true,
      stop: runnerStop,
    }));
    const saveAllSessions = mock(() => {});
    const loadForms = mock(async () => 0);

    const manager = {
      getGlobalStats: () => ({
        totalSessions: 0,
        totalQueries: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        sessions: [],
      }),
      getSession: () => ({
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
      }),
      saveAllSessions,
    };

    const app = await bootstrapApplication({
      createTelegramBot: () => fakeBot,
      registerBotMiddleware: registerMiddleware,
      registerBotCommands: registerCommands,
      registerBotHandlers: registerHandlers,
      configureAndStartScheduler: configureScheduler,
      stopSchedulerRunner: stopScheduler,
      startRunner,
      sessionManager: manager,
      createFormStore: () => ({ loadForms }),
      fs: {
        existsSync: () => false,
        readFileSync: () => "",
        unlinkSync: () => {},
        writeFileSync: () => {},
        mkdirSync: () => {},
      },
      sendSystemMessage: mock(async () => null),
      addSystemReaction: mock(async () => {}),
      sleep: async () => {},
    });

    expect(registerMiddleware).toHaveBeenCalledTimes(1);
    expect(registerCommands).toHaveBeenCalledTimes(1);
    expect(registerHandlers).toHaveBeenCalledTimes(1);
    expect(configureScheduler).toHaveBeenCalledTimes(1);
    expect(loadForms).toHaveBeenCalledTimes(1);

    app.stopRunner();

    expect(stopScheduler).toHaveBeenCalledTimes(1);
    expect(saveAllSessions).toHaveBeenCalledTimes(1);
    expect(runnerStop).toHaveBeenCalledTimes(1);
  });
});
