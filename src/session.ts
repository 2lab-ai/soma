import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "fs";
import type { Context } from "grammy";
import {
  ALLOWED_PATHS,
  CHAT_HISTORY_ACCESS_INFO,
  DEFAULT_THINKING_TOKENS,
  MCP_SERVERS,
  SAFETY_PROMPT,
  SESSION_FILE,
  STREAMING_THROTTLE_MS,
  TEMP_PATHS,
  THINKING_DEEP_KEYWORDS,
  THINKING_KEYWORDS,
  UI_ASKUSER_INSTRUCTIONS,
  WORKING_DIR,
} from "./config";
import { getModelForContext, getReasoningTokens, type ConfigContext } from "./model-config";
import { formatToolStatus } from "./formatting";
import { processQueuedJobs } from "./scheduler";
import { checkCommandSafety, isPathAllowed } from "./security";
import { createSteeringMessage } from "./types";
import type { QueryMetadata, SessionData, StatusCallback, SteeringMessage, TokenUsage, UsageSnapshot } from "./types";
import { fetchClaudeUsage } from "./usage";
import type {
  ChoiceState,
  DirectInputState,
  ParseTextChoiceState,
} from "./types/user-choice";
import { isAbortError } from "./utils/error-classification";
import type { ChatCaptureService } from "./services/chat-capture-service";

export type ActivityState = "idle" | "working" | "waiting";
export type QueryState = "idle" | "preparing" | "running" | "aborting";

type ContextWindowUsage = NonNullable<SessionData["contextWindowUsage"]>;

function getThinkingLevel(message: string): number {
  const msgLower = message.toLowerCase();
  if (THINKING_DEEP_KEYWORDS.some((k) => msgLower.includes(k))) return 50000;
  if (THINKING_KEYWORDS.some((k) => msgLower.includes(k))) return 10000;
  return DEFAULT_THINKING_TOKENS;
}

interface ClaudeCodeContextWindow {
  current_usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
  context_window_size?: number;
}

