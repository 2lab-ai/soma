import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderOrchestrator } from "../../providers/orchestrator";
import type { ProviderEvent, ProviderQueryInput } from "../../providers/types.models";
import { STREAMING_THROTTLE_MS, TEMP_PATHS } from "../../config";
import { formatToolStatus } from "../../formatting";
import { checkCommandSafety, isPathAllowed } from "../../security";
import type { QueryMetadata, StatusCallback, UsageSnapshot } from "../../types/runtime";
import type { Provider } from "../../types/provider";
import type { TokenUsage } from "../../types/session";
import type { SessionIdentity } from "../routing/session-key";
import {
  isClaudeCodeContextWindow,
  mergeLatestUsage,
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
    console.log(`[HOOK] PreToolUse fired for: ${toolName}`);

    if (deps.getStopRequested()) {
      console.log(`[HOOK] Abort requested - blocking tool: ${toolName}`);
      throw new Error("Abort requested by user");
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
}

function hasContextWindowUsage(usage: ContextWindowUsage): boolean {
  return (
    usage.input_tokens +
      usage.cache_creation_input_tokens +
      usage.cache_read_input_tokens >
    0
  );
}

async function validateToolInput(
  toolName: string,
  toolInput: Record<string, unknown>,
  statusCallback: StatusCallback
): Promise<void> {
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
        console.warn(`BLOCKED: File access outside allowed paths: ${filePath}`);
        await statusCallback("tool", `Access denied: ${filePath}`);
        throw new Error(`File access blocked: ${filePath}`);
      }
    }
  }
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
  let lastUsage: TokenUsage | null = null;
  let contextWindowUsage: ContextWindowUsage | null = null;
  let contextWindowSize: number | null = null;
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
        await validateToolInput(event.toolName, toolInput, input.statusCallback);

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
      lastUsage = {
        input_tokens: event.usage.inputTokens,
        output_tokens: event.usage.outputTokens,
        cache_read_input_tokens: event.usage.cacheReadInputTokens || 0,
        cache_creation_input_tokens: event.usage.cacheCreationInputTokens || 0,
      };
      if (
        !contextWindowUsage &&
        lastUsage.input_tokens +
          (lastUsage.cache_read_input_tokens || 0) +
          (lastUsage.cache_creation_input_tokens || 0) >
          0
      ) {
        contextWindowUsage = {
          input_tokens: lastUsage.input_tokens,
          cache_creation_input_tokens: lastUsage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: lastUsage.cache_read_input_tokens || 0,
        };
      }
      return;
    }

    if (event.type === "context") {
      contextWindowUsage = {
        input_tokens: event.usedTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      };
      contextWindowSize = event.maxTokens;
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
      contextWindowUsage = refreshedUsage;
    }
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
  let lastCallUsage: TokenUsage | null = null;
  let lastUsage: TokenUsage | null = null;
  let contextWindowUsage: ContextWindowUsage | null = null;
  let contextWindowSize: number | null = null;

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
      };
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
      for (const block of event.message.content) {
        if (block.type === "thinking" && block.thinking) {
          console.log(`THINKING BLOCK: ${block.thinking.slice(0, 100)}...`);
          await input.statusCallback("thinking", block.thinking);
        }

        if (block.type === "tool_use") {
          const toolName = block.name;
          const toolInput = block.input as Record<string, unknown>;
          await validateToolInput(toolName, toolInput, input.statusCallback);

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
      console.log("Response complete");
      closeCurrentTool();
      queryCompleted = true;
      input.onQueryCompleted?.();

      const contextWindowFromClaudeCode = (() => {
        const cw = (event as unknown as { context_window?: unknown }).context_window;
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

        return hasContextWindowUsage(usage)
          ? { usage, size: cw.context_window_size || null }
          : null;
      })();

      if (contextWindowFromClaudeCode) {
        contextWindowUsage = contextWindowFromClaudeCode.usage;
        if (
          typeof contextWindowFromClaudeCode.size === "number" &&
          contextWindowFromClaudeCode.size > 0
        ) {
          contextWindowSize = contextWindowFromClaudeCode.size;
        }
      } else if (lastCallUsage) {
        const usage = {
          input_tokens: lastCallUsage.input_tokens || 0,
          cache_creation_input_tokens: lastCallUsage.cache_creation_input_tokens || 0,
          cache_read_input_tokens: lastCallUsage.cache_read_input_tokens || 0,
        };
        if (hasContextWindowUsage(usage)) {
          contextWindowUsage = usage;
        }
      } else if ("usage" in event && event.usage) {
        const u = event.usage as unknown as TokenUsage;
        const usage = {
          input_tokens: u.input_tokens || 0,
          cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
          cache_read_input_tokens: u.cache_read_input_tokens || 0,
        };
        if (hasContextWindowUsage(usage)) {
          contextWindowUsage = usage;
        }
      }

      const refreshedUsage = await input.onRefreshContextWindowUsageFromTranscript(
        input.queryStartedMs
      );
      if (refreshedUsage) {
        contextWindowUsage = refreshedUsage;
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

        if (detectedContextWindow > 0) {
          contextWindowSize = detectedContextWindow;
        }

        lastUsage = {
          input_tokens: totalIn,
          output_tokens: totalOut,
          cache_read_input_tokens: totalCacheRead,
          cache_creation_input_tokens: totalCacheCreate,
        };

        if (!contextWindowUsage && totalIn + totalCacheRead + totalCacheCreate > 0) {
          contextWindowUsage = {
            input_tokens: totalIn,
            cache_creation_input_tokens: totalCacheCreate,
            cache_read_input_tokens: totalCacheRead,
          };
        }
      } else if ("usage" in event && event.usage) {
        lastUsage = event.usage as TokenUsage;
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
