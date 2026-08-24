/**
 * Tests: Telegram permission broker (GitHub issue #79).
 *
 * The Agent SDK asks for tool permission through `canUseTool`. Before this
 * broker existed the runtime had no `canUseTool` at all, so an exceptional
 * permission prompt (explicit ask rule, org-ask connector, critical-path
 * rm/rmdir, requiresUserInteraction) had nowhere to go and the turn stalled
 * with a permission screen the phone user could not answer.
 */
import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import {
  createTelegramPromptSender,
  PERMISSION_CALLBACK_PREFIX,
  TelegramPermissionBroker,
  type PermissionPrompt,
} from "./permission-broker";

/**
 * Telegram parses the whole message or rejects it — a truncation that lands
 * inside a tag is a hard 400. Count opens vs closes for every tag
 * `formatToolStatus` can emit, plus a trailing partial-tag check.
 */
function assertTelegramHtmlIsWellFormed(text: string): void {
  for (const tag of ["b", "i", "code", "pre"]) {
    const opens = text.match(new RegExp(`<${tag}>`, "g"))?.length ?? 0;
    const closes = text.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0;
    expect({ tag, opens, closes }).toEqual({ tag, opens: closes, closes });
  }
  // No dangling `<`, `</`, `<cod`, … at the very end.
  expect(/<[^>]*$/.test(text)).toBe(false);
}

type CanUseToolOptions = Parameters<CanUseTool>[2];

function makeToolOptions(
  overrides: Partial<CanUseToolOptions> = {}
): CanUseToolOptions {
  return {
    signal: new AbortController().signal,
    toolUseID: "toolu_test",
    ...overrides,
  };
}

interface Harness {
  broker: TelegramPermissionBroker;
  prompts: PermissionPrompt[];
  canUseTool: CanUseTool;
}

function makeHarness(options?: {
  timeoutMs?: number;
  userId?: number;
  chatId?: number;
  messageId?: number;
  abortSignal?: AbortSignal;
  sendPrompt?: (prompt: PermissionPrompt) => Promise<number | undefined>;
}): Harness {
  const prompts: PermissionPrompt[] = [];
  const messageId = options?.messageId ?? 555;
  const broker = new TelegramPermissionBroker({
    timeoutMs: options?.timeoutMs ?? 60_000,
    sendPrompt:
      options?.sendPrompt ??
      (async (prompt) => {
        prompts.push(prompt);
        return messageId;
      }),
  });
  const canUseTool = broker.createCanUseTool({
    chatId: options?.chatId ?? 111,
    userId: options?.userId ?? 222,
    sessionKey: "default:111:main",
    abortSignal: options?.abortSignal,
  });
  return { broker, prompts, canUseTool };
}

/** Yield until the broker has registered the pending request. */
async function waitForPrompt(prompts: PermissionPrompt[]): Promise<PermissionPrompt> {
  for (let i = 0; i < 50 && prompts.length === 0; i++) {
    await Bun.sleep(1);
  }
  const prompt = prompts[0];
  if (!prompt) throw new Error("no permission prompt was sent");
  return prompt;
}

describe("TelegramPermissionBroker — approve/deny round trip", () => {
  test("approve click resolves the exact pending request with updatedInput", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    const input = { command: "echo hello", description: "greet" };

    const pending = canUseTool("Bash", input, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    const resolution = broker.resolve(prompt.requestId, "allow", {
      userId: 222,
      chatId: 111,
      messageId: 555,
    });
    expect(resolution).toEqual({ status: "resolved", answer: "allow" });

    const result = await pending;
    expect(result.behavior).toBe("allow");
    if (result.behavior !== "allow") throw new Error("expected allow");
    expect(result.updatedInput).toEqual(input);
    expect(broker.pendingCount).toBe(0);
  });

  test("deny click returns behavior deny with a message", async () => {
    const { broker, prompts, canUseTool } = makeHarness();

    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(
      broker.resolve(prompt.requestId, "deny", {
        userId: 222,
        chatId: 111,
        messageId: 555,
      })
    ).toEqual({ status: "resolved", answer: "deny" });

    const result = await pending;
    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("expected deny");
    expect(result.message.length).toBeGreaterThan(0);
    expect(broker.pendingCount).toBe(0);
  });

  test("callback data carries the perm prefix and fits Telegram's 64-byte limit", async () => {
    const { prompts, canUseTool } = makeHarness();
    void canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(prompt.approveData.startsWith(PERMISSION_CALLBACK_PREFIX)).toBe(true);
    expect(prompt.denyData.startsWith(PERMISSION_CALLBACK_PREFIX)).toBe(true);
    expect(prompt.approveData).not.toBe(prompt.denyData);
    expect(Buffer.byteLength(prompt.approveData, "utf-8")).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(prompt.denyData, "utf-8")).toBeLessThanOrEqual(64);
  });
});

