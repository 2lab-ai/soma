export interface ProviderRetryPolicy {
  maxRetries: number;
  baseBackoffMs: number;
}

export type ProviderRetryPolicyMap = Record<string, ProviderRetryPolicy>;

export function createDefaultRetryPolicies(): ProviderRetryPolicyMap {
  return {
    anthropic: { maxRetries: 1, baseBackoffMs: 200 },
    codex: { maxRetries: 0, baseBackoffMs: 100 },
  };
}

export function mergeRetryPolicies(
  overrides?: Partial<ProviderRetryPolicyMap>
): ProviderRetryPolicyMap {
  const merged = createDefaultRetryPolicies();
  for (const [providerId, policy] of Object.entries(overrides ?? {})) {
    if (!policy) {
      continue;
    }
    merged[providerId] = policy;
  }
  return merged;
}
