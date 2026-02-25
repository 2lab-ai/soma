import { existsSync, mkdirSync, readFileSync } from "fs";
import {
  ALLOWED_PATHS,
  CHAT_HISTORY_ACCESS_INFO,
  MCP_SERVERS,
  SAFETY_PROMPT,
  UI_ASKUSER_INSTRUCTIONS,
  WORKING_DIR,
} from "../../config";
import {
  getModelForContext,
  MODEL_DISPLAY_NAMES,
  type ConfigContext,
  type ModelId,
} from "../../config/model";
import {
  beginInterruptTransition,
  clearStopRequestedTransition,
  completeQueryTransition,
  consumeInterruptFlagTransition,
  createInitialSessionRuntimeState,
  endInterruptTransition,
  finalizeQueryTransition,
  incrementGenerationTransition,
  isQueryProcessing,
  isQueryRunning,
  markInterruptFlag,
  requestStopDuringPreparingTransition,
  requestStopDuringRunningTransition,
  startProcessingTransition,
  startQueryTransition,
  stopProcessingTransition,
  transitionActivityState,
  type ActivityState,
  type QueryState,
  type SessionRuntimeState,
} from "./state-machine";
import type { ProviderOrchestrator } from "../../providers/orchestrator";
import { SteeringManager } from "./steering-manager";
import type {
  KillResult,
  PendingRecovery,
  SessionData,
  SteeringMessage,
  TokenUsage,
} from "../../types/session";
import { PENDING_RECOVERY_TIMEOUT_MS } from "../../types/session";
import type { QueryMetadata, StatusCallback, UsageSnapshot } from "../../types/runtime";
import type {
  ChoiceState,
  DirectInputState,
  ParseTextChoiceState,
} from "../../types/user-choice";
import { isAbortError } from "../../utils/error-classification";
import type { ChatCaptureService } from "../../services/chat-capture-service";
import {
  captureUsageSnapshot,
  findLatestMainAssistantContextUsageFromTranscript,
  getThinkingLevel,
} from "./session-helpers";
import {
  createSessionIdentity,
  parseSessionKey,
  type SessionIdentity,
} from "../routing/session-key";
import {
  buildQueryRuntimeMetadata,
  buildQueryRuntimeOptions,
  createQueryRuntimeHooks,
  executeQueryRuntime,
} from "./query-runtime";

export type { ActivityState, QueryState } from "./state-machine";