describe("TelegramPermissionBroker — fail closed on bad answers", () => {
  test("wrong user cannot answer, correct user still can", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(
      broker.resolve(prompt.requestId, "allow", {
        userId: 999,
        chatId: 111,
        messageId: 555,
      })
    ).toEqual({ status: "forbidden" });
    expect(broker.pendingCount).toBe(1);

    broker.resolve(prompt.requestId, "deny", {
      userId: 222,
      chatId: 111,
      messageId: 555,
    });
    const result = await pending;
    expect(result.behavior).toBe("deny");
  });

  test("wrong chat cannot answer", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    void canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(
      broker.resolve(prompt.requestId, "allow", {
        userId: 222,
        chatId: -100999,
        messageId: 555,
      })
    ).toEqual({ status: "forbidden" });
    expect(broker.pendingCount).toBe(1);
  });

  test("stale message id (superseded prompt) cannot answer", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    void canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(
      broker.resolve(prompt.requestId, "allow", {
        userId: 222,
        chatId: 111,
        messageId: 4242,
      })
    ).toEqual({ status: "stale" });
    expect(broker.pendingCount).toBe(1);
  });

  test("a click carrying no message id cannot answer a message-bound prompt", async () => {
    // A callback_query whose `message` is absent (too old to fetch, or a
    // forged/inline update) must not slip past the message binding.
    const { broker, prompts, canUseTool } = makeHarness();
    void canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(
      broker.resolve(prompt.requestId, "allow", { userId: 222, chatId: 111 })
    ).toEqual({ status: "stale" });
    expect(broker.pendingCount).toBe(1);
  });

  test("a prompt with an unknown message id still accepts a matching actor", async () => {
    // Transport could not report a message id (sender returned undefined),
    // so chat + user binding is the whole guard — the request must not become
    // permanently unanswerable.
    const { broker, prompts, canUseTool } = makeHarness({
      sendPrompt: async (prompt) => {
        prompts.push(prompt);
        return undefined;
      },
    });
    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    expect(
      broker.resolve(prompt.requestId, "deny", {
        userId: 222,
        chatId: 111,
        messageId: 4242,
      })
    ).toEqual({ status: "resolved", answer: "deny" });
    expect((await pending).behavior).toBe("deny");
  });

  test("duplicate click after resolution is unknown and cannot flip the answer", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    const prompt = await waitForPrompt(prompts);

    const actor = { userId: 222, chatId: 111, messageId: 555 };
    expect(broker.resolve(prompt.requestId, "deny", actor)).toEqual({
      status: "resolved",
      answer: "deny",
    });
    expect(broker.resolve(prompt.requestId, "allow", actor)).toEqual({
      status: "unknown",
    });

    const result = await pending;
    expect(result.behavior).toBe("deny");
  });

  test("an unrelated request id never resolves a different pending request", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    void canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    await waitForPrompt(prompts);

    expect(
      broker.resolve("nosuchid", "allow", {
        userId: 222,
        chatId: 111,
        messageId: 555,
      })
    ).toEqual({ status: "unknown" });
    expect(broker.pendingCount).toBe(1);
  });

  test("timeout denies (fail closed) instead of hanging the query", async () => {
    const { broker, prompts, canUseTool } = makeHarness({ timeoutMs: 20 });
    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    await waitForPrompt(prompts);

    const result = await pending;
    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("expected deny");
    expect(result.message).toContain("timed out");
    expect(broker.pendingCount).toBe(0);
  });

  test("SDK abort signal denies (fail closed)", async () => {
    const controller = new AbortController();
    const { broker, prompts, canUseTool } = makeHarness();
    const pending = canUseTool(
      "Bash",
      { command: "echo hi" },
      makeToolOptions({ signal: controller.signal })
    );
    await waitForPrompt(prompts);

    controller.abort();
    const result = await pending;
    expect(result.behavior).toBe("deny");
    expect(broker.pendingCount).toBe(0);
  });

  test("session abort signal (stop/kill) denies pending prompts", async () => {
    const sessionAbort = new AbortController();
    const { broker, prompts, canUseTool } = makeHarness({
      abortSignal: sessionAbort.signal,
    });
    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    await waitForPrompt(prompts);

    sessionAbort.abort();
    const result = await pending;
    expect(result.behavior).toBe("deny");
    expect(broker.pendingCount).toBe(0);
  });

  test("cancelAll denies every pending prompt (bot shutdown)", async () => {
    const { broker, prompts, canUseTool } = makeHarness();
    const pending = canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    await waitForPrompt(prompts);

    expect(broker.cancelAll("bot shutting down")).toBe(1);
    const result = await pending;
    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("expected deny");
    expect(result.message).toContain("bot shutting down");
    expect(broker.pendingCount).toBe(0);
  });

  test("no prompt sender bound denies instead of blocking forever", async () => {
    const broker = new TelegramPermissionBroker();
    const canUseTool = broker.createCanUseTool({
      chatId: 111,
      userId: 222,
      sessionKey: "default:111:main",
    });

    const result = await canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    expect(result.behavior).toBe("deny");
    expect(broker.pendingCount).toBe(0);
  });

  test("prompt delivery failure denies instead of blocking forever", async () => {
    const { broker, canUseTool } = makeHarness({
      sendPrompt: async () => {
        throw new Error("Bad Request: chat not found");
      },
    });

    const result = await canUseTool("Bash", { command: "echo hi" }, makeToolOptions());
    expect(result.behavior).toBe("deny");
    expect(broker.pendingCount).toBe(0);
  });
});

