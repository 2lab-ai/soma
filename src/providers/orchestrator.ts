import { normalizeProviderError, type NormalizedProviderError } from "./error-normalizer";
import { ProviderRegistry } from "./registry";
import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryInput,
} from "./types.models";

interface ProviderRetryPolicy {
  maxRetries: number;
  baseBackoffMs: number;
}

interface ExecuteProviderQueryParams {
  primaryProviderId: string;
  fallbackProviderId?: string;
  input: ProviderQueryInput;
  onEvent: ProviderEventHandler;
}

export interface ProviderExecutionResult {
  providerId: string;
  attempts: number;
}

export class ProviderOrchestrator {
  private readonly retryPolicies: Record<string, ProviderRetryPolicy>;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly registry: ProviderRegistry,
    options?: {
      retryPolicies?: Record<string, ProviderRetryPolicy>;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    this.retryPolicies = {
      anthropic: { maxRetries: 1, baseBackoffMs: 200 },
      codex: { maxRetries: 0, baseBackoffMs: 100 },
      ...(options?.retryPolicies ?? {}),
    };
    this.sleep = options?.sleep ?? ((ms) => Bun.sleep(ms));
  }

  registerProvider(provider: ProviderBoundary): void {
    this.registry.register(provider);
  }

  listProviders(): string[] {
    return this.registry.listProviderIds();
  }

  async executeProviderQuery(
    params: ExecuteProviderQueryParams
  ): Promise<ProviderExecutionResult> {
    const chain = [params.primaryProviderId, params.fallbackProviderId].filter(
      (value): value is string => Boolean(value)
    );
    let lastError: NormalizedProviderError | null = null;

    for (const providerId of chain) {
      const provider = this.registry.getOrThrow(providerId);
      const policy = this.getPolicy(providerId);

      for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
        const handle = await provider.startQuery(params.input);

        try {
          await provider.streamEvents(handle, params.onEvent);
          return {
            providerId,
            attempts: attempt + 1,
          };
        } catch (error) {
          const normalized = normalizeProviderError(providerId, error);
          lastError = normalized;

          const canRetry = normalized.retryable && attempt < policy.maxRetries;
          const shouldFallback =
            normalized.code === "RATE_LIMIT" && params.fallbackProviderId !== undefined;

          if (canRetry) {
            const backoffMs = policy.baseBackoffMs * Math.pow(2, attempt);
            await this.sleep(backoffMs);
            continue;
          }

          if (shouldFallback) {
            break;
          }

          throw normalized;
        } finally {
          await provider.abortQuery(handle).catch(() => {});
        }
      }
    }

    if (lastError) {
      throw lastError;
    }

    throw normalizeProviderError(
      params.primaryProviderId,
      new Error(`No provider could execute query: ${params.input.queryId}`)
    );
  }

  private getPolicy(providerId: string): ProviderRetryPolicy {
    return this.retryPolicies[providerId] ?? { maxRetries: 0, baseBackoffMs: 100 };
  }
}
