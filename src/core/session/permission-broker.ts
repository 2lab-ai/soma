/**
 * Telegram permission broker — answers the Agent SDK's `canUseTool` prompt
 * from a Telegram inline keyboard (GitHub issue #79).
 *
 * Why this exists: the runtime runs with `permissionMode: "bypassPermissions"`,
 * which keeps ordinary tool calls autonomous, but the SDK still routes the
 * *exceptional* cases (explicit ask rules, org-ask connectors, critical-path
 * rm/rmdir, `requiresUserInteraction` tools) to `canUseTool`. The runtime had
 * no `canUseTool` at all, so those prompts rendered a permission screen nobody
 * could reach from a phone and the turn stalled.
 *
 * Layering (first match wins, top to bottom):
 *   1. PreToolUse hook hard-denies (query-runtime.ts) — runs before this.
 *   2. `checkToolInputSafety` re-check here — a hard deny is never a question.
 *   3. Native AskUserQuestion → redirected to the `user_choice` JSON flow.
 *   4. Everything else → Telegram approve/deny round trip.
 *
 * Every failure mode (timeout, abort, wrong actor, undeliverable prompt,
 * shutdown) denies. The query must never hang on a prompt nobody can answer.
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { escapeHtml, formatToolStatus } from "../../formatting";
import { checkToolInputSafety } from "./query-runtime";

/** Callback-data prefix routed by `handlePermissionCallback`. */
export const PERMISSION_CALLBACK_PREFIX = "perm:";

/** How long an unanswered prompt stays live before failing closed. */
export const DEFAULT_PERMISSION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * The structured-choice flow (UI_ASKUSER_INSTRUCTIONS) is authoritative for
 * asking the user a question: it renders real labelled buttons. Collapsing a
 * native AskUserQuestion into a generic Approve/Deny keyboard would destroy
 * that UX, so redirect the model instead.
 */
const ASK_USER_QUESTION_TOOL = "AskUserQuestion";
const ASK_USER_QUESTION_REDIRECT =
  "AskUserQuestion is not available on this Telegram bridge. Ask the user by " +
  'emitting the user_choice JSON block instead (```json {"type":"user_choice",' +
  ' "question":"...", "choices":[{"id":"a","label":"..."}]} ```) — it renders ' +
  "as a real Telegram keyboard.";

const NO_CHAT_MESSAGE =
  "Permission denied: this session has no Telegram chat to ask for approval.";
const NO_SENDER_MESSAGE =
  "Permission denied: the Telegram bot is not accepting permission prompts right now.";
const SEND_FAILED_MESSAGE =
  "Permission denied: the approval prompt could not be delivered to Telegram.";
const TIMEOUT_MESSAGE =
  "Permission denied: the approval request timed out with no answer in Telegram.";
const ABORTED_MESSAGE =
  "Permission denied: the query was stopped while waiting for approval.";
const USER_DENIED_MESSAGE = "The user denied this tool use in Telegram.";

// Telegram caps a message at 4096 chars; stay well under it and bound every
// untrusted component *before* HTML-escaping (escaping after truncation can
// never split an entity).
const MAX_PROMPT_LENGTH = 3800;
const MAX_TITLE_LENGTH = 300;
const MAX_HEADLINE_LENGTH = 600;
const MAX_TOOL_NAME_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_REASON_LENGTH = 200;
const MAX_INPUT_PREVIEW_LENGTH = 700;

export type PermissionAnswer = "allow" | "deny";

/** What the broker hands to the Telegram transport. */
export interface PermissionPrompt {
  requestId: string;
  chatId: number;
  threadId?: number;
  /** HTML-formatted (already escaped) prompt body. */
  text: string;
  approveData: string;
  denyData: string;
}

/** Sends a prompt and returns the Telegram message id, when known. */
export type PermissionPromptSender = (
  prompt: PermissionPrompt
) => Promise<number | undefined>;

