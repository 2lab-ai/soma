import { ClaudeProviderAdapter } from "./claude-adapter";
import { CodexProviderAdapter } from "./codex-adapter";
import { ProviderOrchestrator } from "./orchestrator";
import { ProviderRegistry } from "./registry";
import type { ProviderRetryPolicyMap } from "./retry-policy";
import type { ProviderBoundary } from "./types.models";

interface CreateProviderOrchestratorOptions {
  providers?: ProviderBoundary[];
  retryPolicies?: Partial<ProviderRetryPolicyMap>;
  registry?: ProviderRegistry;
  sleep?: (ms: number) => Promise<void>;
}

export function createProviderOrchestrator(
  options: CreateProviderOrchestratorOptions = {}
): ProviderOrchestrator {
  const registry = options.registry ?? new ProviderRegistry();
  const orchestrator = new ProviderOrchestrator(registry, {
    retryPolicies: options.retryPolicies,
    sleep: options.sleep,
  });
  const providers = options.providers ?? [
    new ClaudeProviderAdapter(),
    new CodexProviderAdapter(),
  ];
  for (const provider of providers) {
    orchestrator.registerProvider(provider);
  }
  return orchestrator;
}