describe("TelegramPermissionBroker — safety layers stay authoritative", () => {
  test("hard-denied command is refused without ever asking the user", async () => {
    const { broker, prompts, canUseTool } = makeHarness();

    const result = await canUseTool("Bash", { command: "rm -rf /" }, makeToolOptions());

    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("expected deny");
    expect(result.message).toContain("Unsafe command blocked");
    expect(prompts).toHaveLength(0);
    expect(broker.pendingCount).toBe(0);
  });

  test("blocked path is refused without ever asking the user", async () => {
    const { prompts, canUseTool } = makeHarness();

    const result = await canUseTool(
      "Read",
      { file_path: "/etc/passwd" },
      makeToolOptions()
    );

    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("expected deny");
    expect(result.message).toContain("File access blocked");
    expect(prompts).toHaveLength(0);
  });

  test("native AskUserQuestion is redirected to the user_choice JSON flow, not a yes/no prompt", async () => {
    const { prompts, canUseTool } = makeHarness();

    const result = await canUseTool(
      "AskUserQuestion",
      { questions: [{ question: "Which one?" }] },
      makeToolOptions()
    );

    expect(result.behavior).toBe("deny");
    if (result.behavior !== "deny") throw new Error("expected deny");
    expect(result.message).toContain("user_choice");
    // A generic Approve/Deny keyboard would destroy the structured choice UX.
    expect(prompts).toHaveLength(0);
  });
});

describe("TelegramPermissionBroker — prompt rendering", () => {
  test("uses the SDK-provided title when present", async () => {
    const { prompts, canUseTool } = makeHarness();
    void canUseTool(
      "Bash",
      { command: "rmdir /Users/z/tmpdir" },
      makeToolOptions({ title: "Claude wants to remove directory tmpdir" })
    );
    const prompt = await waitForPrompt(prompts);

    expect(prompt.text).toContain("Claude wants to remove directory tmpdir");
    expect(prompt.chatId).toBe(111);
  });

  test("falls back to a tool summary and escapes HTML when there is no title", async () => {
    const { prompts, canUseTool } = makeHarness();
    void canUseTool(
      "Bash",
      { command: "echo '<script>alert(1)</script>'" },
      makeToolOptions()
    );
    const prompt = await waitForPrompt(prompts);

    expect(prompt.text).toContain("Bash");
    expect(prompt.text).not.toContain("<script>");
    expect(prompt.text).toContain("&lt;script&gt;");
  });

  test("truncates very long tool input so Telegram accepts the message", async () => {
    const { prompts, canUseTool } = makeHarness();
    void canUseTool(
      "WebFetch",
      { url: "https://example.com", prompt: "x".repeat(20_000) },
      makeToolOptions()
    );
    const prompt = await waitForPrompt(prompts);

    expect(prompt.text.length).toBeLessThanOrEqual(4096);
    assertTelegramHtmlIsWellFormed(prompt.text);
  });

  test("degrades an unbounded MCP summary instead of cutting inside a tag", async () => {
    // formatToolStatus renders AI-MCP calls as multi-line HTML ending in an
    // UNBOUNDED `<code>{...config json...}</code>` block. Length-truncating
    // that lands mid-tag and Telegram rejects the whole message with 400
    // "Can't parse entities".
    const { prompts, canUseTool } = makeHarness();
    const config: Record<string, string> = {};
    for (let i = 0; i < 400; i++) {
      config[`option_${i}`] = "y".repeat(60);
    }
    void canUseTool(
      "mcp__codex__codex",
      { prompt: "review this", model: "gpt-5.6", ...config },
      makeToolOptions()
    );
    const prompt = await waitForPrompt(prompts);

    expect(prompt.text.length).toBeLessThanOrEqual(4096);
    assertTelegramHtmlIsWellFormed(prompt.text);
    // The tool is still identifiable after degrading.
    expect(prompt.text).toContain("mcp__codex__codex");
  });

  test("keeps a bounded multi-line summary intact and well-formed", async () => {
    const { prompts, canUseTool } = makeHarness();
    void canUseTool(
      "TodoWrite",
      {
        todos: [
          { content: "first task", status: "in_progress" },
          { content: "second task", status: "pending" },
        ],
      },
      makeToolOptions()
    );
    const prompt = await waitForPrompt(prompts);

    expect(prompt.text).toContain("Task List");
    expect(prompt.text.length).toBeLessThanOrEqual(4096);
    assertTelegramHtmlIsWellFormed(prompt.text);
  });
});

