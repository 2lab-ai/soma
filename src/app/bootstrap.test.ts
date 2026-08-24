import { afterEach, describe, expect, mock, test } from "bun:test";
import type { Bot, Context } from "grammy";
import { permissionBroker } from "../core/session/permission-broker";
import { bootstrapApplication } from "./bootstrap";

// bootstrapApplication binds the PROCESS-GLOBAL broker to the bot Api; leaving
// a fake transport bound would leak into every later test file.
afterEach(() => {
  permissionBroker.setPromptSender(null);
});

function makeFakeSession() {
  return {
    isActive: false,
    sessionStartTime: null,
    currentContextTokens: 0,
    contextWindowSize: 200000,
    actualContextMax: null,
    totalQueries: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    hasSteeringMessages: () => false,
    getSteeringCount: () => 0,
    consumeSteering: () => null,
    formatToolStats: () => "",
    sendMessageStreaming: mock(async () => "ok"),
    nextQueryContext: null,
  };
}

async function bootstrapWithFakes() {
  const sendMessage = mock(async () => ({ message_id: 1 }));
  const fakeBot = {
    api: {
      getMe: mock(async () => ({ username: "soma_test_bot" })),
      editMessageText: mock(async () => true),
      sendMessage,
      setMessageReaction: mock(async () => true),
    },
  } as unknown as Bot<Context>;

  const runnerStop = mock(() => {});
  const manager = {
    getGlobalStats: () => ({
      totalSessions: 0,
      totalQueries: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      sessions: [],
    }),
    getSession: makeFakeSession,
    getSessionByKey: makeFakeSession,
    resetSessionByKey: () => {},
    saveAllSessions: mock(() => {}),
  };

  const app = await bootstrapApplication({
    createTelegramBot: () => fakeBot,
    registerBotMiddleware: mock(() => {}),
    registerBotCommands: mock(async () => {}),
    registerBotHandlers: mock(() => {}),
    configureAndStartScheduler: mock(() => {}),
    stopSchedulerRunner: mock(() => {}),
    startRunner: mock(() => ({ isRunning: () => true, stop: runnerStop })),
    sessionManager: manager,
    createFormStore: () => ({ loadForms: mock(async () => 0) }),
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

  return { app, sendMessage };
}

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
        actualContextMax: null,
        totalQueries: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        hasSteeringMessages: () => false,
        getSteeringCount: () => 0,
        consumeSteering: () => null,
        formatToolStats: () => "",
        sendMessageStreaming: mock(async () => "ok"),
        nextQueryContext: null,
      }),
      getSessionByKey: () => ({
        isActive: false,
        sessionStartTime: null,
        currentContextTokens: 0,
        contextWindowSize: 200000,
        actualContextMax: null,
        totalQueries: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        hasSteeringMessages: () => false,
        getSteeringCount: () => 0,
        consumeSteering: () => null,
        formatToolStats: () => "",
        sendMessageStreaming: mock(async () => "ok"),
        nextQueryContext: null,
      }),
      resetSessionByKey: () => {},
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

  test("stopRunner unbinds the permission transport — a later prompt denies without sending (PR #80 review)", async () => {
    // cancelAll() only drains prompts that are ALREADY pending. A query still
    // winding down after shutdown can reach canUseTool afterwards; with the
    // sender still bound it posts a keyboard into a chat nobody is polling and
    // waits 10 minutes for a click that can never arrive.
    const { app, sendMessage } = await bootstrapWithFakes();

    app.stopRunner();
    sendMessage.mockClear();

    const canUseTool = permissionBroker.createCanUseTool({
      chatId: 990002,
      userId: 990002,
      sessionKey: "default:990002:main",
    });
    const result = await canUseTool(
      "Bash",
      { command: "echo after shutdown" },
      { signal: new AbortController().signal, toolUseID: "toolu_shutdown" }
    );

    expect(result.behavior).toBe("deny");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(permissionBroker.pendingCount).toBe(0);
  });
});
