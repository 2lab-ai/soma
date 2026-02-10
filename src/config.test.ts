import { describe, expect, it } from "bun:test";
import {
  SYS_MSG_PREFIX,
  CHAT_HISTORY_DATA_DIR,
  WORKING_DIR,
  MCP_SERVERS,
} from "./config";

describe("config", () => {
  describe("SYS_MSG_PREFIX", () => {
    it("should be ⚡️ emoji for system messages", () => {
      expect(SYS_MSG_PREFIX).toBe("⚡️");
    });
  });

  describe("CHAT_HISTORY_DATA_DIR", () => {
    it("should be based on WORKING_DIR, not project directory", () => {
      expect(CHAT_HISTORY_DATA_DIR).toContain(WORKING_DIR);
      expect(CHAT_HISTORY_DATA_DIR).toContain(".db/chat-history");
      expect(CHAT_HISTORY_DATA_DIR).toBe(`${WORKING_DIR}/.db/chat-history`);
    });

    it("should NOT be relative 'data' path", () => {
      expect(CHAT_HISTORY_DATA_DIR).not.toBe("data");
      expect(CHAT_HISTORY_DATA_DIR).not.toMatch(/^data$/);
    });
  });

  describe("MCP_SERVERS chat-history", () => {
    it("should have CHAT_HISTORY_DATA_DIR env injected", () => {
      const chatHistory = MCP_SERVERS["chat-history"];
      if (!chatHistory || !("env" in chatHistory)) return;
      expect(chatHistory.env).toBeDefined();
      expect(chatHistory.env?.CHAT_HISTORY_DATA_DIR).toBe(
        `${WORKING_DIR}/.db/chat-history`
      );
    });

    it("should use WORKING_DIR, not project directory", () => {
      const chatHistory = MCP_SERVERS["chat-history"];
      if (!chatHistory || !("env" in chatHistory)) return;
      const dataDir = chatHistory.env?.CHAT_HISTORY_DATA_DIR;
      expect(dataDir).not.toContain("/soma/data");
      expect(dataDir).toContain(WORKING_DIR);
    });
  });
});