const initialRuntimeState = createInitialSessionRuntimeState();
const SESSIONS_DIR = "/tmp/soma-sessions";

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

  // Cumulative tool usage (session-wide)
  cumulativeToolDurations: Record<string, { count: number; totalMs: number }> = {};

  constructor(
    sessionKey = "default",
    chatCaptureService: ChatCaptureService | null = null,
    options?: {
      workingDir?: string;
      providerOrchestrator?: ProviderOrchestrator | null;
    }
  ) {
    this.sessionKey = sessionKey;
    this.workingDir = options?.workingDir || WORKING_DIR;
    this.chatCaptureService = chatCaptureService;
    this.providerOrchestrator = options?.providerOrchestrator ?? null;
  }

  contextLimitWarned = false;
  warned70 = false;
  warned85 = false;
  warned95 = false;
  recentlyRestored = false;
  messagesSinceRestore = 0;

  private abortController: AbortController | null = null;
  private _queryState: QueryState = initialRuntimeState.queryState;
  private stopRequested = initialRuntimeState.stopRequested;
  private _generation = initialRuntimeState.generation;
  private _wasInterruptedByNewMessage = initialRuntimeState.wasInterruptedByNewMessage;
  private _isInterrupting = initialRuntimeState.isInterrupting;
  private steering = new SteeringManager(100, PENDING_RECOVERY_TIMEOUT_MS);

  choiceState: ChoiceState | null = null;
  pendingDirectInput: DirectInputState | null = null;
  parseTextChoiceState: ParseTextChoiceState | null = null;
  nextQueryContext: string | null = null; // Context to prepend to next query
  private _activityState: ActivityState = initialRuntimeState.activityState;

  // Rate limit fallback state
  temporaryModelOverride: ModelId | null = null;
  rateLimitState = {
    consecutiveFailures: 0,
    cooldownUntil: null as number | null,
    opusResetsAt: null as string | null,
  };

  private readonly queryRuntimeHooks = createQueryRuntimeHooks({
    getStopRequested: () => this.stopRequested,
    getSteeringCount: () => this.steering.getSteeringCount(),
    trackBufferedMessagesForInjection: () =>
      this.steering.trackBufferedMessagesForInjection(),
    consumeSteering: () => this.consumeSteering(),
    getInjectedCount: () => this.steering.getInjectedCount(),
  });
  // Legacy aliases kept for existing regression tests and compatibility.
  private readonly preToolUseHook = this.queryRuntimeHooks.preToolUseHook;
  private readonly postToolUseHook = this.queryRuntimeHooks.postToolUseHook;
  private providerOrchestrator: ProviderOrchestrator | null;

  private getRuntimeState(): SessionRuntimeState {
    return {
      activityState: this._activityState,
      queryState: this._queryState,
      stopRequested: this.stopRequested,
      wasInterruptedByNewMessage: this._wasInterruptedByNewMessage,
      isInterrupting: this._isInterrupting,
      generation: this._generation,
    };
  }

  private applyRuntimeState(nextState: SessionRuntimeState): void {
    this._activityState = nextState.activityState;
    this._queryState = nextState.queryState;
    this.stopRequested = nextState.stopRequested;
    this._wasInterruptedByNewMessage = nextState.wasInterruptedByNewMessage;
    this._isInterrupting = nextState.isInterrupting;
    this._generation = nextState.generation;
  }

  get activityState(): ActivityState {
    return this._activityState;
  }

  setActivityState(state: ActivityState): void {
    console.log(`[ACTIVITY] ${this._activityState} → ${state}`);
    this.applyRuntimeState(transitionActivityState(this.getRuntimeState(), state));
  }

  setProviderOrchestrator(orchestrator: ProviderOrchestrator | null): void {
    this.providerOrchestrator = orchestrator;
  }

  private resolveProviderIdentity(): SessionIdentity {
    try {
      return parseSessionKey(this.sessionKey);
    } catch {
      const threadId = this.sessionKey.replace(/[:/]/g, "-").trim() || "main";
      return createSessionIdentity({
        tenantId: "default",
        channelId: "legacy",
        threadId,
      });
    }
  }

  private async refreshContextWindowUsageFromTranscript(
    minTimestampMs: number
  ): Promise<boolean> {
    if (!this.sessionId) return false;

    for (let attempt = 0; attempt < 3; attempt++) {
      const usage = findLatestMainAssistantContextUsageFromTranscript(
        this.sessionId,
        this.workingDir,
        minTimestampMs
      );
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
    return isQueryRunning(this.getRuntimeState());
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
    // Per Anthropic API docs: these 3 fields are mutually exclusive (no overlap).
    // total = all tokens that occupy the context window.
    const total = input_tokens + cache_creation_input_tokens + cache_read_input_tokens;
    return total > 0 ? total : null;
  }

  private getContextTokensFromCumulatives(): number {
    return this.totalInputTokens + this.totalCacheCreateTokens;
  }

  /**
   * Format cumulative tool stats for display.
   * Returns string like: "Bash×12: 134.8s | Grep×5: 84.6s"
   */
  formatToolStats(): string {
    const tools = Object.entries(this.cumulativeToolDurations);
    if (tools.length === 0) return "";

    return tools
      .sort((a, b) => b[1].totalMs - a[1].totalMs) // Sort by total time desc
      .slice(0, 5) // Top 5 tools
      .map(([name, { count, totalMs }]) => {
        const secs = (totalMs / 1000).toFixed(1);
        return `${name}×${count}: ${secs}s`;
      })
      .join(" | ");
  }

  get needsSave(): boolean {
    // DISABLED: auto-save causing issues with context overflow loops
    return false;
    // return this.contextLimitWarned && !this.recentlyRestored;
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
    return isQueryProcessing(this.getRuntimeState());
  }

  consumeInterruptFlag(): boolean {
    const result = consumeInterruptFlagTransition(this.getRuntimeState());
    this.applyRuntimeState(result.nextState);
    return result.wasInterrupted;
  }

  markInterrupt(): void {
    this.applyRuntimeState(markInterruptFlag(this.getRuntimeState()));
  }

  clearStopRequested(): void {
    this.applyRuntimeState(clearStopRequestedTransition(this.getRuntimeState()));
  }

  get isInterrupting(): boolean {
    return this._isInterrupting;
  }

  startInterrupt(): boolean {
    const result = beginInterruptTransition(this.getRuntimeState());
    this.applyRuntimeState(result.nextState);
    if (!result.started) {
      console.log("[INTERRUPT] Already interrupting, ignoring duplicate");
      return false;
    }
    return true;
  }

  endInterrupt(): void {
    this.applyRuntimeState(endInterruptTransition(this.getRuntimeState()));
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

  // Pending recovery methods for lost message handling
  setPendingRecovery(
    messages: SteeringMessage[],
    chatId: number,
    messageId?: number
  ): void {
    this.steering.setPendingRecovery(messages, chatId, messageId);
    console.log(
      `[RECOVERY] Set pending recovery: ${messages.length} messages for chat ${chatId}`
    );
  }

  getPendingRecovery(): PendingRecovery | null {
    const recovery = this.steering.getPendingRecovery();
    if (!recovery) return null;
    return recovery;
  }

  resolvePendingRecovery(): SteeringMessage[] | null {
    const messages = this.steering.resolvePendingRecovery();
    if (!messages) return null;
    console.log(`[RECOVERY] Resolved: ${messages.length} messages`);
    return messages;
  }

  clearPendingRecovery(): void {
    const discarded = this.steering.clearPendingRecovery();
    if (!discarded) return;
    console.log(`[RECOVERY] Cleared: ${discarded} messages discarded`);
  }

  hasPendingRecovery(): boolean {
    return this.steering.hasPendingRecovery();
  }

  addSteering(
    message: string,
    messageId: number,
    receivedDuringTool?: string
  ): boolean {
    const result = this.steering.addSteering(message, messageId, receivedDuringTool);
    if (result.evicted && result.evictedMessage) {
      console.warn(
        `[STEERING] Buffer full (${this.steering.getSteeringCount()}/${100}), evicted message #${result.evictedMessage.messageId}: "${result.evictedMessage.content.slice(0, 80)}"`
      );
    }
    console.log(
      `[STEERING DEBUG] Added message to buffer. Buffer now: ${this.steering.getSteeringCount()}, content: "${message.slice(0, 50)}"`
    );
    return result.evicted;
  }

  consumeSteering(): string | null {
    const count = this.steering.getSteeringCount();
    if (!count) {
      console.log(`[STEERING DEBUG] consumeSteering called but buffer empty`);
      return null;
    }
    const formatted = this.steering.consumeSteering();
    if (!formatted) return null;
    console.log(`[STEERING DEBUG] Consumed ${count} message(s) from buffer`);
    return formatted;
  }

  hasSteeringMessages(): boolean {
    return this.steering.hasSteeringMessages();
  }

  getSteeringCount(): number {
    return this.steering.getSteeringCount();
  }

  /**
   * Extract and clear all steering messages from buffer.
   * Used for interrupt recovery flow - returns raw SteeringMessage[] instead of formatted string.
   */
  extractSteeringMessages(): SteeringMessage[] {
    return this.steering.extractSteeringMessages();
  }

  /**
   * Restore injected steering messages back to buffer for fallback processing.
   * Call this after query completes to ensure auto-continue handles them.
   */
  restoreInjectedSteering(): number {
    const bufferBefore = this.steering.getSteeringCount();
    const injectedCount = this.steering.getInjectedCount();
    console.log(
      `[RESTORE DEBUG] Before: buffer=${bufferBefore}, injected=${injectedCount}`
    );

    const restored = this.steering.restoreInjectedSteering();
    if (!restored) {
      console.log(`[RESTORE DEBUG] Nothing to restore`);
      return 0;
    }

    console.log(
      `[STEERING] Restored ${restored} injected message(s) to buffer for fallback processing. Buffer now: ${this.steering.getSteeringCount()}`
    );
    return restored;
  }

  /**
   * Clear injected steering tracking at start of new query.
   */
  clearInjectedSteeringTracking(): void {
    this.steering.clearInjectedSteeringTracking();
  }

  peekSteering(): string | null {
    return this.steering.peekSteering();
  }

  /**
   * Get count of messages tracked for injection during query execution.
   * Used to detect text-only responses where PostToolUse hook didn't fire.
   */
  getInjectedCount(): number {
    return this.steering.getInjectedCount();
  }

  /**
   * Explicitly track buffered messages for injection.
   * Called when text-only response completes without tool hooks firing.
   */
  trackBufferedMessagesForInjection(): number {
    return this.steering.trackBufferedMessagesForInjection();
  }

  startProcessing(): () => void {
    this.applyRuntimeState(startProcessingTransition(this.getRuntimeState()));
    const PROCESSING_TIMEOUT_MS = 60_000;
    let released = false;
    const timer = setTimeout(() => {
      if (!released && this.isProcessing) {
        console.error(
          `[STUCK] isProcessing stuck for ${PROCESSING_TIMEOUT_MS / 1000}s, auto-releasing`
        );
        this.applyRuntimeState(stopProcessingTransition(this.getRuntimeState()));
      }
    }, PROCESSING_TIMEOUT_MS);
    return () => {
      released = true;
      clearTimeout(timer);
      const prevState = this._queryState;
      this.applyRuntimeState(stopProcessingTransition(this.getRuntimeState()));
      console.log(
        `[PROCESSING] stopProcessing() called: ${prevState} → idle, steering=${this.steering.getSteeringCount()}`
      );
      if (this.steering.hasSteeringMessages()) {
        console.log(
          `[STEERING] Keeping ${this.steering.getSteeringCount()} unconsumed messages for next query`
        );
      }
    };
  }

  getPendingSteering(): string | null {
    // Alias for consumeSteering - identical functionality
    console.log(
      `[STEERING DEBUG] getPendingSteering called, buffer: ${this.steering.getSteeringCount()}`
    );
    return this.consumeSteering();
  }

  async stop(): Promise<"stopped" | "pending" | false> {
    if (this._queryState === "running" && this.abortController) {
      this.applyRuntimeState(
        requestStopDuringRunningTransition(this.getRuntimeState())
      );
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
      this.applyRuntimeState(
        requestStopDuringPreparingTransition(this.getRuntimeState())
      );
      console.log("Stop requested - will cancel before query starts");
      return "pending";
    }

    return false;
  }

  async sendMessageStreaming(
    message: string,
    statusCallback: StatusCallback,
    chatId?: number,
    modelContext: ConfigContext = "general"
  ): Promise<string> {
    if (chatId) process.env.TELEGRAM_CHAT_ID = String(chatId);

    const prevInjectedCount = this.steering.restoreInjectedSteering();
    if (prevInjectedCount > 0) {
      console.log(
        `[QUERY START] Restored ${prevInjectedCount} injected message(s) to buffer before new query. Buffer now: ${this.steering.getSteeringCount()}`
      );
    }
    this.steering.clearInjectedSteeringTracking();
    console.log(
      `[QUERY START DEBUG] Cleared injected tracking (was: ${prevInjectedCount}), buffer: ${this.steering.getSteeringCount()}`
    );

    const queryGeneration = this._generation;
    const isNewSession = !this.isActive;
    console.log(
      `[QUERY] Starting: sessionId=${this.sessionId?.slice(0, 8) || "null"}, isNewSession=${isNewSession}, isActive=${this.isActive}`
    );

    const thinkingTokens = getThinkingLevel(message);
    const thinkingLabel =
      { 0: "off", 10000: "normal", 50000: "deep" }[thinkingTokens] ??
      String(thinkingTokens);

    let messageToSend = message;
    const pendingSteering = this.getPendingSteering();
    if (pendingSteering) {
      console.log(
        `[STEERING] Prepending ${pendingSteering.split("\n---\n").length} pending messages to query`
      );
      messageToSend = `[MESSAGES SENT DURING PREVIOUS EXECUTION - user sent these while you were working]\n${pendingSteering}\n[END PREVIOUS MESSAGES]\n\n[NEW MESSAGE]\n${messageToSend}`;
    }

    if (this.nextQueryContext) {
      console.log("[CONTEXT] Prepending recovered context from previous session");
      messageToSend = `${this.nextQueryContext}\n\n${messageToSend}`;
      this.nextQueryContext = null;
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

    if (this.temporaryModelOverride && this.rateLimitState.opusResetsAt) {
      const resetTime = new Date(this.rateLimitState.opusResetsAt).getTime();
      if (Date.now() >= resetTime) {
        console.log("[RATE-LIMIT] Opus reset time passed, clearing override");
        this.temporaryModelOverride = null;
        this.rateLimitState.opusResetsAt = null;
        this.rateLimitState.consecutiveFailures = 0;
      }
    }

    const effectiveModel =
      this.temporaryModelOverride ?? getModelForContext(modelContext);
    if (this.temporaryModelOverride) {
      console.log(
        `[RATE-LIMIT] Using fallback model: ${MODEL_DISPLAY_NAMES[this.temporaryModelOverride] || this.temporaryModelOverride}`
      );
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
      this.applyRuntimeState(clearStopRequestedTransition(this.getRuntimeState()));
      throw new Error("Query cancelled");
    }

    this.abortController = new AbortController();

    // Explicitly load CLAUDE.md from working directory (resolving symlinks)
    let claudeMdContent = "";
    try {
      const { realpathSync } = require("fs");
      const resolvedCwd = realpathSync(this.workingDir);
      const claudeMdPath = `${resolvedCwd}/CLAUDE.md`;
      if (existsSync(claudeMdPath)) {
        claudeMdContent = readFileSync(claudeMdPath, "utf-8");
        console.log(`[SESSION] Loaded CLAUDE.md from ${claudeMdPath} (${claudeMdContent.length} chars)`);
      } else {
        console.warn(`[SESSION] No CLAUDE.md found at ${claudeMdPath}`);
      }
    } catch (err) {
      console.error(`[SESSION] Failed to load CLAUDE.md:`, err);
    }
    const claudeMdSection = claudeMdContent
      ? `\n\n# Project Instructions (CLAUDE.md)\n${claudeMdContent}\n`
      : "";

    const runtimeOptions = buildQueryRuntimeOptions({
      model: effectiveModel,
      cwd: this.workingDir,
      systemPrompt: `${SAFETY_PROMPT}\n\n${UI_ASKUSER_INSTRUCTIONS}\n\n${CHAT_HISTORY_ACCESS_INFO}${claudeMdSection}`,
      mcpServers: MCP_SERVERS,
      maxThinkingTokens: thinkingTokens,
      additionalDirectories: ALLOWED_PATHS,
      resumeSessionId: this.sessionId,
      pathToClaudeCodeExecutable: process.env.CLAUDE_CODE_PATH,
      abortController: this.abortController,
      hooks: this.queryRuntimeHooks,
    });

    this.applyRuntimeState(startQueryTransition(this.getRuntimeState()));
    this.setActivityState("working");
    this.queryStarted = new Date();
    const queryStartedMs = this.queryStarted.getTime();
    this.currentTool = null;

    let queryCompleted = false;
    let runtimeResult: Awaited<ReturnType<typeof executeQueryRuntime>> | null = null;

    const contextUsagePercentBefore = this.contextWindowUsage
      ? (this.currentContextTokens / this.contextWindowSize) * 100
      : undefined;
    let usageBefore: UsageSnapshot | null = null;
    let usageAfter: UsageSnapshot | null = null;

    try {
      captureUsageSnapshot()
        .then((u) => {
          usageBefore = u;
        })
        .catch(() => {});

      if (this.chatCaptureService && this.sessionId) {
        this.chatCaptureService
          .captureUserMessage(
            this.sessionKey,
            this.sessionId,
            getModelForContext(modelContext),
            message
          )
          .catch((err) =>
            console.error("[ChatCapture] Failed to capture user message:", err)
          );
      }

      runtimeResult = await executeQueryRuntime({
        prompt: messageToSend,
        options: runtimeOptions,
        statusCallback,
        queryGeneration,
        getCurrentGeneration: () => this._generation,
        shouldStop: () => this.stopRequested,
        onSessionId: (sessionId: string) => {
          if (this.sessionId) {
            return;
          }
          this.sessionId = sessionId;
          console.log(`GOT session_id: ${this.sessionId.slice(0, 8)}...`);
          this.saveSession();
        },
        onToolDisplay: (toolDisplay: string) => {
          this.currentTool = toolDisplay;
          this.lastTool = toolDisplay;
        },
        onRefreshContextWindowUsageFromTranscript: async (minTimestampMs: number) => {
          const refreshed =
            await this.refreshContextWindowUsageFromTranscript(minTimestampMs);
          return refreshed ? this.contextWindowUsage : null;
        },
        queryStartedMs,
        onQueryCompleted: () => {
          queryCompleted = true;
        },
        providerExecution: this.providerOrchestrator
          ? {
              orchestrator: this.providerOrchestrator,
              identity: this.resolveProviderIdentity(),
              primaryProviderId: "anthropic",
            }
          : undefined,
      });

      if (runtimeResult.contextWindowUsage) {
        this.contextWindowUsage = runtimeResult.contextWindowUsage;
      }
      if (
        typeof runtimeResult.contextWindowSize === "number" &&
        runtimeResult.contextWindowSize > 0
      ) {
        this.contextWindowSize = runtimeResult.contextWindowSize;
      }
      if (runtimeResult.lastUsage) {
        this.lastUsage = runtimeResult.lastUsage;
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
      this.applyRuntimeState(completeQueryTransition(this.getRuntimeState()));
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

    usageAfter = await captureUsageSnapshot();

    const contextUsagePercent = this.contextWindowUsage
      ? (this.currentContextTokens / this.contextWindowSize) * 100
      : undefined;
    const currentModelId = getModelForContext(modelContext);
    const toolDurations = runtimeResult?.toolDurations ?? {};
    const metadata = buildQueryRuntimeMetadata({
      usageBefore,
      usageAfter,
      toolDurations,
      queryStartedMs,
      contextUsagePercent,
      contextUsagePercentBefore,
      modelDisplayName: MODEL_DISPLAY_NAMES[currentModelId] || currentModelId,
      currentProvider: runtimeResult?.providerId,
    });

    for (const [toolName, stats] of Object.entries(toolDurations)) {
      const existing = this.cumulativeToolDurations[toolName] || {
        count: 0,
        totalMs: 0,
      };
      this.cumulativeToolDurations[toolName] = {
        count: existing.count + stats.count,
        totalMs: existing.totalMs + stats.totalMs,
      };
    }

    if (runtimeResult?.trailingSegmentText) {
      await statusCallback(
        "segment_end",
        runtimeResult.trailingSegmentText,
        runtimeResult.trailingSegmentId
      );
    }

    await statusCallback("done", "", undefined, metadata);

    const hasSteeringAtEnd = this.hasSteeringMessages();
    const injectedCount = this.steering.getInjectedCount();
    console.log(
      `[STEERING DEBUG] End of query - buffer: ${this.steering.getSteeringCount()}, injected tracking: ${injectedCount}`
    );

    if (hasSteeringAtEnd) {
      const steeringCount = this.getSteeringCount();
      const steeringContent = this.peekSteering();
      console.log(
        `[STEERING] ${steeringCount} message(s) not delivered (text-only response)`
      );
      await statusCallback("steering_pending", steeringContent || "", undefined, {
        ...metadata,
        steeringCount,
      } as QueryMetadata & { steeringCount: number });
    }

    const fullResponse = runtimeResult?.fullResponse || "No response from Claude.";

    if (this.chatCaptureService && this.sessionId) {
      this.chatCaptureService
        .captureAssistantMessage(
          this.sessionKey,
          this.sessionId,
          getModelForContext(modelContext),
          fullResponse,
          {
            tokenUsage: this.lastUsage
              ? {
                  input: this.lastUsage.input_tokens,
                  output: this.lastUsage.output_tokens,
                }
              : undefined,
          }
        )
        .catch((err) =>
          console.error("[ChatCapture] Failed to capture assistant message:", err)
        );
    }

    this.applyRuntimeState(finalizeQueryTransition(this.getRuntimeState()));
    return fullResponse;
  }

  async kill(): Promise<KillResult> {
    // Increment generation to invalidate any in-flight queries
    this.applyRuntimeState(incrementGenerationTransition(this.getRuntimeState()));
    console.log(`[KILL] Generation incremented to ${this._generation}`);

    // Block any pending tools via preToolUseHook
    this.applyRuntimeState(
      requestStopDuringPreparingTransition(this.getRuntimeState())
    );

    // Abort any in-flight query
    if (this.abortController) {
      this.abortController.abort();
      console.log("[KILL] Aborted in-flight query");
    }

    // Extract lost steering messages for caller to offer recovery
    const lostMessages = this.steering.extractSteeringMessages();
    if (lostMessages.length > 0) {
      console.warn(
        `[STEERING] Extracted ${lostMessages.length} message(s) during session kill`
      );
    }

    this.applyRuntimeState(finalizeQueryTransition(this.getRuntimeState()));
    this.sessionId = null;
    this.lastActivity = null;
    this.sessionStartTime = null;
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
    this.totalCacheReadTokens = 0;
    this.totalCacheCreateTokens = 0;
    this.totalQueries = 0;
    this.cumulativeToolDurations = {};
    this.steering.reset();
    this.resetWarningFlags();
    console.log("Session cleared");
    return { count: lostMessages.length, messages: lostMessages };
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

  restoreFromData(data: SessionData): KillResult {
    // Extract lost steering messages for caller to offer recovery
    const lostMessages = this.steering.extractSteeringMessages();
    if (lostMessages.length > 0) {
      console.warn(
        `[STEERING] Extracted ${lostMessages.length} message(s) during session restore`
      );
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
    return { count: lostMessages.length, messages: lostMessages };
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

    // Reset contextLimitWarned if context dropped significantly (compaction detected)
    if (this.contextLimitWarned && currentContext < CONTEXT_LIMIT * 0.8) {
      console.log(
        `[CONTEXT] Compaction detected: ${currentContext}/${CONTEXT_LIMIT} (${((currentContext / CONTEXT_LIMIT) * 100).toFixed(1)}%). Resetting contextLimitWarned.`
      );
      this.contextLimitWarned = false;
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

    // DISABLED: auto-save on every accumulation
    // this.saveSession();
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

      if (!existsSync(SESSIONS_DIR)) {
        mkdirSync(SESSIONS_DIR, { recursive: true });
      }
      const savePath = this.getSessionFilePath();
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
      const savePath = this.getSessionFilePath();
      const file = Bun.file(savePath);
      if (!file.size) return [false, "No saved session found"];

      const data: SessionData = JSON.parse(readFileSync(savePath, "utf-8"));
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

  private getSessionFilePath(): string {
    const safeKey = this.sessionKey.replace(/[:/]/g, "_");
    return `${SESSIONS_DIR}/${safeKey}.json`;
  }
}
