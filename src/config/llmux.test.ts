import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { buildProviderEnv, getAuthMode, getLlmuxSettings, isLlmuxMode } from "./llmux";
import { ClaudeProviderAdapter } from "../providers/claude-adapter";
import { buildQueryRuntimeOptions, createQueryRuntimeHooks } from "../core/session/query-runtime";
import { createSessionIdentity } from "../routing/session-key";

const MANAGED_KEYS = [
  "AUTH_MODE",
  "LLMUX_BASE_URL",
  "LLMUX_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of MANAGED_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const value = envSnapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("getAuthMode / isLlmuxMode", () => {
  test("defaults to llmux when AUTH_MODE is unset", () => {
    expect(getAuthMode()).toBe("llmux");
    expect(isLlmuxMode()).toBe(true);
  });

  test("AUTH_MODE=oauth opts out of llmux", () => {
    process.env.AUTH_MODE = "oauth";
    expect(getAuthMode()).toBe("oauth");
    expect(isLlmuxMode()).toBe(false);
  });

  test("AUTH_MODE is case/whitespace tolerant", () => {
    process.env.AUTH_MODE = "  OAuth ";
    expect(getAuthMode()).toBe("oauth");
  });
});

describe("getLlmuxSettings", () => {
  test("falls back to local proxy defaults", () => {
    expect(getLlmuxSettings()).toEqual({
      baseUrl: "http://localhost:3456",
      apiKey: "llmux-local-placeholder",
    });
  });

  test("honours LLMUX_BASE_URL / LLMUX_API_KEY overrides", () => {
    process.env.LLMUX_BASE_URL = "http://127.0.0.1:9999";
    process.env.LLMUX_API_KEY = "custom-key";
    expect(getLlmuxSettings()).toEqual({
      baseUrl: "http://127.0.0.1:9999",
      apiKey: "custom-key",
    });
  });
});

describe("buildProviderEnv", () => {
  test("llmux mode sets base url + api key and drops OAuth tokens", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";
    process.env.ANTHROPIC_AUTH_TOKEN = "stale-auth-token";

    const env = buildProviderEnv();

    expect(env).toBeDefined();
    expect(env?.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
    expect(env?.ANTHROPIC_API_KEY).toBe("llmux-local-placeholder");
    expect(env && "CLAUDE_CODE_OAUTH_TOKEN" in env).toBe(false);
    expect(env && "ANTHROPIC_AUTH_TOKEN" in env).toBe(false);
  });

  test("llmux mode reflects env overrides", () => {
    process.env.LLMUX_BASE_URL = "http://127.0.0.1:9999";
    process.env.LLMUX_API_KEY = "custom-key";

    const env = buildProviderEnv();

    expect(env?.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:9999");
    expect(env?.ANTHROPIC_API_KEY).toBe("custom-key");
  });

  test("llmux mode passes through inherited variables", () => {
    const env = buildProviderEnv();
    expect(env?.PATH).toBe(process.env.PATH as string);
  });

  test("oauth mode returns undefined (SDK inherits process.env)", () => {
    process.env.AUTH_MODE = "oauth";
    expect(buildProviderEnv()).toBeUndefined();
  });

  test("never mutates process.env", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";
    const before = JSON.stringify({ ...process.env });

    buildProviderEnv();

    expect(JSON.stringify({ ...process.env })).toBe(before);
    expect(process.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("stale-oauth-token");
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("returns a fresh object on every call", () => {
    const first = buildProviderEnv();
    const second = buildProviderEnv();

    expect(first).not.toBe(second);
    expect(first).toEqual(second as Record<string, string>);

    first!.ANTHROPIC_BASE_URL = "http://mutated";
    expect(second?.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
  });
});

describe("SDK call sites carry the provider env", () => {
  test("ClaudeProviderAdapter query options include the llmux env", async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";
    let captured: (Options & { abortController: AbortController }) | null = null;

    const adapter = new ClaudeProviderAdapter(({ options }) => {
      captured = options;
      return (async function* () {
        yield {
          type: "result",
          subtype: "success",
          session_id: "session-1",
        } as unknown as SDKMessage;
      })();
    });

    const handle = await adapter.startQuery({
      queryId: "query-1",
      identity: createSessionIdentity({
        tenantId: "tenant-a",
        channelId: "telegram",
        threadId: "thread-1",
      }),
      prompt: "hello",
      modelId: "claude-opus-4-7",
      workingDirectory: "/tmp",
    });
    await adapter.streamEvents(handle, async () => {});

    const options = captured as unknown as Options;
    expect(options.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
    expect(options.env?.ANTHROPIC_API_KEY).toBe("llmux-local-placeholder");
    expect(options.env && "CLAUDE_CODE_OAUTH_TOKEN" in options.env).toBe(false);
  });

  test("buildQueryRuntimeOptions includes the llmux env", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "stale-oauth-token";

    const options = buildQueryRuntimeOptions({
      model: "claude-opus-4-7",
      cwd: "/tmp",
      systemPrompt: "sys",
      mcpServers: {},
      maxThinkingTokens: 1000,
      additionalDirectories: [],
      resumeSessionId: null,
      abortController: new AbortController(),
      hooks: createQueryRuntimeHooks({
        getStopRequested: () => false,
        getSteeringCount: () => 0,
        trackBufferedMessagesForInjection: () => 0,
        consumeSteering: () => null,
        getInjectedCount: () => 0,
      }),
    });

    expect(options.env?.ANTHROPIC_BASE_URL).toBe("http://localhost:3456");
    expect(options.env?.ANTHROPIC_API_KEY).toBe("llmux-local-placeholder");
    expect(options.env && "CLAUDE_CODE_OAUTH_TOKEN" in options.env).toBe(false);
  });

  test("buildQueryRuntimeOptions omits env in oauth mode", () => {
    process.env.AUTH_MODE = "oauth";

    const options = buildQueryRuntimeOptions({
      model: "claude-opus-4-7",
      cwd: "/tmp",
      systemPrompt: "sys",
      mcpServers: {},
      maxThinkingTokens: 1000,
      additionalDirectories: [],
      resumeSessionId: null,
      abortController: new AbortController(),
      hooks: createQueryRuntimeHooks({
        getStopRequested: () => false,
        getSteeringCount: () => 0,
        trackBufferedMessagesForInjection: () => 0,
        consumeSteering: () => null,
        getInjectedCount: () => 0,
      }),
    });

    expect(options.env).toBeUndefined();
  });
});
