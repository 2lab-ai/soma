/**
 * Integration test: Steering message flow end-to-end
 *
 * Tests the ACTUAL steering pipeline with:
 * - Real ClaudeSession + real SteeringManager (not mocked)
 * - Mocked grammy Context (telegram API)
 * - Mocked sendMessageStreaming (Claude model)
 *
 * Bug: soma-uqb9 — 3 messages duplicated to 6
 * Root cause: trackBufferedMessagesForInjection() copied buffer to
 * injectedSteeringDuringQuery WITHOUT clearing buffer, then
 * restoreInjectedSteering() merged injected BACK into still-populated buffer.
 */
import { describe, test, expect, mock, beforeEach } from "bun:test";
import type { Context } from "grammy";
import { ClaudeSession } from "../../core/session/session";
import { handleSteeringGate } from "./interrupt-flow";
import { runQueryFlow } from "./query-flow";

// ─── Mock Factories ────────────────────────────────────────────────

function createMockContext(messageText: string, messageId = 100): {
  ctx: Context;
  state: {
    replies: string[];
    systemMessages: string[];
    reactions: string[];
  };
} {
  const state = {
    replies: [] as string[],
    systemMessages: [] as string[],
    reactions: [] as string[],
  };

  let msgSeq = 700;

  const ctx = {
    from: { id: 1, username: "jihyuk" },
    chat: { id: 456, type: "private" },
    message: {
      text: messageText,
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
    },
    api: {
      setMessageReaction: mock(
        async (_chatId: number, _msgId: number, reactions: any[]) => {
          state.reactions.push(reactions[0]?.emoji || "unknown");
          return true;
        }
      ),
      editMessageText: mock(async () => true),
      deleteMessage: mock(async () => true),
      sendMessage: mock(
        async (_chatId: number, text: string, _opts?: any) => {
          state.systemMessages.push(text);
          return { message_id: msgSeq++, chat: { id: 456 } };
        }
      ),
    },
    reply: mock(async (text: string, _opts?: any) => {
      state.replies.push(text);
      return { message_id: msgSeq++, chat: { id: 456 } };
    }),
  } as unknown as Context;

  return { ctx, state };
}