/** Identity a pending prompt is bound to — an answer must match all of it. */
export interface PermissionRequestBinding {
  /** Chat the prompt is posted to. Undefined (e.g. no chat routed) = deny. */
  chatId?: number;
  /** Expected responder. Undefined = chat-level authorization only. */
  userId?: number;
  threadId?: number;
  sessionKey: string;
  /** Session abort (stop/kill) — cancels pending prompts fail-closed. */
  abortSignal?: AbortSignal;
}

export interface PermissionActor {
  userId: number;
  chatId: number;
  messageId?: number;
}

export type PermissionResolution =
  | { status: "resolved"; answer: PermissionAnswer }
  /** No such live request: already answered, timed out, or fabricated id. */
  | { status: "unknown" }
  /** Wrong user or wrong chat. */
  | { status: "forbidden" }
  /** Right request, but clicked on a superseded message. */
  | { status: "stale" };

interface PendingPermissionRequest {
  chatId: number;
  userId?: number;
  toolName: string;
  input: Record<string, unknown>;
  messageId?: number;
  settle: (result: PermissionResult) => void;
  cleanup: () => void;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function previewInput(input: Record<string, unknown>): string {
  try {
    return truncate(JSON.stringify(input, null, 2) ?? "", MAX_INPUT_PREVIEW_LENGTH);
  } catch {
    return "";
  }
}

/**
 * Headline for the prompt: the SDK's own sentence when it has one, otherwise
 * the tool summary Telegram already shows during streaming.
 *
 * `formatToolStatus` emits rich, *unbounded* HTML — an AI-MCP call renders a
 * whole `<code>{…config json…}</code>` dump. Character-truncating that would
 * land inside a tag and Telegram rejects the entire message with 400 "Can't
 * parse entities", so an over-long summary is **degraded to a safe, minimal
 * headline** rather than cut.
 */
function buildHeadline(
  toolName: string,
  input: Record<string, unknown>,
  title: string | undefined
): string {
  if (title) {
    return escapeHtml(truncate(title, MAX_TITLE_LENGTH));
  }
  const summary = formatToolStatus(toolName, input);
  if (summary.length <= MAX_HEADLINE_LENGTH) {
    return summary;
  }
  return `🔧 <code>${escapeHtml(truncate(toolName, MAX_TOOL_NAME_LENGTH))}</code>`;
}

function buildPromptText(
  toolName: string,
  input: Record<string, unknown>,
  options: { title?: string; description?: string; decisionReason?: string }
): string {
  // Every section is atomic and individually bounded: assembly only ever
  // drops WHOLE sections, so the rendered HTML can never be cut mid-tag.
  const required = [
    "🔐 <b>도구 권한 요청</b>",
    "",
    buildHeadline(toolName, input, options.title),
    `도구: <code>${escapeHtml(truncate(toolName, MAX_TOOL_NAME_LENGTH))}</code>`,
  ];
  const footer = ["", "무응답은 자동 거부됩니다."];

  // Optional context, dropped from the end (cheapest first) if we overflow.
  const optional: string[] = [];
  if (options.description) {
    optional.push(escapeHtml(truncate(options.description, MAX_DESCRIPTION_LENGTH)));
  }
  if (options.decisionReason) {
    optional.push(
      `사유: ${escapeHtml(truncate(options.decisionReason, MAX_REASON_LENGTH))}`
    );
  }
  const preview = previewInput(input);
  if (preview) {
    optional.push(`<pre>${escapeHtml(preview)}</pre>`);
  }

  const render = (sections: string[]): string =>
    [...required, ...sections, ...footer].join("\n");

  const kept = [...optional];
  let text = render(kept);
  while (text.length > MAX_PROMPT_LENGTH && kept.length > 0) {
    kept.pop();
    text = render(kept);
  }
  return text;
}

export class TelegramPermissionBroker {
  private readonly pending = new Map<string, PendingPermissionRequest>();
  private readonly timeoutMs: number;
  private readonly makeRequestId: () => string;
  private sendPrompt: PermissionPromptSender | null;
  private counter = 0;

