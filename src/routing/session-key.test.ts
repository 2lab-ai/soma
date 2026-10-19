import { describe, expect, test } from "bun:test";
import {
  SessionIdentityInvariantError,
  buildSessionKeyFromInput,
  buildStoragePartitionKeyFromInput,
  createSessionIdentity,
} from "./session-key";
import {
  buildSessionKeyFromInput as buildSessionKeyFromInputCore,
  buildStoragePartitionKeyFromInput as buildStoragePartitionKeyFromInputCore,
} from "../core/routing/session-key";

function expectInvariantError(fn: () => unknown): SessionIdentityInvariantError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SessionIdentityInvariantError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected SessionIdentityInvariantError");
}

// The generic build/parse/separator/malformed-key cases live in soma-lib's own
// suite (src/domain/session-identity/session-identity.test.ts). This file keeps
// the IDENTITY_EMPTY case and the legacy-shim wiring check.
describe("session key contract", () => {
  test("rejects empty identity segments", () => {
    const error = expectInvariantError(() =>
      createSessionIdentity({
        tenantId: " ",
        channelId: "telegram-main",
        threadId: "thread-42",
      })
    );

    expect(error.code).toBe("IDENTITY_EMPTY");
    expect(error.field).toBe("tenantId");
  });

  test("legacy routing shim matches core routing contract outputs", () => {
    const input = {
      tenantId: "tenant-a",
      channelId: "telegram-main",
      threadId: "thread-42",
    };

    expect(buildSessionKeyFromInput(input)).toBe(buildSessionKeyFromInputCore(input));
    expect(buildStoragePartitionKeyFromInput(input)).toBe(
      buildStoragePartitionKeyFromInputCore(input)
    );
  });
});
