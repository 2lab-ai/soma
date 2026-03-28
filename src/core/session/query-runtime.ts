import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderOrchestrator } from "../../providers/orchestrator";
import type { ProviderEvent, ProviderQueryInput } from "../../providers/types.models";
import { resolve } from "path";
import { STREAMING_THROTTLE_MS, TEMP_PATHS } from "../../config";
import { escapeHtml, formatToolStatus } from "../../formatting";
import { checkCommandSafety, isPathAllowed } from "../../security";
import type { QueryMetadata, StatusCallback, UsageSnapshot } from "../../types/runtime";
import type { Provider } from "../../types/provider";
import type { TokenUsage } from "../../types/session";
import type { SessionIdentity } from "../routing/session-key";
import {
  getContextWindowUsedTokens,
  hasContextWindowUsageData,
  isClaudeCodeContextWindow,
  mergeLatestUsage,
  resolveContextWindowSize,
  toContextWindowUsage,
  type ContextWindowUsage,
} from "./session-helpers";

export type QueryRuntimeToolHook = (
  input: unknown,
  toolUseId: unknown,
  context: unknown
) => Promise<Record<string, unknown>>;

interface QueryRuntimeHookDependencies {
  getStopRequested: () => boolean;
  getSteeringCount: () => number;
  trackBufferedMessagesForInjection: () => number;
  consumeSteering: () => string | null;
  getInjectedCount: () => number;
}

export interface QueryRuntimeHooks {
  preToolUseHook: QueryRuntimeToolHook;
  postToolUseHook: QueryRuntimeToolHook;
}

export function createQueryRuntimeHooks(
  deps: QueryRuntimeHookDependencies
): QueryRuntimeHooks {
  const preToolUseHook: QueryRuntimeToolHook = async (
    input: unknown,
    _toolUseId: unknown,
    _context: unknown
  ): Promise<Record<string, unknown>> => {
    const toolName = (input as { tool_name?: string }).tool_name || "unknown";
    const toolInput =
      (input as { tool_input?: Record<string, unknown> }).tool_input ?? {};
    console.log(`[HOOK] PreToolUse fired for: ${toolName}`);

    if (deps.getStopRequested()) {
      console.log(`[HOOK] Abort requested - blocking tool: ${toolName}`);
      const abortError = new Error("Abort requested by user");
      abortError.name = "AbortError";
      throw abortError;
    }

    // Validate tool input and block gracefully instead of throwing fatal errors.
    // The SDK feeds { decision: 'block', reason } back to the model as a tool
    // error result, allowing the model to adapt and continue autonomously.
    const validation = checkToolInputSafety(toolName, toolInput);
    if (!validation.allowed) {
      console.warn(`[HOOK] Blocking tool ${toolName}: ${validation.reason}`);
      return { decision: "block", reason: validation.reason };
    }

    return {};
  };

  const postToolUseHook: QueryRuntimeToolHook = async (
    input: unknown,
    _toolUseId: unknown,
    _context: unknown
  ): Promise<Record<string, unknown>> => {
    const toolName = (input as { tool_name?: string }).tool_name || "unknown";
    console.log(`[HOOK] PostToolUse fired for: ${toolName}`);

    const bufferSize = deps.getSteeringCount();
    console.log(`[HOOK DEBUG] Buffer size at hook: ${bufferSize}`);

    if (!bufferSize) {
      return {};
    }

    const injectedCount = deps.trackBufferedMessagesForInjection();
    const steering = deps.consumeSteering();
    if (!steering) {
      return {};
    }

    console.log(
      `[STEERING] Injecting ${injectedCount} message(s) after ${toolName} (tracked for fallback: ${deps.getInjectedCount()})`
    );
    return {
      systemMessage: `[USER SENT MESSAGE DURING EXECUTION]\n${steering}\n[END USER MESSAGE]`,
    };
  };

  return {
    preToolUseHook,
    postToolUseHook,
  };
}

export interface BuildQueryRuntimeOptionsInput {
  model: string;
  cwd: string;
  systemPrompt: string;
  mcpServers: Options["mcpServers"];
  maxThinkingTokens: number;
  additionalDirectories: string[];
  resumeSessionId: string | null;
  pathToClaudeCodeExecutable?: string;
  abortController: AbortController;
  hooks: QueryRuntimeHooks;
}