  constructor(options?: {
    sendPrompt?: PermissionPromptSender;
    timeoutMs?: number;
    createRequestId?: () => string;
  }) {
    this.sendPrompt = options?.sendPrompt ?? null;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
    this.makeRequestId =
      options?.createRequestId ??
      (() => {
        this.counter = (this.counter + 1) % 1_000_000;
        // Short + opaque: `perm:<id>:a` must fit Telegram's 64-byte callback data.
        return `${this.counter.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      });
  }

  /**
   * Allocate a request id that is not already live.
   *
   * A repeat would silently replace the live entry in the pending map and
   * strand the query waiting on it, so retry the factory and, if it is
   * deterministic (or we are astronomically unlucky), disambiguate with a
   * suffix. Ids stay short — `perm:<id>:a` must fit 64 callback-data bytes.
   */
  private allocateRequestId(): string {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = this.makeRequestId();
      if (!this.pending.has(candidate)) {
        return candidate;
      }
    }
    const base = this.makeRequestId().slice(0, 16);
    let suffix = 1;
    while (this.pending.has(`${base}~${suffix}`)) {
      suffix++;
    }
    console.warn(`[PERMISSION] Request id collision on "${base}" — disambiguating`);
    return `${base}~${suffix}`;
  }

  /** Bind (or unbind) the live Telegram transport. */
  setPromptSender(sender: PermissionPromptSender | null): void {
    this.sendPrompt = sender;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Build the SDK `canUseTool` callback for one query, bound to the chat/user
   * that started it (never a process-global chat id — concurrent sessions
   * would race).
   */
  createCanUseTool(binding: PermissionRequestBinding): CanUseTool {
    return async (toolName, input, options): Promise<PermissionResult> => {
      if (toolName === ASK_USER_QUESTION_TOOL) {
        return { behavior: "deny", message: ASK_USER_QUESTION_REDIRECT };
      }

      // Hard denies stay authoritative — never negotiable by a button.
      const safety = checkToolInputSafety(toolName, input);
      if (!safety.allowed) {
        console.warn(`[PERMISSION] Hard-denied ${toolName}: ${safety.reason}`);
        return { behavior: "deny", message: safety.reason };
      }

      if (binding.chatId === undefined) {
        console.warn(
          `[PERMISSION] No chat bound for ${binding.sessionKey}, denying ${toolName}`
        );
        return { behavior: "deny", message: NO_CHAT_MESSAGE };
      }

      const sender = this.sendPrompt;
      if (!sender) {
        console.warn(`[PERMISSION] No prompt sender bound, denying ${toolName}`);
        return { behavior: "deny", message: NO_SENDER_MESSAGE };
      }

      return this.ask(binding, binding.chatId, sender, toolName, input, options);
    };
  }

  private async ask(
    binding: PermissionRequestBinding,
    chatId: number,
    sender: PermissionPromptSender,
    toolName: string,
    input: Record<string, unknown>,
    options: Parameters<CanUseTool>[2]
  ): Promise<PermissionResult> {
    const requestId = this.allocateRequestId();

    let resolveResult!: (result: PermissionResult) => void;
    const answered = new Promise<PermissionResult>((resolve) => {
      resolveResult = resolve;
    });

    const timer = setTimeout(() => {
      console.warn(`[PERMISSION] Request ${requestId} timed out — denying`);
      this.settle(requestId, { behavior: "deny", message: TIMEOUT_MESSAGE });
    }, this.timeoutMs);
    timer.unref?.();

    const onAbort = (): void => {
      this.settle(requestId, { behavior: "deny", message: ABORTED_MESSAGE });
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    binding.abortSignal?.addEventListener("abort", onAbort, { once: true });

    this.pending.set(requestId, {
      chatId,
      userId: binding.userId,
      toolName,
      input,
      // Settled at most once: `settle()` deletes the entry from `pending`
      // before invoking this, and every settlement path goes through it.
      settle: resolveResult,
      cleanup: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        binding.abortSignal?.removeEventListener("abort", onAbort);
      },
    });

    if (options.signal?.aborted || binding.abortSignal?.aborted) {
      onAbort();
      return answered;
    }

    const prompt: PermissionPrompt = {
      requestId,
      chatId,
      threadId: binding.threadId,
      text: buildPromptText(toolName, input, options),
      approveData: `${PERMISSION_CALLBACK_PREFIX}${requestId}:a`,
      denyData: `${PERMISSION_CALLBACK_PREFIX}${requestId}:d`,
    };

    console.log(
      `[PERMISSION] Asking chat ${chatId} for ${toolName} (request ${requestId}, session ${binding.sessionKey})`
    );

    try {
      const messageId = await sender(prompt);
      // The request may already have been settled (abort/timeout) while the
      // send was in flight — only bind the message id if it is still live.
      const live = this.pending.get(requestId);
      if (live) {
        live.messageId = messageId;
      }
    } catch (error) {
      console.error(`[PERMISSION] Failed to deliver prompt ${requestId}:`, error);
      this.settle(requestId, { behavior: "deny", message: SEND_FAILED_MESSAGE });
    }

    return answered;
  }

  /**
   * Claim and settle a pending request. Synchronous and atomic: the entry is
   * removed before anything awaits, so a double tap cannot answer twice and a
   * mismatched click can never settle a different request.
   */
  resolve(
    requestId: string,
    answer: PermissionAnswer,
    actor: PermissionActor
  ): PermissionResolution {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return { status: "unknown" };
    }
    if (entry.chatId !== actor.chatId) {
      return { status: "forbidden" };
    }
    if (entry.userId !== undefined && entry.userId !== actor.userId) {
      return { status: "forbidden" };
    }
    // Once a prompt is bound to a message, the answer must come from THAT
    // message — including when the click carries no message id at all (an
    // update grammY could not attach to a message). Accepting `undefined`
    // here would let such a click bypass the binding entirely.
    if (entry.messageId !== undefined && actor.messageId !== entry.messageId) {
      return { status: "stale" };
    }

    const result: PermissionResult =
      answer === "allow"
        ? { behavior: "allow", updatedInput: entry.input }
        : { behavior: "deny", message: USER_DENIED_MESSAGE };

    this.settle(requestId, result);
    const decision = answer === "allow" ? "approved" : "denied";
    console.log(
      `[PERMISSION] User ${actor.userId} ${decision} ${entry.toolName} (request ${requestId})`
    );
    return { status: "resolved", answer };
  }

  /** Deny every live prompt (shutdown). Returns how many were cancelled. */
  cancelAll(reason: string): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) {
      this.settle(id, {
        behavior: "deny",
        message: `Permission denied: ${reason}.`,
      });
    }
    return ids.length;
  }

  private settle(requestId: string, result: PermissionResult): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) {
      return false;
    }
    this.pending.delete(requestId);
    entry.cleanup();
    entry.settle(result);
    return true;
  }
}

/** Minimal slice of the grammY Api the prompt transport needs. */
export interface TelegramPromptApi {
  sendMessage(
    chatId: number,
    text: string,
    other?: Record<string, unknown>
  ): Promise<{ message_id: number }>;
}

export function createTelegramPromptSender(
  api: TelegramPromptApi
): PermissionPromptSender {
  return async (prompt) => {
    const other: Record<string, unknown> = {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ 승인", callback_data: prompt.approveData },
            { text: "🚫 거부", callback_data: prompt.denyData },
          ],
        ],
      },
    };
    if (prompt.threadId !== undefined) {
      other.message_thread_id = prompt.threadId;
    }
    const sent = await api.sendMessage(prompt.chatId, prompt.text, other);
    return sent.message_id;
  };
}

/** Process-wide broker: sessions produce prompts, the callback handler answers. */
export const permissionBroker = new TelegramPermissionBroker();
