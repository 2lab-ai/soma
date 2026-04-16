import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "./types.models";
import { NormalizedProviderError, normalizeProviderError } from "./error-normalizer";
import { applyModelSpecificOverrides } from "./claude-options";
import { resolveContextWindowSize } from "../core/session/session-helpers";

type ClaudeQueryFactory = (payload: {
  prompt: string;
  options: Options & { abortController: AbortController };
}) => AsyncGenerator<SDKMessage>;

interface ActiveClaudeQuery {
  input: ProviderQueryInput;
  abortController: AbortController;
}

interface ClaudeModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
}

function safeNumber(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function hasUsageData(value: {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}): boolean {
  return (
    value.inputTokens > 0 ||
    value.outputTokens > 0 ||
    (value.cacheReadInputTokens ?? 0) > 0 ||
    (value.cacheCreationInputTokens ?? 0) > 0
  );
}

function toClaudeOptions(
  input: ProviderQueryInput,
  abortController: AbortController
): Options & { abortController: AbortController } {
  const permissionMode =
    input.permissionMode === "bypass" ? "bypassPermissions" : undefined;

  const base: Options & { abortController: AbortController } = {
    model: input.modelId,
    cwd: input.workingDirectory,
    systemPrompt: input.systemPrompt,
    mcpServers: input.mcpServers as Options["mcpServers"],
    maxThinkingTokens: input.maxThinkingTokens,
    additionalDirectories: input.additionalDirectories
      ? [...input.additionalDirectories]
      : undefined,
    resume: input.resumeSessionId,
    permissionMode,
    allowDangerouslySkipPermissions: input.allowDangerouslySkipPermissions ?? true,
    hooks: input.hooks as Options["hooks"],
    pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
    abortController,
  };
  return applyModelSpecificOverrides(input.modelId ?? "", base);
}

export class ClaudeProviderAdapter implements ProviderBoundary {
  readonly providerId = "anthropic";
  readonly capabilities = {
    supportsResume: true,
    supportsMidStreamInjection: true,
    supportsToolStreaming: true,
  };

  private readonly activeQueries = new Map<string, ActiveClaudeQuery>();
  private readonly queryFactory: ClaudeQueryFactory;

  constructor(queryFactory: ClaudeQueryFactory = query) {
    this.queryFactory = queryFactory;
  }

  async startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle> {
    const abortController = input.abortController ?? new AbortController();
    this.activeQueries.set(input.queryId, { input, abortController });
    return {
      queryId: input.queryId,
      providerSessionId: input.resumeSessionId,
    };
  }

  async streamEvents(
    handle: ProviderQueryHandle,
    onEvent: ProviderEventHandler
  ): Promise<void> {
    const active = this.activeQueries.get(handle.queryId);
    if (!active) {
      throw normalizeProviderError(
        this.providerId,
        new Error(`Unknown query handle: ${handle.queryId}`)
      );
    }

    const input = active.input;
    let doneEmitted = false;

    try {
      const queryInstance = this.queryFactory({
        prompt: input.prompt,
        options: toClaudeOptions(input, active.abortController),
      });
      let sdkBetas: string[] = [];
      let sawAssistantTurnUsage = false;
      let latestAssistantTurnUsage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadInputTokens?: number;
        cacheCreationInputTokens?: number;
      } | null = null;
      // Accumulate streamed text so we can include it in error context
      // when SDK returns an error result with empty errors array.
      let accumulatedText = "";

      for await (const event of queryInstance) {
        const timestamp = Date.now();

        if (event.session_id) {
          await onEvent({
            providerId: this.providerId,
            queryId: handle.queryId,
            timestamp,
            type: "session",
            providerSessionId: event.session_id,
            resumed: Boolean(input.resumeSessionId),
          });
        }

        if (event.type === "system") {
          const systemEvent = event as { subtype?: string; betas?: unknown };
          if (systemEvent.subtype === "init" && Array.isArray(systemEvent.betas)) {
            sdkBetas = systemEvent.betas.filter(
              (beta): beta is string => typeof beta === "string"
            );
          }
          continue;
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
            const usageRecord = usage as Record<string, unknown>;
            const normalizedUsage = {
              inputTokens: safeNumber(usageRecord.input_tokens),
              outputTokens: safeNumber(usageRecord.output_tokens),
              cacheReadInputTokens: safeNumber(usageRecord.cache_read_input_tokens),
              cacheCreationInputTokens: safeNumber(
                usageRecord.cache_creation_input_tokens
              ),
            };
            if (hasUsageData(normalizedUsage)) {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp,
                type: "usage",
                usage: {
                  ...normalizedUsage,
                  usageKind: "assistant_turn",
                },
              });
              sawAssistantTurnUsage = true;
              latestAssistantTurnUsage = normalizedUsage;
            }
          }
          continue;
        }

        if (event.type === "assistant") {
          const assistantUsage = event.message?.usage;
          if (
            !sawAssistantTurnUsage &&
            assistantUsage &&
            typeof assistantUsage === "object"
          ) {
            const usageRecord = assistantUsage as Record<string, unknown>;
            const normalizedUsage = {
              inputTokens: safeNumber(usageRecord.input_tokens),
              outputTokens: safeNumber(usageRecord.output_tokens),
              cacheReadInputTokens: safeNumber(usageRecord.cache_read_input_tokens),
              cacheCreationInputTokens: safeNumber(
                usageRecord.cache_creation_input_tokens
              ),
            };
            if (hasUsageData(normalizedUsage)) {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp,
                type: "usage",
                usage: {
                  ...normalizedUsage,
                  usageKind: "assistant_turn",
                },
              });
              sawAssistantTurnUsage = true;
              latestAssistantTurnUsage = normalizedUsage;
            }
          }

          for (const block of event.message.content) {
            if (block.type === "tool_use") {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "tool",
                toolName: block.name,
                phase: "start",
                payload: block.input,
              });
              continue;
            }
            if (block.type === "text") {
              accumulatedText += block.text;
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "text",
                delta: block.text,
              });
            }
          }
          continue;
        }

        if (event.type === "result") {
          // Detect SDK error result variants
          const resultSubtype = (event as unknown as { subtype?: string }).subtype;
          const resultErrors = (event as unknown as { errors?: string[] }).errors;
          const resultIsError = (event as unknown as { is_error?: boolean }).is_error;
          // Allowlist of known SDK error subtypes — safer than denylist as
          // future benign subtypes won't be misclassified as failures.
          const SDK_ERROR_SUBTYPES = new Set([
            "error_during_execution",
            "error_max_turns",
            "error_tool_execution",
            "error_max_budget_usd",
            "error_max_structured_output_retries",
          ]);
          const isErrorResult = resultSubtype !== undefined && (
            SDK_ERROR_SUBTYPES.has(resultSubtype) || resultIsError === true
          );

          if (isErrorResult) {
            console.error(`[SDK-RESULT-ERROR] provider=${this.providerId}, subtype=${resultSubtype}, is_error=${resultIsError}, errors=${JSON.stringify(resultErrors ?? [])}`);
          }

          if ("modelUsage" in event && event.modelUsage) {
            const modelUsage = event.modelUsage as Record<string, ClaudeModelUsage>;
            let totalInput = 0;
            let totalOutput = 0;
            let totalCacheRead = 0;
            let totalCacheCreate = 0;
            let contextWindow = 0;

            for (const usage of Object.values(modelUsage)) {
              totalInput += safeNumber(usage?.inputTokens);
              totalOutput += safeNumber(usage?.outputTokens);
              totalCacheRead += safeNumber(usage?.cacheReadInputTokens);
              totalCacheCreate += safeNumber(usage?.cacheCreationInputTokens);
              contextWindow = Math.max(contextWindow, safeNumber(usage?.contextWindow));
            }

            const normalizedUsage = {
              inputTokens: totalInput,
              outputTokens: totalOutput,
              cacheReadInputTokens: totalCacheRead,
              cacheCreationInputTokens: totalCacheCreate,
            };
            if (hasUsageData(normalizedUsage)) {
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "usage",
                usage: {
                  ...normalizedUsage,
                  usageKind: "aggregate",
                },
              });
            }

            const resolvedContextWindow = resolveContextWindowSize({
              sdkWindow: contextWindow,
              model: input.modelId,
              betas: sdkBetas,
            });

            if (resolvedContextWindow && hasUsageData(normalizedUsage)) {
              const currentUsage = latestAssistantTurnUsage ?? normalizedUsage;
              await onEvent({
                providerId: this.providerId,
                queryId: handle.queryId,
                timestamp: Date.now(),
                type: "context",
                usedTokens:
                  safeNumber(currentUsage.inputTokens) +
                  safeNumber(currentUsage.outputTokens) +
                  safeNumber(currentUsage.cacheReadInputTokens) +
                  safeNumber(currentUsage.cacheCreationInputTokens),
                maxTokens: resolvedContextWindow,
              });
            }
          }

          // Set flag BEFORE await to prevent duplicate done emission
          // even if onEvent throws partway through processing.
          doneEmitted = true;
          await onEvent({
            providerId: this.providerId,
            queryId: handle.queryId,
            timestamp: Date.now(),
            type: "done",
            reason: isErrorResult ? "failed" : "completed",
            ...(isErrorResult && resultErrors?.length
              ? { errorMessage: resultErrors.join("; ") }
              : {}),
          });

          // Throw on error results so callers (query-flow.ts) can handle
          // through normal error pipeline (rate-limit, retry, etc.)
          if (isErrorResult) {
            // Build error message with maximum context for downstream classification.
            // When errors[] is empty (common with rate-limit results where subtype="success"
            // but is_error=true), fall back to accumulated streamed text which often
            // contains the actual error description (e.g. "You're out of extra usage").
            let errorMsg: string;
            if (resultErrors?.length) {
              errorMsg = resultErrors.join("; ");
            } else if (accumulatedText.trim()) {
              const snippet = accumulatedText.trim().slice(-500);
              errorMsg = `SDK result error (${resultSubtype}): ${snippet}`;
            } else {
              errorMsg = `SDK result error: ${resultSubtype}`;
            }
            // Preserve SDK fields on the error object so extractErrorDetails
            // can pick them up downstream (not just a plain Error).
            const sdkError = Object.assign(new Error(errorMsg), {
              errors: resultErrors ?? [],
              subtype: resultSubtype,
              is_error: resultIsError,
            });
            throw normalizeProviderError(
              this.providerId,
              sdkError
            );
          }
        }
      }
    } catch (error) {
      // If done:failed was already emitted from error result path, skip duplicate
      if (doneEmitted) {
        const normalizedError = error instanceof NormalizedProviderError
          ? error
          : normalizeProviderError(this.providerId, error);
        throw normalizedError;
      }

      const normalizedError = normalizeProviderError(this.providerId, error);

      if (normalizedError.code === "RATE_LIMIT") {
        await onEvent({
          providerId: this.providerId,
          queryId: handle.queryId,
          timestamp: Date.now(),
          type: "rate_limit",
          statusCode: normalizedError.statusCode,
        });
      }

      await onEvent({
        providerId: this.providerId,
        queryId: handle.queryId,
        timestamp: Date.now(),
        type: "done",
        reason: "failed",
        errorMessage: normalizedError.message,
      });
      throw normalizedError;
    } finally {
      this.activeQueries.delete(handle.queryId);
    }
  }

  async abortQuery(handle: ProviderQueryHandle): Promise<void> {
    const active = this.activeQueries.get(handle.queryId);
    if (active) {
      active.abortController.abort();
      this.activeQueries.delete(handle.queryId);
    }
  }

  async resumeSession(input: ProviderResumeInput): Promise<ProviderResumeResult> {
    return {
      providerSessionId: input.providerSessionId,
      resumed: true,
    };
  }
}