function mergeLatestUsage(
  prev: TokenUsage | null,
  update: Partial<TokenUsage>
): TokenUsage {
  function pick(updateVal: number | undefined, prevVal: number): number {
    return typeof updateVal === "number" && updateVal > 0 ? updateVal : prevVal;
  }

  const base = prev ?? {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  return {
    input_tokens: pick(update.input_tokens, base.input_tokens),
    output_tokens:
      typeof update.output_tokens === "number"
        ? update.output_tokens
        : base.output_tokens,
    cache_read_input_tokens: pick(
      update.cache_read_input_tokens,
      base.cache_read_input_tokens ?? 0
    ),
    cache_creation_input_tokens: pick(
      update.cache_creation_input_tokens,
      base.cache_creation_input_tokens ?? 0
    ),
  };
}

async function captureUsageSnapshot(): Promise<UsageSnapshot | null> {
  try {
    const usage = await fetchClaudeUsage(0); // bypass cache
    if (!usage) return null;
    return {
      fiveHour: usage.five_hour ? Math.round(usage.five_hour.utilization * 10) / 10 : 0,
      sevenDay: usage.seven_day ? Math.round(usage.seven_day.utilization) : 0,
    };
  } catch {
    return null;
  }
}

function isClaudeCodeContextWindow(value: unknown): value is ClaudeCodeContextWindow {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const cu = v.current_usage;
  if (cu !== undefined && cu !== null && typeof cu !== "object") return false;
  const cws = v.context_window_size;
  if (cws !== undefined && typeof cws !== "number") return false;
  return true;
}

function getClaudeProjectsDir(): string | null {
  return process.env.HOME ? `${process.env.HOME}/.claude/projects` : null;
}

function getClaudeProjectSlug(workingDir: string): string {
  return workingDir.replace(/[^A-Za-z0-9]/g, "-");
}

function readFileTail(path: string, maxBytes: number): string | null {
  try {
    const stats = statSync(path);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;

    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const read = readSync(fd, buffer, 0, length, start);
      if (read <= 0) return null;
      return buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function extractMainAssistantContextUsageFromTranscriptLine(
  line: string,
  sessionId: string,
  minTimestampMs: number
): ContextWindowUsage | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object") return null;
    const rec = parsed as Record<string, unknown>;

    if (rec.type !== "assistant") return null;
    if (rec.sessionId !== sessionId) return null;
    if ("isSidechain" in rec && rec.isSidechain !== false) return null;

    const timestampStr = typeof rec.timestamp === "string" ? rec.timestamp : null;
    if (timestampStr) {
      const ts = Date.parse(timestampStr);
      if (!Number.isNaN(ts) && ts < minTimestampMs) return null;
    }

    const msg = rec.message;
    if (!msg || typeof msg !== "object") return null;
    const usage = (msg as Record<string, unknown>).usage;
    if (!usage || typeof usage !== "object") return null;

    const u = usage as Record<string, unknown>;
    const input_tokens = typeof u.input_tokens === "number" ? u.input_tokens : 0;
    const cache_creation_input_tokens =
      typeof u.cache_creation_input_tokens === "number"
        ? u.cache_creation_input_tokens
        : 0;
    const cache_read_input_tokens =
      typeof u.cache_read_input_tokens === "number" ? u.cache_read_input_tokens : 0;

    const used = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
    if (used <= 0) return null;

    return { input_tokens, cache_creation_input_tokens, cache_read_input_tokens };
  } catch {
    return null;
  }
}

export class ClaudeSession {
  readonly sessionKey: string;
  readonly workingDir: string;
  readonly chatCaptureService: ChatCaptureService | null = null;

  sessionId: string | null = null;
  lastActivity: Date | null = null;
  queryStarted: Date | null = null;
  currentTool: string | null = null;
  lastTool: string | null = null;
  lastError: string | null = null;
  lastErrorTime: Date | null = null;
  lastUsage: TokenUsage | null = null;
  lastMessage: string | null = null;

  // Context window from Claude Code (claude-dashboard style)
  contextWindowUsage: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  } | null = null;
  contextWindowSize = 200_000;

  // Cumulative token tracking
  sessionStartTime: Date | null = null;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  totalCacheReadTokens = 0;
  totalCacheCreateTokens = 0;
  totalQueries = 0;

  constructor(sessionKey = "default", chatCaptureService: ChatCaptureService | null = null) {
    this.sessionKey = sessionKey;
    this.workingDir = WORKING_DIR;
    this.chatCaptureService = chatCaptureService;
  }

  contextLimitWarned = false;
  warned70 = false;
  warned85 = false;
  warned95 = false;
  recentlyRestored = false;
  messagesSinceRestore = 0;

  private abortController: AbortController | null = null;
  private _queryState: QueryState = "idle";
  private stopRequested = false;
  private _wasInterruptedByNewMessage = false;
  private _isInterrupting = false;
  private readonly MAX_STEERING_MESSAGES = 20;
  private steeringBuffer: SteeringMessage[] = [];

  choiceState: ChoiceState | null = null;
  pendingDirectInput: DirectInputState | null = null;
  parseTextChoiceState: ParseTextChoiceState | null = null;
  private _activityState: ActivityState = "idle";

  private readonly preToolUseHook = async (
    input: unknown,
    _toolUseId: unknown,
    _context: unknown
  ): Promise<Record<string, unknown>> => {
    const toolName = (input as { tool_name?: string }).tool_name || "unknown";
    console.log(`[HOOK] PreToolUse fired for: ${toolName}`);

    const steering = this.consumeSteering();
    if (!steering) {
      return {};
    }

    console.log(
      `[STEERING] Injecting ${steering.split("\n---\n").length} message(s) before ${toolName}`
    );
    return {
      systemMessage: `[USER SENT MESSAGE DURING EXECUTION]\n${steering}\n[END USER MESSAGE]`,
    };
  };

  get activityState(): ActivityState {
    return this._activityState;
  }

  setActivityState(state: ActivityState): void {
    console.log(`[ACTIVITY] ${this._activityState} → ${state}`);
    this._activityState = state;
  }

  private getTranscriptJsonlPath(): string | null {
    if (!this.sessionId) return null;
    const projectsDir = getClaudeProjectsDir();
    if (!projectsDir) return null;
    const slug = getClaudeProjectSlug(this.workingDir);
    return `${projectsDir}/${slug}/${this.sessionId}.jsonl`;
  }

  private tryGetLatestMainAssistantContextUsageFromTranscript(
    minTimestampMs: number
  ): ContextWindowUsage | null {
    if (!this.sessionId) return null;

    const transcriptPath = this.getTranscriptJsonlPath();
    if (!transcriptPath || !existsSync(transcriptPath)) return null;

    const tail = readFileTail(transcriptPath, 1024 * 1024);
    if (!tail) return null;

    const lines = tail.trimEnd().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;

      const usage = extractMainAssistantContextUsageFromTranscriptLine(
        line,
        this.sessionId,
        minTimestampMs
      );
      if (usage) return usage;
    }
    return null;
  }

  private async refreshContextWindowUsageFromTranscript(
    minTimestampMs: number
  ): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const usage =
        this.tryGetLatestMainAssistantContextUsageFromTranscript(minTimestampMs);
      if (usage) {
        this.contextWindowUsage = usage;
        return true;
      }
      if (attempt < 2) await Bun.sleep(50);
    }
    return false;
  }

  get isActive(): boolean {
    return this.sessionId !== null;
  }

  get isRunning(): boolean {
    return this._queryState !== "idle";
  }

  get queryState(): QueryState {
    return this._queryState;
  }

  get currentContextTokens(): number {
    return (
      this.getContextTokensFromSnapshot() ?? this.getContextTokensFromCumulatives()
    );
  }

  private getContextTokensFromSnapshot(): number | null {
    if (!this.contextWindowUsage) return null;
    const {
      input_tokens = 0,
      cache_creation_input_tokens = 0,
      cache_read_input_tokens = 0,
    } = this.contextWindowUsage;
    const total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
    return total > 0 ? total : null;
  }

  private getContextTokensFromCumulatives(): number {
    return this.totalInputTokens + this.totalCacheCreateTokens;
  }

  get needsSave(): boolean {
    return this.contextLimitWarned && !this.recentlyRestored;
  }

  get needsWarning70(): boolean {
    return this.warned70 && !this.recentlyRestored;
  }

  get needsWarning85(): boolean {
    return this.warned85 && !this.recentlyRestored;
  }

  get needsWarning95(): boolean {
    return this.warned95 && !this.recentlyRestored;
  }

  get isProcessing(): boolean {
    return this._queryState === "preparing" || this._queryState === "running";
  }

  consumeInterruptFlag(): boolean {
    const was = this._wasInterruptedByNewMessage;
    this._wasInterruptedByNewMessage = false;
    if (was) this.stopRequested = false;
    return was;
  }

  markInterrupt(): void {
    this._wasInterruptedByNewMessage = true;
  }

  clearStopRequested(): void {
    this.stopRequested = false;
  }

  get isInterrupting(): boolean {
    return this._isInterrupting;
  }

  startInterrupt(): boolean {
    if (this._isInterrupting) {
      console.log("[INTERRUPT] Already interrupting, ignoring duplicate");
      return false;
    }
    this._isInterrupting = true;
    return true;
  }

  endInterrupt(): void {
    this._isInterrupting = false;
  }

  clearWarning70(): void {
    this.warned70 = false;
  }
  clearWarning85(): void {
    this.warned85 = false;
  }
  clearWarning95(): void {
    this.warned95 = false;
  }
  clearChoiceState(): void {
    this.choiceState = null;
  }
  clearDirectInput(): void {
    this.pendingDirectInput = null;
  }
  clearParseTextChoice(): void {
    this.parseTextChoiceState = null;
  }

  addSteering(
    message: string,
    messageId: number,
    receivedDuringTool?: string
  ): boolean {
    let evicted = false;
    if (this.steeringBuffer.length >= this.MAX_STEERING_MESSAGES) {
      console.warn("[STEERING] Buffer full, evicting oldest message");
      this.steeringBuffer.shift();
      evicted = true;
    }
    // Use factory function for validation and creation
    const steeringMessage = createSteeringMessage(
      message,
      messageId,
      receivedDuringTool
    );
    this.steeringBuffer.push(steeringMessage);
    return evicted;
  }

  consumeSteering(): string | null {
    if (!this.steeringBuffer.length) return null;
    const formatted = this.steeringBuffer
      .map((msg) => {
        const ts = new Date(msg.timestamp).toLocaleTimeString("en-US", {
          hour12: false,
        });
        const tool = msg.receivedDuringTool
          ? ` (during ${msg.receivedDuringTool})`
          : "";
        return `[${ts}${tool}] ${msg.content}`;
      })
      .join("\n---\n");
    this.steeringBuffer = [];
    return formatted;
  }

  hasSteeringMessages(): boolean {
    return this.steeringBuffer.length > 0;
  }

  startProcessing(): () => void {
    this._queryState = "preparing";
    return () => {
      this._queryState = "idle";
      // Don't clear steering - keep for next query if not consumed
      // (PreToolUse only fires when tools are used, so steering can be missed)
      if (this.steeringBuffer.length) {
        console.log(
          `[STEERING] Keeping ${this.steeringBuffer.length} unconsumed messages for next query`
        );
      }
    };
  }

  getPendingSteering(): string | null {
    // Alias for consumeSteering - identical functionality
    return this.consumeSteering();
  }

  async stop(): Promise<"stopped" | "pending" | false> {
    if (this._queryState === "running" && this.abortController) {
      this.stopRequested = true;
      this._queryState = "aborting";
      this.abortController.abort();
      console.log("Stop requested - aborting current query");

      // Wait for query to actually stop (max 5s)
      const start = Date.now();
      while (this.queryState !== "idle" && Date.now() - start < 5000) {
        await Bun.sleep(50);
      }

      if (this.queryState === "idle") {
        console.log("Stop completed - query stopped");
      } else {
        console.warn("Stop timeout - query still running after 5s");
      }

      return "stopped";
    }

    if (this._queryState === "preparing") {
      this.stopRequested = true;
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  async sendMessageStreaming(
    message: string,
    username: string,
    userId: number,
    statusCallback: StatusCallback,
    chatId?: number,
    ctx?: Context,
    modelContext: ConfigContext = "general"
  ): Promise<string> {
    if (chatId) process.env.TELEGRAM_CHAT_ID = String(chatId);

    const isNewSession = !this.isActive;
    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ??
      String(thinkingTokens);

    let messageToSend = message;

    // Prepend any unconsumed steering from previous query
    const pendingSteering = this.getPendingSteering();
    if (pendingSteering) {
      console.log(
        `[STEERING] Prepending ${pendingSteering.split("\n---\n").length} pending messages to query`
      );
      messageToSend = `[MESSAGES SENT DURING PREVIOUS EXECUTION - user sent these while you were working]\n${pendingSteering}\n[END PREVIOUS MESSAGES]\n\n[NEW MESSAGE]\n${messageToSend}`;
    }

    if (isNewSession) {
      const now = new Date();
      const datePrefix = `[Current date/time: ${now.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
      })}]\n\n`;
      messageToSend = datePrefix + messageToSend;
    }

    const options: Options = {
      model: getModelForContext(modelContext),
      cwd: WORKING_DIR,
      settingSources: ["user", "project"],
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      // Needed to observe per-API-call usage (message_start/message_delta) for accurate context usage.
      includePartialMessages: true,
      systemPrompt: `${SAFETY_PROMPT}\n\n${UI_ASKUSER_INSTRUCTIONS}\n\n${CHAT_HISTORY_ACCESS_INFO}`,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resume: this.sessionId || undefined,
      hooks: {
        PreToolUse: [
          {
            hooks: [this.preToolUseHook],
          },
        ],
      },
    };

    if (process.env.CLAUDE_CODE_PATH) {
      options.pathToClaudeCodeExecutable = process.env.CLAUDE_CODE_PATH;
    }

    if (this.sessionId && !isNewSession) {
      console.log(
        `RESUMING session ${this.sessionId.slice(0, 8)}... (thinking=${thinkingLabel})`
      );
    } else {
      console.log(`STARTING new Claude session (thinking=${thinkingLabel})`);
      this.sessionId = null;
    }

    if (this.stopRequested) {
      console.log("Query cancelled before starting");
      this.stopRequested = false;
      throw new Error("Query cancelled");
    }

    this.abortController = new AbortController();
    this._queryState = "running";
    this.setActivityState("working");
    this.stopRequested = false;
    this.queryStarted = new Date();
    const queryStartedMs = this.queryStarted.getTime();
    this.currentTool = null;

    const responseParts: string[] = [];
    let currentSegmentId = 0;
    let currentSegmentText = "";
    let lastTextUpdate = 0;
    let queryCompleted = false;
    let lastCallUsage: TokenUsage | null = null;

    // Context usage before query
    const contextUsagePercentBefore = this.contextWindowUsage
      ? (this.currentContextTokens / this.contextWindowSize) * 100
      : undefined;

    // Tool timing tracking
    let currentToolStart: { name: string; startMs: number } | null = null;
    const toolDurations: Record<string, { count: number; totalMs: number }> = {};
    const closeCurrentTool = () => {
      if (currentToolStart) {
        const duration = Date.now() - currentToolStart.startMs;
        const existing = toolDurations[currentToolStart.name] || { count: 0, totalMs: 0 };
        toolDurations[currentToolStart.name] = {
          count: existing.count + 1,
          totalMs: existing.totalMs + duration,
        };
        currentToolStart = null;
      }
    };

    // Usage before/after tracking
    let usageBefore: UsageSnapshot | null = null;
    let usageAfter: UsageSnapshot | null = null;

    try {
      // Capture usage before query (non-blocking, don't delay query start)
      captureUsageSnapshot().then(u => { usageBefore = u; }).catch(() => {});
      // Capture user message
      if (this.chatCaptureService && this.sessionId) {
        this.chatCaptureService.captureUserMessage(
          this.sessionKey,
          this.sessionId,
          getModelForContext(modelContext),
          message // Original user message, not the preprocessed one
        ).catch(err => console.error("[ChatCapture] Failed to capture user message:", err));
      }

      const queryInstance = query({
        prompt: messageToSend,
        options: {
          ...options,
          abortController: this.abortController,
        },
      }) as AsyncGenerator<SDKMessage>;

      for await (const event of queryInstance) {
        if (this.stopRequested) {
          console.log("Query aborted by user");
          break;
        }

        if (event.type === "stream_event") {
          const raw = event.event;
          const usage: unknown =
            raw.type === "message_start"
              ? raw.message.usage
              : raw.type === "message_delta"
                ? raw.usage
                : null;

          if (usage && typeof usage === "object") {
            lastCallUsage = mergeLatestUsage(
              lastCallUsage,
              usage as Partial<TokenUsage>
            );
          }
        }

        // Capture session_id from first message
        if (!this.sessionId && event.session_id) {
          this.sessionId = event.session_id;
          console.log(`GOT session_id: ${this.sessionId!.slice(0, 8)}...`);
          this.saveSession();
        }

        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "thinking" && block.thinking) {
              console.log(`THINKING BLOCK: ${block.thinking.slice(0, 100)}...`);
              await statusCallback("thinking", block.thinking);
            }

            if (block.type === "tool_use") {
              const toolName = block.name;
              const toolInput = block.input as Record<string, unknown>;

              if (toolName === "Bash") {
                const command = String(toolInput.command || "");
                const [isSafe, reason] = checkCommandSafety(command);
                if (!isSafe) {
                  console.warn(`BLOCKED: ${reason}`);
                  await statusCallback("tool", `BLOCKED: ${reason}`);
                  throw new Error(`Unsafe command blocked: ${reason}`);
                }
              }

              if (["Read", "Write", "Edit"].includes(toolName)) {
                const filePath = String(toolInput.file_path || "");
                if (filePath) {
                  const isTmpRead =
                    toolName === "Read" &&
                    (TEMP_PATHS.some((p) => filePath.startsWith(p)) ||
                      filePath.includes("/.claude/"));

                  if (!isTmpRead && !isPathAllowed(filePath)) {
                    console.warn(
                      `BLOCKED: File access outside allowed paths: ${filePath}`
                    );
                    await statusCallback("tool", `Access denied: ${filePath}`);
                    throw new Error(`File access blocked: ${filePath}`);
                  }
                }
              }

              if (currentSegmentText) {
                await statusCallback(
                  "segment_end",
                  currentSegmentText,
                  currentSegmentId
                );
                currentSegmentId++;
                currentSegmentText = "";
              }

              // Close previous tool timing, start new one
              closeCurrentTool();
              currentToolStart = { name: toolName, startMs: Date.now() };

              const toolDisplay = formatToolStatus(toolName, toolInput);
              this.currentTool = toolDisplay;
              this.lastTool = toolDisplay;
              console.log(`Tool: ${toolDisplay}`);
              await statusCallback("tool", toolDisplay);
            }

            if (block.type === "text") {
              closeCurrentTool(); // Text means tool completed
              responseParts.push(block.text);
              currentSegmentText += block.text;

              const now = Date.now();
              if (
                now - lastTextUpdate > STREAMING_THROTTLE_MS &&
                currentSegmentText.length > 20
              ) {
                await statusCallback("text", currentSegmentText, currentSegmentId);
                lastTextUpdate = now;
              }
            }
          }
        }

        if (event.type === "result") {
          console.log("Response complete");
          closeCurrentTool(); // Close any pending tool timing
          queryCompleted = true;

          const contextWindowFromClaudeCode = (() => {
            const cw = (event as unknown as { context_window?: unknown })
              .context_window;
            if (!isClaudeCodeContextWindow(cw) || !cw.current_usage) return null;

            const cu = cw.current_usage;
            const usage = {
              input_tokens: typeof cu.input_tokens === "number" ? cu.input_tokens : 0,
              cache_creation_input_tokens:
                typeof cu.cache_creation_input_tokens === "number"
                  ? cu.cache_creation_input_tokens
                  : 0,
              cache_read_input_tokens:
                typeof cu.cache_read_input_tokens === "number"
                  ? cu.cache_read_input_tokens
                  : 0,
            };
            const used =
              usage.input_tokens +
              usage.cache_creation_input_tokens +
              usage.cache_read_input_tokens;
            if (used <= 0) return null;

            return { usage, size: cw.context_window_size || null };
          })();

          if (contextWindowFromClaudeCode) {
            this.contextWindowUsage = contextWindowFromClaudeCode.usage;
            if (
              typeof contextWindowFromClaudeCode.size === "number" &&
              contextWindowFromClaudeCode.size > 0
            ) {
              this.contextWindowSize = contextWindowFromClaudeCode.size;
            }
          } else if (lastCallUsage) {
            const usage = {
              input_tokens: lastCallUsage.input_tokens || 0,
              cache_creation_input_tokens:
                lastCallUsage.cache_creation_input_tokens || 0,
              cache_read_input_tokens: lastCallUsage.cache_read_input_tokens || 0,
            };
            if (
              usage.input_tokens +
                usage.cache_creation_input_tokens +
                usage.cache_read_input_tokens >
              0
            ) {
              this.contextWindowUsage = usage;
            }
          } else if ("usage" in event && event.usage) {
            const u = event.usage as unknown as TokenUsage;
            const usage = {
              input_tokens: u.input_tokens || 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
              cache_read_input_tokens: u.cache_read_input_tokens || 0,
            };
            if (
              usage.input_tokens +
                usage.cache_creation_input_tokens +
                usage.cache_read_input_tokens >
              0
            ) {
              this.contextWindowUsage = usage;
            }
          }

          await this.refreshContextWindowUsageFromTranscript(queryStartedMs);

          if ("modelUsage" in event && event.modelUsage) {
            type ModelUsageEntry = {
              inputTokens: number;
              outputTokens: number;
              cacheReadInputTokens: number;
              cacheCreationInputTokens: number;
              contextWindow: number;
            };
            const modelUsage = event.modelUsage as Record<string, ModelUsageEntry>;
            let detectedContextWindow = 0;
            let totalIn = 0,
              totalOut = 0,
              totalCacheRead = 0,
              totalCacheCreate = 0;

            for (const mu of Object.values(modelUsage)) {
              if (!mu) continue;
              if (
                typeof mu.contextWindow === "number" &&
                mu.contextWindow > detectedContextWindow
              ) {
                detectedContextWindow = mu.contextWindow;
              }
              totalIn += mu.inputTokens || 0;
              totalOut += mu.outputTokens || 0;
              totalCacheRead += mu.cacheReadInputTokens || 0;
              totalCacheCreate += mu.cacheCreationInputTokens || 0;
            }

            if (detectedContextWindow > 0)
              this.contextWindowSize = detectedContextWindow;

            this.lastUsage = {
              input_tokens: totalIn,
              output_tokens: totalOut,
              cache_read_input_tokens: totalCacheRead,
              cache_creation_input_tokens: totalCacheCreate,
            };

            if (
              this.currentContextTokens <= 0 &&
              (totalIn > 0 || totalCacheRead > 0 || totalCacheCreate > 0)
            ) {
              this.contextWindowUsage = {
                input_tokens: totalIn,
                cache_creation_input_tokens: totalCacheCreate,
                cache_read_input_tokens: totalCacheRead,
              };
            }
            this.accumulateUsage(this.lastUsage);
          } else if ("usage" in event && event.usage) {
            this.lastUsage = event.usage as TokenUsage;
            this.accumulateUsage(this.lastUsage);
          }

          if (this.contextWindowUsage) {
            const pct = (
              (this.currentContextTokens / this.contextWindowSize) *
              100
            ).toFixed(1);
            console.log(
              `Context: ${this.currentContextTokens}/${this.contextWindowSize} (${pct}%)`
            );
          }
        }
      }
    } catch (error) {
      const isExpectedAbort =
        isAbortError(error) && (queryCompleted || this.stopRequested);

      if (isExpectedAbort) {
        console.warn(`Suppressed expected abort (completed: ${queryCompleted})`);
      } else {
        console.error("Error in query:", error);
        this.lastError = String(error).slice(0, 100);
        this.lastErrorTime = new Date();
        throw error;
      }
    } finally {
      closeCurrentTool(); // Ensure any pending tool timing is closed
      this._queryState = "idle";
      if (this._activityState !== "idle") {
        this.setActivityState("idle");
      }
      this.abortController = null;
      this.queryStarted = null;
      this.currentTool = null;
    }

    this.lastActivity = new Date();
    this.lastError = null;
    this.lastErrorTime = null;

    // Capture usage after query
    usageAfter = await captureUsageSnapshot();

    // Build query metadata
    const contextUsagePercent = this.contextWindowUsage
      ? (this.currentContextTokens / this.contextWindowSize) * 100
      : undefined;
    const metadata: QueryMetadata = {
      usageBefore,
      usageAfter,
      toolDurations,
      queryDurationMs: Date.now() - queryStartedMs,
      contextUsagePercent,
      contextUsagePercentBefore,
      currentProvider: "anthropic",
    };

    if (currentSegmentText) {
      await statusCallback("segment_end", currentSegmentText, currentSegmentId);
    }

    await statusCallback("done", "", undefined, metadata);
    processQueuedJobs().catch((err) =>
      console.error("[CRON] Failed to process queued jobs:", err)
    );

    const fullResponse = responseParts.join("") || "No response from Claude.";

    // Capture assistant response
    if (this.chatCaptureService && this.sessionId) {
      this.chatCaptureService.captureAssistantMessage(
        this.sessionKey,
        this.sessionId,
        getModelForContext(modelContext),
        fullResponse,
        {
          tokenUsage: this.lastUsage ? {
            input: this.lastUsage.input_tokens,
            output: this.lastUsage.output_tokens,
          } : undefined,
        }
      ).catch(err => console.error("[ChatCapture] Failed to capture assistant message:", err));
    }

    return fullResponse;
  }

  async kill(): Promise<void> {
    this.sessionId = null;
    this.lastActivity = null;
    this.sessionStartTime = null;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreateTokens = 0;
    this.totalQueries = 0;
    this.steeringBuffer = [];
    this.resetWarningFlags();
    console.log("Session cleared");
  }

  markRestored(): void {
    this.recentlyRestored = true;
    this.messagesSinceRestore = 0;
    this.resetWarningFlags();
    console.log("Context restored - cooldown activated (50 messages)");
  }

  private resetWarningFlags(): void {
    this.contextLimitWarned = false;
    this.warned70 = false;
    this.warned85 = false;
    this.warned95 = false;
    this.recentlyRestored = false;
    this.messagesSinceRestore = 0;
  }

  restoreFromData(data: SessionData): void {
    this.sessionId = data.session_id;
    this.lastActivity = new Date();
    this.totalInputTokens = data.totalInputTokens || 0;
    this.totalOutputTokens = data.totalOutputTokens || 0;
    this.totalQueries = data.totalQueries || 0;
    this.sessionStartTime = data.sessionStartTime
      ? new Date(data.sessionStartTime)
      : null;
    if (data.contextWindowUsage !== undefined)
      this.contextWindowUsage = data.contextWindowUsage || null;
    if (typeof data.contextWindowSize === "number" && data.contextWindowSize > 0)
      this.contextWindowSize = data.contextWindowSize;
    this.steeringBuffer = [];
  }

  private accumulateUsage(u: TokenUsage): void {
    if (!this.sessionStartTime) this.sessionStartTime = new Date();

    this.totalInputTokens += u.input_tokens || 0;
    this.totalOutputTokens += u.output_tokens || 0;
    this.totalCacheReadTokens += u.cache_read_input_tokens || 0;
    this.totalCacheCreateTokens += u.cache_creation_input_tokens || 0;
    this.totalQueries++;

    console.log(
      `Usage: in=${u.input_tokens} out=${u.output_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_create=${u.cache_creation_input_tokens || 0} cumulative=${this.currentContextTokens}`
    );

    const CONTEXT_LIMIT = this.contextWindowSize || 200_000;
    const COOLDOWN_MESSAGES = 50;
    const currentContext = this.currentContextTokens;

    if (this.recentlyRestored) {
      this.messagesSinceRestore++;
      if (this.messagesSinceRestore >= COOLDOWN_MESSAGES) {
        console.log("Cooldown period complete, re-enabling context limit monitoring");
        this.resetWarningFlags();
      }
    }

    this.checkThreshold(currentContext, CONTEXT_LIMIT, 0.7, "warned70", "70% reached");
    this.checkThreshold(currentContext, CONTEXT_LIMIT, 0.85, "warned85", "85% reached");
    this.checkThreshold(
      currentContext,
      CONTEXT_LIMIT,
      0.95,
      "warned95",
      "95% CRITICAL"
    );

    if (
      currentContext >= CONTEXT_LIMIT * 0.9 &&
      !this.contextLimitWarned &&
      !this.recentlyRestored
    ) {
      this.contextLimitWarned = true;
      const pct = ((currentContext / CONTEXT_LIMIT) * 100).toFixed(1);
      console.log("[TELEMETRY] context_limit_approaching", {
        currentContext,
        threshold: CONTEXT_LIMIT * 0.9,
        percentage: pct,
        timestamp: new Date().toISOString(),
      });
      console.warn(
        `⚠️  CONTEXT LIMIT APPROACHING: ${currentContext}/${CONTEXT_LIMIT} tokens (${pct}%) - SAVE REQUIRED`
      );
    }

    this.saveSession();
  }

  private checkThreshold(
    current: number,
    limit: number,
    pct: number,
    flag: "warned70" | "warned85" | "warned95",
    label: string
  ): void {
    const threshold = Math.floor(limit * pct);
    if (current >= threshold && !this[flag] && !this.recentlyRestored) {
      this[flag] = true;
      const percentage = ((current / limit) * 100).toFixed(1);
      console.log(`[TELEMETRY] context_threshold_${Math.floor(pct * 100)}`, {
        sessionId: this.sessionId?.slice(0, 8),
        currentContext: current,
        threshold,
        tokensRemaining: limit - current,
        percentage,
        timestamp: new Date().toISOString(),
      });
      console.warn(`⚠️  Context: ${current}/${limit} (${percentage}%) - ${label}`);
    }
  }

  private saveSession(): void {
    if (!this.sessionId) return;

    try {
      const data: SessionData = {
        session_id: this.sessionId,
        saved_at: new Date().toISOString(),
        working_dir: this.workingDir,
        contextWindowUsage: this.contextWindowUsage,
        contextWindowSize: this.contextWindowSize,
        totalInputTokens: this.totalInputTokens,
        totalOutputTokens: this.totalOutputTokens,
        totalQueries: this.totalQueries,
        sessionStartTime: this.sessionStartTime?.toISOString(),
      };

      let savePath = SESSION_FILE;
      if (this.sessionKey !== "default") {
        const { mkdirSync, existsSync } = require("fs");
        const sessionsDir = "/tmp/soma-sessions";
        if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
        savePath = `${sessionsDir}/${this.sessionKey.replace(/:/g, "_")}.json`;
      }

      Bun.write(savePath, JSON.stringify(data));
      console.log(
        `Session saved to ${savePath} (context: ${this.totalInputTokens + this.totalOutputTokens} tokens)`
      );
    } catch (error) {
      console.warn(`Failed to save session: ${error}`);
    }
  }

  resumeLast(): [success: boolean, message: string] {
    try {
      const file = Bun.file(SESSION_FILE);
      if (!file.size) return [false, "No saved session found"];

      const data: SessionData = JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
      if (!data.session_id) return [false, "Saved session file is empty"];
      if (data.working_dir && data.working_dir !== WORKING_DIR) {
        return [false, `Session was for different directory: ${data.working_dir}`];
      }

      this.sessionId = data.session_id;
      this.lastActivity = new Date();
      this.totalInputTokens = data.totalInputTokens || 0;
      this.totalOutputTokens = data.totalOutputTokens || 0;
      this.totalQueries = data.totalQueries || 0;
      this.sessionStartTime = data.sessionStartTime
        ? new Date(data.sessionStartTime)
        : null;
      if (data.contextWindowUsage !== undefined)
        this.contextWindowUsage = data.contextWindowUsage || null;
      if (typeof data.contextWindowSize === "number" && data.contextWindowSize > 0)
        this.contextWindowSize = data.contextWindowSize;

      const contextTokens = this.totalInputTokens + this.totalOutputTokens;
      console.log(
        `Resumed session ${data.session_id.slice(0, 8)}... (saved at ${data.saved_at}, context: ${contextTokens} tokens)`
      );
      return [
        true,
        `Resumed session \`${data.session_id.slice(0, 8)}...\` (saved at ${data.saved_at})`,
      ];
    } catch (error) {
      console.error(`Failed to resume session: ${error}`);
      return [false, `Failed to load session: ${error}`];
    }
  }
}

// Global session instance
export const session = new ClaudeSession();
