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
import { createHash } from "crypto";
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
const NO_ACTOR_MESSAGE =
  "Permission denied: this group query has no bound Telegram user, and a group " +
  "chat is not an identity — approval must be answerable by exactly one person.";
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
const MAX_ACTION_HEADLINE_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_REASON_LENGTH = 200;
/** Floor for the shrink loop — below this a preview stops being readable. */
const MIN_INPUT_PREVIEW_LENGTH = 160;
/** Smallest slice worth showing of a single field's VALUE. */
const MIN_FIELD_VALUE_BUDGET = 120;
/** A key is a label, not a payload — and an unbounded one broke delivery. */
const MAX_FIELD_KEY_LENGTH = 60;
/** Hex chars of the sha256 identity shown for the full, unabridged input. */
const INPUT_DIGEST_LENGTH = 12;
const MAX_OMITTED_KEYS_LENGTH = 200;
/** Give up rather than loop forever if the fit search fails to converge. */
const MAX_FIT_ITERATIONS = 24;

/**
 * Fields that ARE the action, shown first — the model does not get to bury
 * `command` under its own prose. Anything unlisted sorts between these and the
 * narrative fields below.
 */
const ACTION_FIRST_FIELDS = [
  "command",
  "file_path",
  "notebook_path",
  "path",
  "url",
  "old_string",
  "new_string",
  "content",
  "pattern",
  "query",
  "prompt",
];

/** Model-authored narration: useful, but never a substitute for the action. */
const NARRATIVE_LAST_FIELDS = ["description", "explanation", "reason", "comment"];

/**
 * Tools whose streaming summary is the model's own narration, mapped to the
 * field that is actually the action.
 *
 * Verified against `formatToolStatus` (formatting.ts:566-760): `Bash` and
 * `Task` are the only branches that return `toolInput.description` — every
 * other tool summarises a real action field (`file_path`, `skill`, `url`, …).
 * Add an entry here whenever a new branch starts rendering narration.
 */
const ACTION_HEADLINE_FIELD: Record<string, string> = {
  Bash: "command",
  Task: "prompt",
};

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
  /**
   * Expected responder. Undefined is only survivable in a private chat, where
   * chat id === user id; in a group it means "nobody in particular" and denies.
   */
  userId?: number;
  threadId?: number;
  sessionKey: string;
  /** Session abort (stop/kill) — cancels pending prompts fail-closed. */
  abortSignal?: AbortSignal;
}

/**
 * The one place the "who may answer this?" question is decided.
 *
 * A private chat's id IS its user's id, so a cron/scheduler run that only
 * carries the owner's chat id still has an unambiguous responder. A group id
 * is not an identity: leaving the actor undefined there would authorize the
 * whole room, so it fails closed (undefined ⇒ deny) instead.
 */
function resolveActorUserId(binding: PermissionRequestBinding): number | undefined {
  if (binding.userId !== undefined) {
    return binding.userId;
  }
  return binding.chatId !== undefined && binding.chatId > 0
    ? binding.chatId
    : undefined;
}

export interface PermissionActor {
  userId: number;
  chatId: number;
  messageId?: number;
}

/** What the user actually authorized — kept so the receipt outlives the click. */
export interface ApprovedToolCall {
  toolName: string;
  /** sha256 prefix of the exact input the SDK will receive. */
  digest: string;
  /** The prompt body as it was shown, minus the now-stale pending footer. */
  body: string;
}

export type PermissionResolution =
  | { status: "resolved"; answer: PermissionAnswer; approved: ApprovedToolCall }
  /** No such live request: already answered, timed out, or fabricated id. */
  | { status: "unknown" }
  /** Wrong user or wrong chat. */
  | { status: "forbidden" }
  /** Right request, but clicked on a superseded message. */
  | { status: "stale" };

interface PendingPermissionRequest {
  chatId: number;
  /** Always resolved before a prompt is created — see `resolveActorUserId`. */
  userId: number;
  toolName: string;
  input: Record<string, unknown>;
  approved: ApprovedToolCall;
  messageId?: number;
  settle: (result: PermissionResult) => void;
  cleanup: () => void;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The exact bytes the approve button authorizes — the thing we digest. */
function canonicalInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input) ?? String(input);
  } catch {
    return String(input);
  }
}

function stringifyFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function fieldRank(key: string): number {
  const action = ACTION_FIRST_FIELDS.indexOf(key);
  if (action !== -1) {
    return action;
  }
  return NARRATIVE_LAST_FIELDS.includes(key) ? 2000 : 1000;
}

/**
 * Head **and tail**, never head-only.
 *
 * The approve button runs the whole value, so a head-only cut lets a malicious
 * suffix (`… && curl … | sh`) be approved unseen. The marker states exactly how
 * much is hidden, so an excerpt can never be mistaken for the whole input.
 */
function elideMiddle(value: string, budget: number): string {
  if (value.length <= budget) {
    return value;
  }
  const head = Math.max(1, Math.ceil(budget * 0.6));
  const tail = Math.max(1, budget - head);
  const hidden = value.length - head - tail;
  return (
    `${value.slice(0, head)}\n` +
    // "이 필드 값" — these are the field's own characters, a different unit
    // from the canonical-JSON total reported in the header line.
    `… ✂️ 중간 ${hidden}자 생략 (이 필드 값 전체 ${value.length}자) …\n` +
    `${value.slice(value.length - tail)}`
  );
}

interface InputPreview {
  /** Plain text, not yet HTML-escaped. */
  body: string;
  /** sha256 prefix of the FULL input, elided or not. */
  digest: string;
  /** Length of the full canonical (JSON) input, in characters. */
  totalLength: number;
  /** Some field is shown as an excerpt. */
  elided: boolean;
  /** Some field is not shown at all (named, never silently dropped). */
  omitted: boolean;
}

/**
 * Render the tool input field by field, action fields first.
 *
 * Budgeting is **greedy, not equal-share**: fields are served in priority
 * order and each takes as much of what is left as it needs, so a two-character
 * `description` no longer halves the `command` next to it. Keys are truncated
 * AND charged against the budget — an unbounded key used to escape the shrink
 * loop entirely and push the message past Telegram's 4096-char limit.
 *
 * Invariants: every field is either shown (whole or head+tail) or explicitly
 * named as omitted, and the digest always covers the full input — so what the
 * prompt does not show, it at least admits to not showing.
 */
function buildInputPreview(
  input: Record<string, unknown>,
  budget: number
): InputPreview {
  const canonical = canonicalInput(input);
  const digest = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, INPUT_DIGEST_LENGTH);
  const entries = Object.entries(input).sort(
    ([left], [right]) => fieldRank(left) - fieldRank(right)
  );

  if (entries.length === 0) {
    return {
      body: "(입력 없음)",
      digest,
      totalLength: canonical.length,
      elided: false,
      omitted: false,
    };
  }

  const lines: string[] = [];
  const omittedKeys: string[] = [];
  let remaining = budget;
  let elided = false;

  for (const [rawKey, value] of entries) {
    const label = `${truncate(rawKey, MAX_FIELD_KEY_LENGTH)}: `;
    const available = remaining - label.length;
    // Always show at least one field, however hostile its key; the rest are
    // named instead of shown once there is no room left to be honest in.
    if (available < MIN_FIELD_VALUE_BUDGET && lines.length > 0) {
      omittedKeys.push(truncate(rawKey, MAX_FIELD_KEY_LENGTH));
      continue;
    }
    const raw = stringifyFieldValue(value);
    const allowance = Math.max(MIN_FIELD_VALUE_BUDGET, available);
    const rendered = elideMiddle(raw, allowance);
    if (rendered !== raw) {
      elided = true;
    }
    lines.push(label + rendered);
    remaining -= label.length + Math.min(raw.length, allowance);
  }

  if (omittedKeys.length > 0) {
    const keys = truncate(omittedKeys.join(", "), MAX_OMITTED_KEYS_LENGTH);
    lines.push(`… ✂️ 그 외 필드 ${omittedKeys.length}개 미표시: ${keys}`);
  }

  return {
    body: lines.join("\n"),
    digest,
    totalLength: canonical.length,
    elided,
    omitted: omittedKeys.length > 0,
  };
}