export function buildQueryRuntimeOptions(
  input: BuildQueryRuntimeOptionsInput
): Options & { abortController: AbortController } {
  const options: Options & { abortController: AbortController } = {
    model: input.model,
    cwd: input.cwd,
    settingSources: ["user", "project"],
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    systemPrompt: input.systemPrompt,
    mcpServers: input.mcpServers,
    maxThinkingTokens: input.maxThinkingTokens,
    additionalDirectories: input.additionalDirectories,
    resume: input.resumeSessionId || undefined,
    hooks: {
      PreToolUse: [
        {
          hooks: [input.hooks.preToolUseHook],
        },
      ],
      PostToolUse: [
        {
          hooks: [input.hooks.postToolUseHook],
        },
      ],
    },
    abortController: input.abortController,
  };

  if (input.pathToClaudeCodeExecutable) {
    options.pathToClaudeCodeExecutable = input.pathToClaudeCodeExecutable;
  }

  return options;
}

export interface QueryRuntimeExecutionInput {
  prompt: string;
  options: Options & { abortController: AbortController };
  statusCallback: StatusCallback;
  queryGeneration: number;
  getCurrentGeneration: () => number;
  shouldStop: () => boolean;
  onSessionId: (sessionId: string) => void;
  onToolDisplay: (toolDisplay: string) => void;
  onRefreshContextWindowUsageFromTranscript: (
    minTimestampMs: number
  ) => Promise<ContextWindowUsage | null>;
  queryStartedMs: number;
  onQueryCompleted?: () => void;
  queryFactory?: (payload: {
    prompt: string;
    options: Options & { abortController: AbortController };
  }) => AsyncGenerator<SDKMessage>;
  providerExecution?: QueryRuntimeProviderExecutionInput;
}

export interface QueryRuntimeProviderExecutionInput {
  orchestrator: ProviderOrchestrator;
  identity: SessionIdentity;
  primaryProviderId: string;
  fallbackProviderId?: string;
}

export interface QueryRuntimeExecutionResult {
  providerId: Provider;
  fullResponse: string;
  trailingSegmentText: string;
  trailingSegmentId: number;
  toolDurations: Record<string, { count: number; totalMs: number }>;
  contextWindowUsage: ContextWindowUsage | null;
  contextWindowSize: number | null;
  lastUsage: TokenUsage | null;
  queryCompleted: boolean;
  // Authoritative context values from SDK "context" events ONLY
  actualContextUsed: number | null;
  actualContextMax: number | null;
}

function hasContextWindowUsage(usage: ContextWindowUsage): boolean {
  return hasContextWindowUsageData(usage);
}

function toTokenUsageFromProviderUsage(usage: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): TokenUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_input_tokens: usage.cacheReadInputTokens || 0,
    cache_creation_input_tokens: usage.cacheCreationInputTokens || 0,
  };
}

type ToolInputValidation =
  | { allowed: true }
  | { allowed: false; reason: string };

/**
 * Pure, non-throwing validation of tool input.
 * Returns a validation result instead of throwing so callers can decide
 * whether to block gracefully (via SDK hook) or log and continue.
 */
// Regex to extract file paths from common file-reading Bash commands.
// Matches: cat, head, tail, less, more, cp, mv, tee, wc, sort, sed, awk
// followed by optional flags (-n, -5, etc.) and then a path starting with /
const BASH_FILE_READ_RE =
  /\b(?:cat|head|tail|less|more|cp|mv|tee|wc|sort|sed|awk)\b(?:\s+-\S+)*\s+(\/[^\s|;&>]+)/gi;

