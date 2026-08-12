import { describe, test, expect } from "bun:test";
import { parseLlmuxStatus } from "./usage";

function account(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "a@example.com",
    group: "claude",
    status: "ok",
    order: 1,
    five_hour: { utilization: 0.31, resets_in_secs: 100 },
    seven_day: { utilization: 0.2, resets_in_secs: 1000 },
    ...overrides,
  };
}

describe("parseLlmuxStatus", () => {
  test("scales 0..1 utilization to 0..100 and rounds (5h: 0.1, 7d: int)", () => {
    const usage = parseLlmuxStatus({
      current_by_group: { claude: "a@example.com" },
      accounts: [account({ five_hour: { utilization: 0.3141 }, seven_day: { utilization: 0.207 } })],
    });
    expect(usage).toEqual({
      fiveHour: 31.4,
      sevenDay: 21,
      account: "a@example.com",
      poolOk: 1,
      poolTotal: 1,
    });
  });

  test("prefers the current claude slot over lower-order accounts", () => {
    const usage = parseLlmuxStatus({
      current_by_group: { claude: "b@example.com" },
      accounts: [
        account({ name: "a@example.com", order: 1 }),
        account({ name: "b@example.com", order: 5, five_hour: { utilization: 0.5 } }),
      ],
    });
    expect(usage?.account).toBe("b@example.com");
    expect(usage?.fiveHour).toBe(50);
  });

  test("falls back to lowest-order account with a live 5h window", () => {
    const usage = parseLlmuxStatus({
      current_by_group: {},
      accounts: [
        account({ name: "no-window@example.com", order: 1, five_hour: null }),
        account({ name: "picked@example.com", order: 2 }),
        account({ name: "later@example.com", order: 3 }),
      ],
    });
    expect(usage?.account).toBe("picked@example.com");
  });

  test("current without a 5h window falls through to fallback", () => {
    const usage = parseLlmuxStatus({
      current_by_group: { claude: "cur@example.com" },
      accounts: [
        account({ name: "cur@example.com", order: 1, five_hour: null }),
        account({ name: "fb@example.com", order: 2 }),
      ],
    });
    expect(usage?.account).toBe("fb@example.com");
  });

  test("counts pool availability over claude group only (active|ok)", () => {
    const usage = parseLlmuxStatus({
      current_by_group: { claude: "a@example.com" },
      accounts: [
        account({ name: "a@example.com", status: "active" }),
        account({ name: "b@example.com", status: "ok" }),
        account({ name: "c@example.com", status: "cooldown" }),
        account({ name: "d@example.com", status: "auth_failed" }),
        account({ name: "codex-1", group: "codex", status: "ok" }),
      ],
    });
    expect(usage?.poolOk).toBe(2);
    expect(usage?.poolTotal).toBe(4);
  });

  test("missing seven_day window renders as 0", () => {
    const usage = parseLlmuxStatus({
      accounts: [account({ seven_day: null })],
    });
    expect(usage?.sevenDay).toBe(0);
  });

  test("returns null on malformed payloads and empty pools", () => {
    expect(parseLlmuxStatus(null)).toBeNull();
    expect(parseLlmuxStatus("nope")).toBeNull();
    expect(parseLlmuxStatus({})).toBeNull();
    expect(parseLlmuxStatus({ accounts: [] })).toBeNull();
    expect(
      parseLlmuxStatus({ accounts: [account({ group: "codex" })] })
    ).toBeNull();
    expect(
      parseLlmuxStatus({ accounts: [account({ five_hour: null })] })
    ).toBeNull();
  });
});
