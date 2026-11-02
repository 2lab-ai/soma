import { describe, expect, test } from "bun:test";
import { parseSettingSources, parseTrustMode } from "./env";
import { SETTING_SOURCES } from "./index";

function collectWarnings(): { warn: (message: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (message) => messages.push(message), messages };
}

describe("parseTrustMode (SOMA_TRUST_MODE)", () => {
  test("defaults to standard without a warning", () => {
    const { warn, messages } = collectWarnings();
    expect(parseTrustMode({}, warn)).toBe("standard");
    expect(parseTrustMode({ SOMA_TRUST_MODE: "  " }, warn)).toBe("standard");
    expect(messages).toEqual([]);
  });

  test("accepts standard and owner, trimmed and case-insensitive", () => {
    const { warn, messages } = collectWarnings();
    expect(parseTrustMode({ SOMA_TRUST_MODE: "standard" }, warn)).toBe("standard");
    expect(parseTrustMode({ SOMA_TRUST_MODE: "owner" }, warn)).toBe("owner");
    expect(parseTrustMode({ SOMA_TRUST_MODE: " Owner " }, warn)).toBe("owner");
    expect(messages).toEqual([]);
  });

  test("an unknown value warns once and falls back to standard", () => {
    const { warn, messages } = collectWarnings();
    expect(parseTrustMode({ SOMA_TRUST_MODE: "yolo" }, warn)).toBe("standard");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("SOMA_TRUST_MODE");
    expect(messages[0]).toContain("yolo");
  });
});

describe("parseSettingSources (SOMA_SETTING_SOURCES)", () => {
  test("defaults to no filesystem settings, the SDK isolation the bot ran with", () => {
    const { warn, messages } = collectWarnings();
    expect(parseSettingSources({}, warn)).toEqual([]);
    expect(parseSettingSources({ SOMA_SETTING_SOURCES: " , " }, warn)).toEqual([]);
    expect(messages).toEqual([]);
  });

  test("parses a comma list of user, project and local", () => {
    const { warn, messages } = collectWarnings();
    expect(parseSettingSources({ SOMA_SETTING_SOURCES: "user,project" }, warn)).toEqual(
      ["user", "project"]
    );
    expect(
      parseSettingSources({ SOMA_SETTING_SOURCES: " Local , user ,user" }, warn)
    ).toEqual(["local", "user"]);
    expect(messages).toEqual([]);
  });

  test("drops invalid entries with a warning and keeps the valid ones", () => {
    const { warn, messages } = collectWarnings();
    expect(
      parseSettingSources({ SOMA_SETTING_SOURCES: "user,managed,projects" }, warn)
    ).toEqual(["user"]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("SOMA_SETTING_SOURCES");
    expect(messages[0]).toContain("managed");
    expect(messages[0]).toContain("projects");
  });

  test("the exported SETTING_SOURCES is empty when SOMA_SETTING_SOURCES is unset", () => {
    expect(SETTING_SOURCES).toEqual([]);
  });
});