/**
 * Headline for the prompt — always derived from the ACTION, never from the
 * model's narration.
 *
 * `formatToolStatus` renders `Bash` and `Task` from their `description`, so
 * "list the current directory" could headline a `chmod 777`, and "tidy up"
 * could headline an agent prompt that deletes a bucket. Those tools are
 * headlined by their action field instead (`ACTION_HEADLINE_FIELD`). For every
 * other tool the streaming summary is faithful, but it emits rich, *unbounded*
 * HTML — an AI-MCP call renders a whole `<code>{…config json…}</code>` dump.
 * Character-truncating that would land inside a tag and Telegram rejects the
 * entire message with 400 "Can't parse entities", so an over-long summary is
 * **degraded to a safe, minimal headline** rather than cut.
 */
function buildHeadline(toolName: string, input: Record<string, unknown>): string {
  const actionField = ACTION_HEADLINE_FIELD[toolName];
  if (actionField !== undefined) {
    const action = stringifyFieldValue(input[actionField] ?? "");
    if (action) {
      const emoji = toolName === "Bash" ? "▶️" : "🎯";
      return `${emoji} <code>${escapeHtml(truncate(action, MAX_ACTION_HEADLINE_LENGTH))}</code>`;
    }
  }
  const summary = formatToolStatus(toolName, input);
  if (summary.length <= MAX_HEADLINE_LENGTH) {
    return summary;
  }
  return `🔧 <code>${escapeHtml(truncate(toolName, MAX_TOOL_NAME_LENGTH))}</code>`;
}

interface BuiltPrompt {
  /** The message posted to Telegram. */
  text: string;
  /** The same content without the pending-state header/footer. */
  body: string;
  digest: string;
}

/**
 * Assemble the prompt.
 *
 * Ordering rule: prose is droppable, the input is not. If the message
 * overflows we drop the model's narration first, and only shrink the input
 * excerpt when there is no prose left to sacrifice — the opposite of the
 * original layering, where the input was the first thing to go and the user
 * could approve a command the prompt never showed.
 */
