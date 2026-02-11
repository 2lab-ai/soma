import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { ClaudeSession } from "./core/session/session";
import { ProviderOrchestrator } from "./providers/orchestrator";
import { ProviderRegistry } from "./providers/registry";
import type {
  ProviderBoundary,
  ProviderEventHandler,
  ProviderQueryHandle,
  ProviderQueryInput,
  ProviderResumeInput,
  ProviderResumeResult,
} from "./providers/types.models";

class CaptureProvider implements ProviderBoundary {
  readonly providerId = "anthropic";
  readonly capabilities = {
    supportsResume: true,
    supportsMidStreamInjection: false,
    supportsToolStreaming: false,
  };

  lastInput: ProviderQueryInput | null = null;

  async startQuery(input: ProviderQueryInput): Promise<ProviderQueryHandle> {
    this.lastInput = input;
    return {
      queryId: input.queryId,
      providerSessionId: `sess-${input.queryId}`,
    };
  }

  async streamEvents(
    handle: ProviderQueryHandle,
    onEvent: ProviderEventHandler
  ): Promise<void> {
    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "session",
      providerSessionId: handle.providerSessionId || `sess-${handle.queryId}`,
      resumed: false,
    });
    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "text",
      delta: "ok",
    });
    await onEvent({
      providerId: this.providerId,
      queryId: handle.queryId,
      timestamp: Date.now(),
      type: "done",
      reason: "completed",
    });
  }

  async abortQuery(_handle: ProviderQueryHandle): Promise<void> {}

  async resumeSession(input: ProviderResumeInput): Promise<ProviderResumeResult> {
    return { providerSessionId: input.providerSessionId, resumed: true };
  }
}

describe("ClaudeSession runtime cwd selection", () => {
  test("uses session.workingDir for provider query workingDirectory", async () => {
    const customWorkingDir = mkdtempSync(resolve(tmpdir(), "session-working-dir-"));
    mkdirSync(customWorkingDir, { recursive: true });

    const provider = new CaptureProvider();
    const registry = new ProviderRegistry();
    registry.register(provider);
    const orchestrator = new ProviderOrchestrator(registry);

    const session = new ClaudeSession("cron:scheduler:heartbeat", null, {
      workingDir: customWorkingDir,
      providerOrchestrator: orchestrator,
    });

    try {
      await session.sendMessageStreaming("check cwd", async () => {}, 1, "cron");
      expect(provider.lastInput).not.toBeNull();
      expect(provider.lastInput?.workingDirectory).toBe(customWorkingDir);
    } finally {
      rmSync(customWorkingDir, { recursive: true, force: true });
    }
  });
});