export function checkToolInputSafety(
  toolName: string,
  toolInput: Record<string, unknown>
): ToolInputValidation {
  if (toolName === "Bash") {
    const command = String(toolInput.command || "");
    const [isSafe, reason] = checkCommandSafety(command);
    if (!isSafe) {
      return { allowed: false, reason: `Unsafe command blocked: ${reason}` };
    }

    // Check file paths embedded in common file-reading commands
    let match: RegExpExecArray | null;
    BASH_FILE_READ_RE.lastIndex = 0;
    while ((match = BASH_FILE_READ_RE.exec(command)) !== null) {
      const extractedPath = match[1]!;
      const resolvedPath = resolve(extractedPath);
      if (!isPathAllowed(resolvedPath)) {
        return {
          allowed: false,
          reason: `Bash command accesses blocked path: ${extractedPath} — outside allowed directories.`,
        };
      }
    }
  }

  if (["Read", "Write", "Edit"].includes(toolName)) {
    const filePath = String(toolInput.file_path || "");
    if (filePath) {
      // Resolve to absolute path BEFORE any prefix check to prevent
      // traversal attacks like /tmp/../etc/passwd → /etc/passwd
      const resolvedPath = resolve(filePath);

      const isTmpRead =
        toolName === "Read" &&
        (TEMP_PATHS.some((p) => resolvedPath.startsWith(p)) ||
          resolvedPath.includes("/.claude/"));

      if (!isTmpRead && !isPathAllowed(resolvedPath)) {
        return {
          allowed: false,
          reason: `File access blocked: ${filePath} — path is outside allowed directories. Try an alternative approach or ask the user to share the file content directly.`,
        };
      }
    }
  }

  // Validate path parameter for Grep and Glob tools
  if (["Grep", "Glob"].includes(toolName)) {
    const toolPath = String(toolInput.path || "");
    if (toolPath) {
      const resolvedPath = resolve(toolPath);
      if (!isPathAllowed(resolvedPath)) {
        return {
          allowed: false,
          reason: `${toolName} path blocked: ${toolPath} — outside allowed directories.`,
        };
      }
    }
  }

  return { allowed: true };
}

/**
 * Secondary validation in event handlers (defense-in-depth).
 *
 * The PRIMARY enforcement is the PreToolUse hook returning { decision: 'block' }.
 * This function is called in event handlers where tool_use events are observed.
 *
 * Returns true if the tool is allowed, false if blocked.
 * Does NOT throw — throwing here kills the entire session (the original bug).
 * Callers should skip tool processing when this returns false.
 *
 * Note: All current providers (ClaudeProviderAdapter) pass hooks to the SDK,
 * so PreToolUse always fires. This is a safety net for hypothetical future
 * providers that might not invoke hooks.
 */
async function validateToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  statusCallback: StatusCallback
): Promise<boolean> {
  const result = checkToolInputSafety(toolName, toolInput);
  if (!result.allowed) {
    console.error(`[SECURITY] Tool blocked (defense-in-depth): ${result.reason}`);
    // HTML-escape the reason before sending to Telegram (parse_mode: "HTML")
    await statusCallback("tool", escapeHtml(result.reason));
    return false;
  }
  return true;
}

function toProviderPermissionMode(
  permissionMode: Options["permissionMode"]
): ProviderQueryInput["permissionMode"] {
  if (permissionMode === "bypassPermissions") {
    return "bypass";
  }
  return "default";
}

function mapProviderId(providerId: string): Provider {
  if (providerId === "codex" || providerId === "gemini") {
    return providerId;
  }
  return "anthropic";
}

