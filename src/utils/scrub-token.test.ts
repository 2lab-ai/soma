import { describe, it, expect } from "bun:test";
import { scrubBotToken } from "./scrub-token";

describe("scrubBotToken", () => {
  it("scrubs token from error message", () => {
    const token = "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11";
    const err = new Error(`Failed to call https://api.telegram.org/bot${token}/sendMessage`);
    const result = scrubBotToken(err, token);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("scrubs token from plain string", () => {
    const token = "987654:XYZ-secret-token";
    const result = scrubBotToken(`Request failed with token ${token} in URL`, token);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });

  it("handles non-Error throwable (number)", () => {
    const token = "abc123token";
    const result = scrubBotToken(42, token);
    expect(typeof result).toBe("string");
    expect(result).toBe("42");
  });

  it("handles non-Error throwable (object)", () => {
    const token = "abc123token";
    const obj = { code: 500 };
    const result = scrubBotToken(obj, token);
    expect(typeof result).toBe("string");
    expect(result).toBe("[object Object]");
  });

  it("empty token returns original string", () => {
    const result = scrubBotToken("some error message", "");
    expect(result).toBe("some error message");
  });

  it("no token present returns original string", () => {
    const token = "mysecrettoken";
    const result = scrubBotToken("some error message without token", token);
    expect(result).toBe("some error message without token");
  });

  it("scrubs multiple occurrences of the same token", () => {
    const token = "123456:MULTI-TOKEN";
    const input = `url1: https://api.telegram.org/bot${token}/send, url2: https://api.telegram.org/bot${token}/get`;
    const result = scrubBotToken(input, token);
    expect(result).not.toContain(token);
    expect(result.match(/\[REDACTED\]/g)?.length).toBe(2);
  });

  it("scrubs token from Error.name", () => {
    const token = "789012:NAME-TOKEN";
    const err = new Error("some message");
    err.name = `TelegramError_${token}`;
    const result = scrubBotToken(err, token);
    expect(result).not.toContain(token);
    expect(result).toContain("[REDACTED]");
  });
});
