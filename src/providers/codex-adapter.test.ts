import { describe, expect, test } from "bun:test";
import { CodexProviderAdapter } from "./codex-adapter";
import { createSessionIdentity } from "../routing/session-key";
import type { ProviderEvent } from "./types.models";
import { NormalizedProviderError } from "./error-normalizer";

function createInput(queryId: string) {
  return {
    queryId,
    identity: createSessionIdentity({
      tenantId: "tenant-a",
      channelId: "telegram",
      threadId: "thread-1",
    }),
    prompt: "hello codex",
  };
}

describe("CodexProviderAdapter", () => {
  test("emits normalized text/usage/done events when enabled", async () => {
    const adapter = new CodexProviderAdapter(true);
    const events: ProviderEvent[] = [];
    const handle = await adapter.startQuery(createInput("q1"));
    await adapter.streamEvents(handle, (event) => {
      events.push(event);
    });

    expect(events.map((event) => event.type)).toEqual([
      "session",
      "text",
      "usage",
      "done",
    ]);
    expect(events[1]?.providerId).toBe("codex");
  });

  test("throws normalized error when adapter is disabled", async () => {
    const adapter = new CodexProviderAdapter(false);
    const handle = await adapter.startQuery(createInput("q2"));
    try {
      await adapter.streamEvents(handle, () => {});
      throw new Error("Expected error");
    } catch (error) {
      expect(error instanceof NormalizedProviderError).toBe(true);
      expect((error as NormalizedProviderError).code).toBe("INVALID_REQUEST");
    }
  });
});