async function executeProviderRuntime(
  input: QueryRuntimeExecutionInput & {
    providerExecution: QueryRuntimeProviderExecutionInput;
  }
): Promise<QueryRuntimeExecutionResult> {
  const responseParts: string[] = [];
  let currentSegmentId = 0;
  let currentSegmentText = "";
  let lastTextUpdate = 0;
  let queryCompleted = false;
  let lastAssistantTurnUsage: TokenUsage | null = null;
  let lastUsage: TokenUsage | null = null;
  let contextWindowUsage: ContextWindowUsage | null = null;
  let contextWindowSize: number | null = null;
  let actualContextUsed: number | null = null;
  let actualContextMax: number | null = null;
  let generationMismatch = false;
  let usedProviderId = input.providerExecution.primaryProviderId;

  let currentToolStart: { name: string; startMs: number } | null = null;
  const toolDurations: Record<string, { count: number; totalMs: number }> = {};
  const closeCurrentTool = () => {
    if (!currentToolStart) {
      return;
    }
    const duration = Date.now() - currentToolStart.startMs;
    const existing = toolDurations[currentToolStart.name] || {
      count: 0,
      totalMs: 0,
    };
    toolDurations[currentToolStart.name] = {
      count: existing.count + 1,
      totalMs: existing.totalMs + duration,
    };
    currentToolStart = null;
  };

  const queryId = `${input.providerExecution.identity.tenantId}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;

  const providerInput: ProviderQueryInput = {
    queryId,
    identity: input.providerExecution.identity,
    prompt: input.prompt,
    modelId: input.options.model,
    workingDirectory: input.options.cwd,
    resumeSessionId: input.options.resume,
    maxThinkingTokens: input.options.maxThinkingTokens,
    mcpServers:
      (input.options.mcpServers as Readonly<Record<string, unknown>>) ?? undefined,
    additionalDirectories: input.options.additionalDirectories,
    systemPrompt:
      typeof input.options.systemPrompt === "string"
        ? input.options.systemPrompt
        : undefined,
    permissionMode: toProviderPermissionMode(input.options.permissionMode),
    hooks: input.options.hooks,
    pathToClaudeCodeExecutable: input.options.pathToClaudeCodeExecutable,
    allowDangerouslySkipPermissions: input.options.allowDangerouslySkipPermissions,
    abortController: input.options.abortController,
  };

  const onProviderEvent = async (event: ProviderEvent): Promise<void> => {
    if (input.shouldStop()) {
      input.options.abortController.abort();
      return;
    }

    if (input.queryGeneration !== input.getCurrentGeneration()) {
      generationMismatch = true;
      input.options.abortController.abort();
      return;
    }

    if (event.type === "session") {
      input.onSessionId(event.providerSessionId);
      return;
    }

    if (event.type === "tool") {
      if (event.phase === "start") {
        const toolInput =
          event.payload && typeof event.payload === "object"
            ? (event.payload as Record<string, unknown>)
            : {};
        const toolAllowed = await validateToolInput(
          event.toolName,
          toolInput,
          input.statusCallback
        );
        if (!toolAllowed) {
          return; // Skip tool processing — PreToolUse hook already blocked this
        }

        if (currentSegmentText) {
          await input.statusCallback(
            "segment_end",
            currentSegmentText,
            currentSegmentId
          );
          currentSegmentId++;
          currentSegmentText = "";
        }

        closeCurrentTool();
        currentToolStart = { name: event.toolName, startMs: Date.now() };

        const toolDisplay = formatToolStatus(event.toolName, toolInput);
        input.onToolDisplay(toolDisplay);
        console.log(`Tool: ${toolDisplay}`);
        await input.statusCallback("tool", toolDisplay);
      } else {
        closeCurrentTool();
      }
      return;
    }

    if (event.type === "text") {
      closeCurrentTool();
      responseParts.push(event.delta);
      currentSegmentText += event.delta;

      const now = Date.now();
      if (
        now - lastTextUpdate > STREAMING_THROTTLE_MS &&
        currentSegmentText.length > 20
      ) {
        await input.statusCallback("text", currentSegmentText, currentSegmentId);
        lastTextUpdate = now;
      }
      return;
    }

    if (event.type === "usage") {
      const normalizedUsage = toTokenUsageFromProviderUsage(event.usage);
      if (event.usage.usageKind === "assistant_turn") {
        lastAssistantTurnUsage = normalizedUsage;
        contextWindowUsage = toContextWindowUsage(normalizedUsage);
        if (actualContextUsed === null) {
          actualContextUsed = getContextWindowUsedTokens(normalizedUsage);
        }
      } else {
        lastUsage = normalizedUsage;
        if (!contextWindowUsage && hasContextWindowUsageData(normalizedUsage)) {
          contextWindowUsage = toContextWindowUsage(normalizedUsage);
        }
      }
      return;
    }

    if (event.type === "context") {
      contextWindowSize = event.maxTokens;
      actualContextUsed = event.usedTokens;
      actualContextMax = event.maxTokens;
      if (!contextWindowUsage && event.usedTokens > 0) {
        contextWindowUsage = toContextWindowUsage({
          input_tokens: event.usedTokens,
        });
      }
      return;
    }

    if (event.type === "done") {
      console.log("Response complete");
      closeCurrentTool();
      if (event.reason === "completed") {
        queryCompleted = true;
        input.onQueryCompleted?.();
      }
    }
  };

  try {
    const result = await input.providerExecution.orchestrator.executeProviderQuery({
      primaryProviderId: input.providerExecution.primaryProviderId,
      fallbackProviderId: input.providerExecution.fallbackProviderId,
      input: providerInput,
      onEvent: onProviderEvent,
    });
    usedProviderId = result.providerId;
  } catch (error) {
    if (!generationMismatch) {
      closeCurrentTool();
      throw error;
    }
  }

  if (!contextWindowUsage && queryCompleted) {
    const refreshedUsage = await input.onRefreshContextWindowUsageFromTranscript(
      input.queryStartedMs
    );
    if (refreshedUsage) {
      lastAssistantTurnUsage = mergeLatestUsage(null, refreshedUsage);
      contextWindowUsage = refreshedUsage;
    }
  }

  if (!contextWindowUsage) {
    if (lastAssistantTurnUsage && hasContextWindowUsageData(lastAssistantTurnUsage)) {
      contextWindowUsage = toContextWindowUsage(lastAssistantTurnUsage);
    } else if (lastUsage && hasContextWindowUsageData(lastUsage)) {
      contextWindowUsage = toContextWindowUsage(lastUsage);
    }
  }

  if (actualContextUsed === null && contextWindowUsage) {
    actualContextUsed = getContextWindowUsedTokens(contextWindowUsage);
  }
  if (actualContextMax === null && contextWindowSize) {
    actualContextMax = contextWindowSize;
  }

  closeCurrentTool();

  return {
    providerId: mapProviderId(usedProviderId),
    fullResponse: responseParts.join("") || "No response from Claude.",
    trailingSegmentText: currentSegmentText,
    trailingSegmentId: currentSegmentId,
    toolDurations,
    contextWindowUsage,
    contextWindowSize,
    lastUsage,
    queryCompleted,
    actualContextUsed,
    actualContextMax,
  };
}

export async function executeQueryRuntime(
  input: QueryRuntimeExecutionInput
): Promise<QueryRuntimeExecutionResult> {
  if (input.providerExecution) {
    return executeProviderRuntime({
      ...input,
      providerExecution: input.providerExecution,
    });
  }

  const queryFactory = input.queryFactory ?? query;
  const queryInstance = queryFactory({
    prompt: input.prompt,
    options: input.options,
  }) as AsyncGenerator<SDKMessage>;

  const responseParts: string[] = [];
  let currentSegmentId = 0;
  let currentSegmentText = "";
  let lastTextUpdate = 0;
  let queryCompleted = false;
  let sdkBetas: string[] = [];
  let lastAssistantTurnUsage: TokenUsage | null = null;
  let lastCallUsage: TokenUsage | null = null;
  let lastUsage: TokenUsage | null = null;
  let contextWindowUsage: ContextWindowUsage | null = null;
  let contextWindowSize: number | null = null;
  let actualContextUsed: number | null = null;
  let actualContextMax: number | null = null;

  let currentToolStart: { name: string; startMs: number } | null = null;
  const toolDurations: Record<string, { count: number; totalMs: number }> = {};
  const closeCurrentTool = () => {
    if (!currentToolStart) {
      return;
    }
    const duration = Date.now() - currentToolStart.startMs;
    const existing = toolDurations[currentToolStart.name] || {
      count: 0,
      totalMs: 0,
    };
    toolDurations[currentToolStart.name] = {
      count: existing.count + 1,
      totalMs: existing.totalMs + duration,
    };
    currentToolStart = null;
  };

  for await (const event of queryInstance) {
    if (input.shouldStop()) {
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
        lastCallUsage = mergeLatestUsage(lastCallUsage, usage as Partial<TokenUsage>);
      }
    }

    if (event.type === "system") {
      const sysEvent = event as {
        subtype?: string;
        compact_metadata?: { trigger: string; pre_tokens: number };
        status?: string | null;
        betas?: unknown;
      };
      if (sysEvent.subtype === "init" && Array.isArray(sysEvent.betas)) {
        sdkBetas = sysEvent.betas.filter(
          (beta): beta is string => typeof beta === "string"
        );
      }
      if (sysEvent.subtype === "compact_boundary") {
        const trigger = sysEvent.compact_metadata?.trigger ?? "unknown";
        const preTokens = sysEvent.compact_metadata?.pre_tokens ?? 0;
        console.log(
          `[COMPACT] ${trigger} compact triggered (pre_tokens: ${preTokens})`
        );
        await input.statusCallback(
          "system",
          `🔄 Context compacting (${trigger}, ${preTokens} tokens)...`
        );
      }
      if (sysEvent.subtype === "status" && sysEvent.status === "compacting") {
        console.log("[COMPACT] Compaction in progress...");
      }
    }

    if (event.session_id) {
      if (input.queryGeneration !== input.getCurrentGeneration()) {
        console.log(
          `[GENERATION] Session killed mid-query (gen ${input.queryGeneration} vs ${input.getCurrentGeneration()}), ignoring session_id`
        );
        break;
      }
      input.onSessionId(event.session_id);
    }

    if (event.type === "assistant") {
      const assistantUsage = event.message?.usage;
      if (assistantUsage && typeof assistantUsage === "object") {
        lastAssistantTurnUsage = mergeLatestUsage(
          lastAssistantTurnUsage,
          assistantUsage as Partial<TokenUsage>
        );
      }

      for (const block of event.message.content) {
        if (block.type === "thinking" && block.thinking) {
          console.log(`THINKING BLOCK: ${block.thinking.slice(0, 100)}...`);
          await input.statusCallback("thinking", block.thinking);
        }

        if (block.type === "tool_use") {
          const toolName = block.name;
          const toolInput = block.input as Record<string, unknown>;
          const toolAllowed = await validateToolInput(
            toolName,
            toolInput,
            input.statusCallback
          );
          if (!toolAllowed) {
            continue; // Skip tool processing — PreToolUse hook already blocked this
          }

          if (currentSegmentText) {
            await input.statusCallback(
              "segment_end",
              currentSegmentText,
              currentSegmentId
            );
            currentSegmentId++;
            currentSegmentText = "";
          }

          closeCurrentTool();
          currentToolStart = { name: toolName, startMs: Date.now() };

          const toolDisplay = formatToolStatus(toolName, toolInput);
          input.onToolDisplay(toolDisplay);
          console.log(`Tool: ${toolDisplay}`);
          await input.statusCallback("tool", toolDisplay);
        }

        if (block.type === "text") {
          closeCurrentTool();
          responseParts.push(block.text);
          currentSegmentText += block.text;

          const now = Date.now();
          if (
            now - lastTextUpdate > STREAMING_THROTTLE_MS &&
            currentSegmentText.length > 20
          ) {
            await input.statusCallback("text", currentSegmentText, currentSegmentId);
            lastTextUpdate = now;
          }
        }
      }
    }

    if (event.type === "result") {
      closeCurrentTool();

      // Check for SDK error variants (error_during_execution, error_max_turns, etc.)
      const resultSubtype = (event as unknown as { subtype?: string }).subtype;
      const resultErrors = (event as unknown as { errors?: string[] }).errors;
      const resultIsError = (event as unknown as { is_error?: boolean }).is_error;

      if (resultSubtype && resultSubtype !== "success") {
        console.error(`[SDK-RESULT-ERROR] subtype=${resultSubtype}, is_error=${resultIsError}, errors=${JSON.stringify(resultErrors ?? [])}`);
        queryCompleted = false;
      } else {
        console.log("Response complete");
        queryCompleted = true;
        input.onQueryCompleted?.();
      }

      const contextWindowFromClaudeCode = (() => {
        const cw = (event as unknown as { context_window?: unknown }).context_window;
        if (!isClaudeCodeContextWindow(cw)) return null;

        const cu = cw.current_usage;
        const usage =
          cu && typeof cu === "object"
            ? toContextWindowUsage({
                input_tokens: typeof cu.input_tokens === "number" ? cu.input_tokens : 0,
                output_tokens:
                  typeof cu.output_tokens === "number" ? cu.output_tokens : 0,
                cache_creation_input_tokens:
                  typeof cu.cache_creation_input_tokens === "number"
                    ? cu.cache_creation_input_tokens
                    : 0,
                cache_read_input_tokens:
                  typeof cu.cache_read_input_tokens === "number"
                    ? cu.cache_read_input_tokens
                    : 0,
              })
            : null;

        return {
          usage: usage && hasContextWindowUsage(usage) ? usage : null,
          size:
            typeof cw.context_window_size === "number" ? cw.context_window_size : null,
        };
      })();

      const refreshedUsage = await input.onRefreshContextWindowUsageFromTranscript(
        input.queryStartedMs
      );
      if (refreshedUsage) {
        lastAssistantTurnUsage = mergeLatestUsage(null, refreshedUsage);
      }

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
        let totalIn = 0;
        let totalOut = 0;
        let totalCacheRead = 0;
        let totalCacheCreate = 0;

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

        lastUsage = {
          input_tokens: totalIn,
          output_tokens: totalOut,
          cache_read_input_tokens: totalCacheRead,
          cache_creation_input_tokens: totalCacheCreate,
        };
        contextWindowSize = resolveContextWindowSize({
          sdkWindow: contextWindowFromClaudeCode?.size ?? detectedContextWindow,
          model: input.options.model,
          betas: sdkBetas,
        });
      } else if ("usage" in event && event.usage) {
        lastUsage = mergeLatestUsage(
          null,
          (event.usage as unknown as Partial<TokenUsage>) ?? {}
        );
        contextWindowSize = resolveContextWindowSize({
          sdkWindow: contextWindowFromClaudeCode?.size,
          model: input.options.model,
          betas: sdkBetas,
        });
      } else {
        contextWindowSize = resolveContextWindowSize({
          sdkWindow: contextWindowFromClaudeCode?.size,
          model: input.options.model,
          betas: sdkBetas,
        });
      }

      const assistantSnapshot =
        refreshedUsage ?? lastAssistantTurnUsage ?? lastCallUsage;
      if (assistantSnapshot && hasContextWindowUsageData(assistantSnapshot)) {
        contextWindowUsage = toContextWindowUsage(assistantSnapshot);
      } else if (lastUsage && hasContextWindowUsageData(lastUsage)) {
        contextWindowUsage = toContextWindowUsage(lastUsage);
      } else if (contextWindowFromClaudeCode?.usage) {
        contextWindowUsage = contextWindowFromClaudeCode.usage;
      }

      if (contextWindowUsage) {
        actualContextUsed = getContextWindowUsedTokens(contextWindowUsage);
      }
      if (contextWindowSize) {
        actualContextMax = contextWindowSize;
      }
    }
  }

  closeCurrentTool();

  return {
    providerId: "anthropic",
    fullResponse: responseParts.join("") || "No response from Claude.",
    trailingSegmentText: currentSegmentText,
    trailingSegmentId: currentSegmentId,
    toolDurations,
    contextWindowUsage,
    contextWindowSize,
    lastUsage,
    queryCompleted,
    actualContextUsed,
    actualContextMax,
  };
}

export interface BuildQueryRuntimeMetadataInput {
  usageBefore: UsageSnapshot | null;
  usageAfter: UsageSnapshot | null;
  toolDurations: Record<string, { count: number; totalMs: number }>;
  queryStartedMs: number;
  queryEndedMs?: number;
  contextUsagePercent?: number;
  contextUsagePercentBefore?: number;
  modelDisplayName?: string;
  currentProvider?: Provider;
}

export function buildQueryRuntimeMetadata(
  input: BuildQueryRuntimeMetadataInput
): QueryMetadata {
  return {
    usageBefore: input.usageBefore,
    usageAfter: input.usageAfter,
    toolDurations: input.toolDurations,
    queryDurationMs: (input.queryEndedMs ?? Date.now()) - input.queryStartedMs,
    contextUsagePercent: input.contextUsagePercent,
    contextUsagePercentBefore: input.contextUsagePercentBefore,
    currentProvider: input.currentProvider ?? "anthropic",
    modelDisplayName: input.modelDisplayName,
  };
}
