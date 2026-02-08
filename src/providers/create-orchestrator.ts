import { ClaudeProviderAdapter } from "./claude-adapter";
import { CodexProviderAdapter } from "./codex-adapter";
import { ProviderOrchestrator } from "./orchestrator";
import { ProviderRegistry } from "./registry";

export function createProviderOrchestrator(): ProviderOrchestrator {
  const registry = new ProviderRegistry();
  const orchestrator = new ProviderOrchestrator(registry);
  orchestrator.registerProvider(new ClaudeProviderAdapter());
  orchestrator.registerProvider(new CodexProviderAdapter());
  return orchestrator;
}
