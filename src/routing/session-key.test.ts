import { describe, expect, test } from "bun:test";
import {
  SessionIdentityInvariantError,
  buildSessionKeyFromInput,
  buildStoragePartitionKeyFromInput,
  createSessionIdentity,
  parseSessionKey,
  parseStoragePartitionKey,
} from "./session-key";

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

describe("session key contract", () => {
  test("builds tenant:channel:thread session key", () => {
    const sessionKey = buildSessionKeyFromInput({
      tenantId: "tenant-a",
      channelId: "telegram-main",
      threadId: "thread-42",
    });

    expect(sessionKey as string).toBe("tenant-a:telegram-main:thread-42");
  });

  test("builds tenant/channel/thread storage partition key", () => {
    const storagePartitionKey = buildStoragePartitionKeyFromInput({
      tenantId: "tenant-a",
      channelId: "telegram-main",
      threadId: "thread-42",
    });

    expect(storagePartitionKey as string).toBe("tenant-a/telegram-main/thread-42");
  });

  test("parses session key and storage partition key into the same identity", () => {
    const fromSession = parseSessionKey("tenant-a:telegram-main:thread-42");
    const fromPartition = parseStoragePartitionKey("tenant-a/telegram-main/thread-42");

    expect(fromSession).toEqual(fromPartition);
  });

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

  test("rejects identity segments with separators", () => {
    const error = expectInvariantError(() =>
      createSessionIdentity({
        tenantId: "tenant:a",
        channelId: "telegram-main",
        threadId: "thread-42",
      })
    );

    expect(error.code).toBe("IDENTITY_CONTAINS_SEPARATOR");
    expect(error.field).toBe("tenantId");
  });

  test("rejects malformed session key format", () => {
    const error = expectInvariantError(() => parseSessionKey("tenant-a:telegram-main"));

    expect(error.code).toBe("SESSION_KEY_INVALID_FORMAT");
    expect(error.field).toBe("sessionKey");
  });
});