function noopReaction(_reaction: string): Promise<void> {
  return Promise.resolve();
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("Integration: Steering message flow (soma-uqb9)", () => {
  let session: ClaudeSession;

  beforeEach(() => {
    session = new ClaudeSession("test:steering:integration", null);
  });

  test("BUG soma-uqb9: messages sent during processing must NOT be duplicated in auto-continue", async () => {
    // ── STEP 1: Simulate first query being processed ──
    const stopProcessing = session.startProcessing();
    expect(session.isProcessing).toBe(true);

    // ── STEP 2: While processing, 3 messages arrive via handleSteeringGate ──
    for (let i = 1; i <= 3; i++) {
      const { ctx: steeringCtx } = createMockContext(String(i), 200 + i);
      const handled = await handleSteeringGate({
        ctx: steeringCtx,
        session,
        message: String(i),
        wasInterrupt: false,
        chatId: 456,
        userId: 1,
        username: "jihyuk",
        deliverInboundReaction: noopReaction,
      });
      expect(handled).toBe(true); // All should be gated to steering buffer
    }

    // Verify exactly 3 messages in buffer
    expect(session.getSteeringCount()).toBe(3);

    // ── STEP 3: First query finishes, stop processing ──
    stopProcessing();
    expect(session.isProcessing).toBe(false);

    // ── STEP 4: Simulate what query-flow auto-continue does ──
    // This is the EXACT sequence from query-flow.ts after sendMessageStreaming returns:
    //
    // BEFORE FIX: called trackBufferedMessagesForInjection() → duplicated
    // AFTER FIX: skips track, goes directly to consume loop

    // Simulate the auto-continue loop (lines 81-180 of query-flow.ts)
    const bufferBeforeRestore = session.getSteeringCount();
    const restoredCount = session.restoreInjectedSteering();
    const bufferAfterRestore = session.getSteeringCount();

    // Key assertion: no duplication
    expect(bufferBeforeRestore).toBe(3);
    expect(restoredCount).toBe(0); // Nothing was tracked via injected (text-only path)
    expect(bufferAfterRestore).toBe(3); // Still exactly 3

    // Consume and verify content
    const consumed = session.consumeSteering()!;
    expect(consumed).not.toBeNull();

    const lines = consumed.split("\n---\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("1");
    expect(lines[1]).toContain("2");
    expect(lines[2]).toContain("3");
  });

  test("BUG soma-uqb9: full runQueryFlow with mocked model must deliver exactly N messages", async () => {
    // Track what gets sent to Claude
    const queriesSentToClaude: string[] = [];
    let firstQueryResolve: (() => void) | null = null;

    // Mock sendMessageStreaming on the session
    // First call: simulates the initial query (takes time)
    // Second call: simulates the follow-up with steering messages
    let callCount = 0;
    const originalSendMessage = session.sendMessageStreaming.bind(session);
    session.sendMessageStreaming = mock(
      async (
        message: string,
        statusCallback: any,
        chatId?: number,
        modelContext?: any
      ) => {
        callCount++;
        queriesSentToClaude.push(message);

        if (callCount === 1) {
          // First query: simulate processing delay
          // During this time, steering messages will be added
          await new Promise<void>((resolve) => {
            firstQueryResolve = resolve;
          });
          // Call done callback
          await statusCallback("done", "", undefined, {
            model: "test",
            inputTokens: 100,
            outputTokens: 50,
          });
          return "First response (text-only, no tools)";
        }

        // Follow-up query: immediate response
        await statusCallback("done", "", undefined, {
          model: "test",
          inputTokens: 100,
          outputTokens: 50,
        });
        return "Follow-up response";
      }
    );

    // Start the query flow in background
    const { ctx: mainCtx, state: mainState } = createMockContext(
      "initial question",
      100
    );
    const queryPromise = runQueryFlow({
      ctx: mainCtx,
      session,
      message: "initial question",
      chatId: 456,
      userId: 1,
      username: "jihyuk",
      deliverInboundReaction: noopReaction,
    });

    // Wait a tick for the query to start
    await Bun.sleep(50);

    // Now session should be processing
    expect(session.isProcessing).toBe(true);

    // Send 3 steering messages while processing
    for (let i = 1; i <= 3; i++) {
      const { ctx: steeringCtx } = createMockContext(String(i), 200 + i);
      await handleSteeringGate({
        ctx: steeringCtx,
        session,
        message: String(i),
        wasInterrupt: false,
        chatId: 456,
        userId: 1,
        username: "jihyuk",
        deliverInboundReaction: noopReaction,
      });
    }

    expect(session.getSteeringCount()).toBe(3);

    // Let the first query complete
    firstQueryResolve!();

    // Wait for the full flow (including auto-continue) to finish
    await queryPromise;

    // ── KEY ASSERTIONS ──

    // Should have sent exactly 2 queries to Claude
    expect(queriesSentToClaude.length).toBe(2);

    // First query: the original message
    expect(queriesSentToClaude[0]).toContain("initial question");

    // Second query: the follow-up with steering messages
    const followUp = queriesSentToClaude[1];
    expect(followUp).toContain("이전 응답 중 보낸 메시지");

    // Count occurrences of each message in the follow-up
    // Each message "1", "2", "3" should appear EXACTLY ONCE
    const followUpStr = followUp!;
    const occurrences = followUpStr.split("\n---\n");

    // CRITICAL: Must be exactly 3 segments, not 6
    expect(occurrences.length).toBeLessThanOrEqual(4); // header + 3 messages at most

    // The follow-up should NOT contain duplicated content
    // Extract just the steering part after the header
    const steeringPart = followUpStr.split("지금 처리합니다]\n")[1] || followUpStr;
    const segments = steeringPart!.split("\n---\n").map((s: string) => s.trim());

    // Filter out empty segments
    const nonEmpty = segments.filter((s) => s.length > 0);

    // Should be exactly 3 unique messages, not 6
    expect(nonEmpty.length).toBe(3);

    // Check the system message showed correct count
    const steeringNotification = mainState.systemMessages.find(
      (m) => m.includes("대기 메시지") && m.includes("처리 중")
    );
    if (steeringNotification) {
      // Must say "3개" not "6개"
      expect(steeringNotification).toContain("3개");
      expect(steeringNotification).not.toContain("6개");
    }
  });

  test("steering gate correctly buffers messages when isProcessing=true", async () => {
    // Not processing → should NOT be gated
    const { ctx: ctx1 } = createMockContext("hello", 301);
    const handled1 = await handleSteeringGate({
      ctx: ctx1,
      session,
      message: "hello",
      wasInterrupt: false,
      chatId: 456,
      userId: 1,
      username: "jihyuk",
      deliverInboundReaction: noopReaction,
    });
    expect(handled1).toBe(false); // Not processing, not gated
    expect(session.getSteeringCount()).toBe(0);

    // Start processing
    const stop = session.startProcessing();

    // Now messages should be gated
    for (let i = 0; i < 5; i++) {
      const { ctx } = createMockContext(`msg${i}`, 400 + i);
      const handled = await handleSteeringGate({
        ctx,
        session,
        message: `msg${i}`,
        wasInterrupt: false,
        chatId: 456,
        userId: 1,
        username: "jihyuk",
        deliverInboundReaction: noopReaction,
      });
      expect(handled).toBe(true);
    }

    expect(session.getSteeringCount()).toBe(5);

    // Consume and verify all messages present, in order
    const consumed = session.consumeSteering()!;
    expect(consumed).toContain("msg0");
    expect(consumed).toContain("msg4");
    const lines = consumed.split("\n---\n");
    expect(lines).toHaveLength(5);

    stop();
  });

  test("steering buffer preserves message order under rapid fire", async () => {
    const stop = session.startProcessing();

    // Rapid-fire 20 messages
    for (let i = 0; i < 20; i++) {
      const { ctx } = createMockContext(`rapid-${i}`, 500 + i);
      await handleSteeringGate({
        ctx,
        session,
        message: `rapid-${i}`,
        wasInterrupt: false,
        chatId: 456,
        userId: 1,
        username: "jihyuk",
        deliverInboundReaction: noopReaction,
      });
    }

    expect(session.getSteeringCount()).toBe(20);

    const consumed = session.consumeSteering()!;
    const lines = consumed.split("\n---\n");
    expect(lines).toHaveLength(20);

    // Verify order preserved
    for (let i = 0; i < 20; i++) {
      expect(lines[i]).toContain(`rapid-${i}`);
    }

    stop();
  });
});
