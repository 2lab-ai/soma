import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { AUDIT_LOG_PATH } from "../config";
import { auditLog, auditLogRateLimit } from "./audit";

function readAuditLog(): string {
  if (!existsSync(AUDIT_LOG_PATH)) {
    return "";
  }
  return readFileSync(AUDIT_LOG_PATH, "utf-8");
}

describe("audit utils", () => {
  test("auditLog writes message event payload", async () => {
    const marker = `audit-message-${Date.now()}`;
    await auditLog(1, "audit-user", "TEXT", marker, "response");

    const content = readAuditLog();
    expect(content).toContain(marker);
    expect(
      content.includes("event: message") || content.includes('"event":"message"')
    ).toBe(true);
  });

  test("auditLogRateLimit writes rate-limit event payload", async () => {
    const markerUser = `audit-rate-${Date.now()}`;
    await auditLogRateLimit(1, markerUser, 1.5);

    const content = readAuditLog();
    expect(content).toContain(markerUser);
    expect(
      content.includes("event: rate_limit") || content.includes('"event":"rate_limit"')
    ).toBe(true);
  });
});
