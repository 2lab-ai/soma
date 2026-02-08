import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "./types.models";
import { NormalizedProviderError } from "./error-normalizer";

const CODEX_PROVIDER_ENABLED = process.env.CODEX_PROVIDER_ENABLED === "true";

interface ActiveCodexQuery {
  input: ProviderQueryInput;
}

function estimateTokenCount(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words * 1.4));
}

export class CodexProviderAdapter implements ProviderBoundary {
  readonly providerId = "codex";
  readonly capabilities = {
    supportsResume: false,
    supportsMidStreamInjection: false,
    supportsToolStreaming: false,
  };

  private readonly activeQueries = new Map<string, ActiveCodexQuery>();
  private readonly enabled: boolean;

  constructor(enabled: boolean = CODEX_PROVIDER_ENABLED) {
    this.enabled = enabled;
  }

  async startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle> {
    this.activeQueries.set(input.queryId, { input });
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
      throw new NormalizedProviderError(
        this.providerId,
        "INVALID_REQUEST",
        `Unknown query handle: ${handle.queryId}`,
        false
      );
    }

    try {
      if (!this.enabled) {
        throw new NormalizedProviderError(
          this.providerId,
          "INVALID_REQUEST",
          "Codex provider adapter is disabled in this runtime.",
          false
        );
      }

      await onEvent({
        providerId: this.providerId,
        queryId: handle.queryId,
        timestamp: Date.now(),
        type: "session",
        providerSessionId: handle.providerSessionId ?? `codex-${handle.queryId}`,
        resumed: Boolean(handle.providerSessionId),
      });

      await onEvent({
        providerId: this.providerId,
        queryId: handle.queryId,
        timestamp: Date.now(),
        type: "text",
        delta: active.input.prompt,
      });

      const tokenCount = estimateTokenCount(active.input.prompt);
      await onEvent({
        providerId: this.providerId,
        queryId: handle.queryId,
        timestamp: Date.now(),
        type: "usage",
        usage: {
          inputTokens: tokenCount,
          outputTokens: tokenCount,
        },
      });

      await onEvent({
        providerId: this.providerId,
        queryId: handle.queryId,
        timestamp: Date.now(),
        type: "done",
        reason: "completed",
      });
    } finally {
      this.activeQueries.delete(handle.queryId);
    }
  }

  async abortQuery(handle: ProviderQueryHandle): Promise<void> {
    this.activeQueries.delete(handle.queryId);
  }

  async resumeSession(input: ProviderResumeInput): Promise<ProviderResumeResult> {
    return {
      providerSessionId: input.providerSessionId,
      resumed: false,
    };
  }
}
