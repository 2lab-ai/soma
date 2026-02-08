import { describe, expect, test } from "bun:test";
import { parseSessionKey, parseStoragePartitionKey } from "../routing/session-key";
import { buildSchedulerRoute } from "./route";

describe("buildSchedulerRoute", () => {
  test("creates contract-safe tenant/channel/thread keys", () => {
    const route = buildSchedulerRoute("Daily Report (Main)");

    expect(route.identity.tenantId as string).toBe("cron");
    expect(route.identity.channelId as string).toBe("scheduler");
    expect(route.identity.threadId as string).toBe("daily-report-main");

    expect(parseSessionKey(route.sessionKey as string)).toEqual(route.identity);
    expect(parseStoragePartitionKey(route.storagePartitionKey as string)).toEqual(
      route.identity
    );
  });

  test("falls back to stable thread id when schedule name is blank", () => {
    const route = buildSchedulerRoute("   ");
    expect(route.identity.threadId as string).toBe("job");
  });
});