describe("TelegramPermissionBroker — request ids", () => {
  test("regenerates a colliding request id instead of clobbering a live request", async () => {
    // A deterministic/unlucky id factory must never make two live prompts
    // share a key — the second would silently replace the first, stranding
    // the first query forever.
    const prompts: PermissionPrompt[] = [];
    const broker = new TelegramPermissionBroker({
      timeoutMs: 60_000,
      createRequestId: () => "dup",
      sendPrompt: async (prompt) => {
        prompts.push(prompt);
        return 555;
      },
    });
    const canUseTool = broker.createCanUseTool({
      chatId: 111,
      userId: 222,
      sessionKey: "default:111:main",
    });

    const first = canUseTool("Bash", { command: "echo one" }, makeToolOptions());
    const second = canUseTool("Bash", { command: "echo two" }, makeToolOptions());
    for (let i = 0; i < 50 && prompts.length < 2; i++) {
      await Bun.sleep(1);
    }

    expect(prompts).toHaveLength(2);
    expect(prompts[0]!.requestId).not.toBe(prompts[1]!.requestId);
    expect(broker.pendingCount).toBe(2);
    expect(Buffer.byteLength(prompts[1]!.approveData, "utf-8")).toBeLessThanOrEqual(64);

    const actor = { userId: 222, chatId: 111, messageId: 555 };
    broker.resolve(prompts[0]!.requestId, "allow", actor);
    expect(broker.pendingCount).toBe(1);
    const firstResult = await first;
    expect(firstResult.behavior).toBe("allow");
    if (firstResult.behavior !== "allow") throw new Error("expected allow");
    expect(firstResult.updatedInput).toEqual({ command: "echo one" });

    broker.resolve(prompts[1]!.requestId, "deny", actor);
    expect((await second).behavior).toBe("deny");
  });
});

describe("createTelegramPromptSender", () => {
  function makePrompt(overrides: Partial<PermissionPrompt> = {}): PermissionPrompt {
    return {
      requestId: "req1",
      chatId: -1001234567890,
      text: "🔐 <b>도구 권한 요청</b>",
      approveData: "perm:req1:a",
      denyData: "perm:req1:d",
      ...overrides,
    };
  }

  test("sends an HTML approve/deny keyboard and returns the message id", async () => {
    const calls: Array<{
      chatId: number;
      text: string;
      other?: Record<string, unknown>;
    }> = [];
    const sender = createTelegramPromptSender({
      sendMessage: async (chatId, text, other) => {
        calls.push({ chatId, text, other });
        return { message_id: 4242 };
      },
    });

    const messageId = await sender(makePrompt());

    expect(messageId).toBe(4242);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.chatId).toBe(-1001234567890);
    expect(calls[0]!.text).toBe("🔐 <b>도구 권한 요청</b>");
    expect(calls[0]!.other?.parse_mode).toBe("HTML");
    expect(calls[0]!.other?.message_thread_id).toBeUndefined();

    const keyboard = (
      calls[0]!.other?.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      }
    ).inline_keyboard;
    expect(keyboard[0]!.map((button) => button.callback_data)).toEqual([
      "perm:req1:a",
      "perm:req1:d",
    ]);
    expect(keyboard[0]![0]!.text).toContain("승인");
    expect(keyboard[0]![1]!.text).toContain("거부");
  });

  test("targets a forum topic only when the prompt carries one", async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const sender = createTelegramPromptSender({
      sendMessage: async (_chatId, _text, other) => {
        calls.push(other);
        return { message_id: 1 };
      },
    });

    await sender(makePrompt({ threadId: 77 }));
    expect(calls[0]?.message_thread_id).toBe(77);
  });
});
