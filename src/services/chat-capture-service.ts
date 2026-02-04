/**
 * ChatCaptureService - Captures conversation messages to storage
 *
 * Converts Telegram/Claude messages to ChatRecord format and persists them.
 */

import type { ChatRecord, IChatStorage, SessionReference } from "../types/chat-history";
import { randomUUID } from "crypto";

export interface CaptureMessageOptions {
  sessionId: string;
  claudeSessionId: string;
  model: string;
  speaker: ChatRecord["speaker"];
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  thinkingSummary?: string;
  tokenUsage?: {
    input: number;
    output: number;
  };
}

export class ChatCaptureService {
  constructor(private storage: IChatStorage) {}

  /**
   * Capture a single message
   */
  async captureMessage(options: CaptureMessageOptions): Promise<void> {
    try {
      const record: ChatRecord = {
        id: randomUUID(),
        sessionId: options.sessionId,
        claudeSessionId: options.claudeSessionId,
        model: options.model,
        timestamp: new Date().toISOString(),
        speaker: options.speaker,
        content: options.content,
        toolName: options.toolName,
        toolInput: options.toolInput,
        thinkingSummary: options.thinkingSummary,
        tokenUsage: options.tokenUsage,
      };

      await this.storage.saveChat(record);
    } catch (error) {
      console.error("[ChatCaptureService] Failed to capture message:", error);
      // Don't throw - we don't want capture failures to break the bot
    }
  }

  /**
   * Capture a batch of messages (more efficient for multiple messages)
   */
  async captureMessages(messages: CaptureMessageOptions[]): Promise<void> {
    if (messages.length === 0) return;

    try {
      const records: ChatRecord[] = messages.map((msg) => ({
        id: randomUUID(),
        sessionId: msg.sessionId,
        claudeSessionId: msg.claudeSessionId,
        model: msg.model,
        timestamp: new Date().toISOString(),
        speaker: msg.speaker,
        content: msg.content,
        toolName: msg.toolName,
        toolInput: msg.toolInput,
        thinkingSummary: msg.thinkingSummary,
        tokenUsage: msg.tokenUsage,
      }));

      await this.storage.saveBatch(records);
    } catch (error) {
      console.error("[ChatCaptureService] Failed to capture batch:", error);
    }
  }

  /**
   * Capture a user message
   */
  async captureUserMessage(
    sessionId: string,
    claudeSessionId: string,
    model: string,
    content: string
  ): Promise<void> {
    await this.captureMessage({
      sessionId,
      claudeSessionId,
      model,
      speaker: "user",
      content,
    });
  }

  /**
   * Capture an assistant message
   */
  async captureAssistantMessage(
    sessionId: string,
    claudeSessionId: string,
    model: string,
    content: string,
    options?: {
      thinkingSummary?: string;
      tokenUsage?: { input: number; output: number };
    }
  ): Promise<void> {
    await this.captureMessage({
      sessionId,
      claudeSessionId,
      model,
      speaker: "assistant",
      content,
      thinkingSummary: options?.thinkingSummary,
      tokenUsage: options?.tokenUsage,
    });
  }

  /**
   * Capture a tool execution
   */
  async captureToolExecution(
    sessionId: string,
    claudeSessionId: string,
    model: string,
    toolName: string,
    toolInput: Record<string, unknown>,
    result: string
  ): Promise<void> {
    await this.captureMessage({
      sessionId,
      claudeSessionId,
      model,
      speaker: "tool",
      content: result,
      toolName,
      toolInput,
    });
  }

  /**
   * Save a session reference
   */
  async saveSessionReference(ref: SessionReference): Promise<void> {
    try {
      await this.storage.saveSessionReference(ref);
    } catch (error) {
      console.error("[ChatCaptureService] Failed to save session reference:", error);
    }
  }

  /**
   * Get a session reference
   */
  async getSessionReference(sessionId: string): Promise<SessionReference | null> {
    try {
      return await this.storage.getSessionReference(sessionId);
    } catch (error) {
      console.error("[ChatCaptureService] Failed to get session reference:", error);
      return null;
    }
  }
}