function buildPrompt(
  toolName: string,
  input: Record<string, unknown>,
  options: { title?: string; description?: string; decisionReason?: string }
): BuiltPrompt {
  const header = "🔐 <b>도구 권한 요청</b>";
  const footer = "무응답은 자동 거부됩니다.";

  // Model/SDK narration: labelled as such so it never reads as the action.
  const prose: string[] = [];
  if (options.title) {
    prose.push(`설명(SDK): ${escapeHtml(truncate(options.title, MAX_TITLE_LENGTH))}`);
  }
  if (options.description) {
    prose.push(
      `설명(모델): ${escapeHtml(truncate(options.description, MAX_DESCRIPTION_LENGTH))}`
    );
  }
  if (options.decisionReason) {
    prose.push(
      `사유: ${escapeHtml(truncate(options.decisionReason, MAX_REASON_LENGTH))}`
    );
  }

  const toolLine = `도구: <code>${escapeHtml(truncate(toolName, MAX_TOOL_NAME_LENGTH))}</code>`;
  const headline = buildHeadline(toolName, input);

  // Every section is atomic and individually bounded: assembly only ever drops
  // WHOLE sections, so the rendered HTML can never be cut mid-tag.
  const wrap = (body: string): string => [header, "", body, "", footer].join("\n");

  // Start by asking for the whole message: the preview is entitled to every
  // character the other sections do not use, rather than a fixed slice that
  // leaves ~3000 chars of a 3800-char message empty.
  let budget = MAX_PROMPT_LENGTH;
  const kept = [...prose];
  for (let attempt = 0; attempt < MAX_FIT_ITERATIONS; attempt++) {
    const preview = buildInputPreview(input, budget);
    const warnings: string[] = [];
    if (preview.elided) warnings.push("앞/뒤 발췌만 표시");
    if (preview.omitted) warnings.push("일부 필드 미표시");
    const digestLine =
      `입력 전체 ${preview.totalLength}자(JSON) · sha256:${preview.digest}` +
      (warnings.length > 0 ? ` · ⚠️ ${warnings.join(", ")}` : "");

    const escapedPreview = escapeHtml(preview.body);
    const body = [
      headline,
      toolLine,
      ...kept,
      digestLine,
      `<pre>${escapedPreview}</pre>`,
    ].join("\n");
    const text = wrap(body);

    if (text.length <= MAX_PROMPT_LENGTH) {
      return { text, body, digest: preview.digest };
    }
    // Narration goes first, one section at a time; the input excerpt only
    // shrinks once there is no prose left to sacrifice.
    if (kept.length > 0) {
      kept.pop();
      continue;
    }
    if (budget <= MIN_INPUT_PREVIEW_LENGTH) {
      // Floor reached: this is the most faithful prompt that can exist inside
      // Telegram's limit, and the digest still names the full input.
      return { text, body, digest: preview.digest };
    }
    // Shrink by exactly the overflow, translated from escaped characters back
    // into raw ones (HTML-escaping inflates `&` and `<` up to 5×). Converges
    // in one or two passes instead of halving blindly; `budget - 1` guarantees
    // progress so the loop always terminates.
    const overflow = text.length - MAX_PROMPT_LENGTH;
    const targetEscaped = Math.max(1, escapedPreview.length - overflow);
    const scaled = Math.floor(
      (budget * targetEscaped) / Math.max(1, escapedPreview.length)
    );
    budget = Math.max(MIN_INPUT_PREVIEW_LENGTH, Math.min(budget - 1, scaled));
  }

  // Unreachable in practice (each pass strictly shrinks), but a prompt that
  // cannot be rendered must still fail closed rather than throw.
  const preview = buildInputPreview(input, MIN_INPUT_PREVIEW_LENGTH);
  const body = [
    headline,
    toolLine,
    `입력 전체 ${preview.totalLength}자(JSON) · sha256:${preview.digest} · ⚠️ 발췌`,
    `<pre>${escapeHtml(preview.body)}</pre>`,
  ].join("\n");
  return { text: wrap(body), body, digest: preview.digest };
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

      const actorUserId = resolveActorUserId(binding);
      if (actorUserId === undefined) {
        console.warn(
          `[PERMISSION] No actor bound for group chat ${binding.chatId} (${binding.sessionKey}), denying ${toolName}`
        );
        return { behavior: "deny", message: NO_ACTOR_MESSAGE };
      }

      const sender = this.sendPrompt;
      if (!sender) {
        console.warn(`[PERMISSION] No prompt sender bound, denying ${toolName}`);
        return { behavior: "deny", message: NO_SENDER_MESSAGE };
      }

      return this.ask(
        binding,
        binding.chatId,
        actorUserId,
        sender,
        toolName,
        input,
        options
      );
    };
  }

  private async ask(
    binding: PermissionRequestBinding,
    chatId: number,
    actorUserId: number,
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

    const prompt = buildPrompt(toolName, input, options);

    this.pending.set(requestId, {
      chatId,
      userId: actorUserId,
      toolName,
      input,
      approved: { toolName, digest: prompt.digest, body: prompt.body },
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

    const outbound: PermissionPrompt = {
      requestId,
      chatId,
      threadId: binding.threadId,
      text: prompt.text,
      approveData: `${PERMISSION_CALLBACK_PREFIX}${requestId}:a`,
      denyData: `${PERMISSION_CALLBACK_PREFIX}${requestId}:d`,
    };

    console.log(
      `[PERMISSION] Asking user ${actorUserId} in chat ${chatId} for ${toolName} ` +
        `(request ${requestId}, input sha256:${prompt.digest}, session ${binding.sessionKey})`
    );

    try {
      const messageId = await sender(outbound);
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
    if (entry.userId !== actor.userId) {
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
      `[PERMISSION] User ${actor.userId} ${decision} ${entry.toolName} ` +
        `(request ${requestId}, input sha256:${entry.approved.digest})`
    );
    return { status: "resolved", answer, approved: entry.approved };
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
