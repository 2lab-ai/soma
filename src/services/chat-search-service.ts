/**
 * ChatSearchService - High-level API for searching conversation history
 *
 * Provides convenient methods for common search patterns.
 */

import type {
  ChatRecord,
  IChatStorage,
  ChatSearchOptions,
} from "../types/chat-history";

export interface SearchByDateRangeOptions {
  from: Date;
  to: Date;
  query?: string;
  speaker?: ChatRecord["speaker"];
  limit?: number;
  offset?: number;
}

export interface SearchRecentOptions {
  lastNDays?: number;
  lastNHours?: number;
  query?: string;
  speaker?: ChatRecord["speaker"];
  limit?: number;
}

export interface SearchAroundTimestampOptions {
  timestamp: Date;
  beforeMinutes?: number;
  afterMinutes?: number;
}

export class ChatSearchService {
  constructor(private storage: IChatStorage) {}

  /**
   * Search messages within a specific date range
   */
  async searchByDateRange(options: SearchByDateRangeOptions): Promise<ChatRecord[]> {
    return await this.storage.search({
      from: options.from,
      to: options.to,
      query: options.query,
      speaker: options.speaker,
      limit: options.limit || 100,
      offset: options.offset || 0,
    });
  }

  /**
   * Search recent messages (last N days or hours)
   */
  async searchRecent(options: SearchRecentOptions = {}): Promise<ChatRecord[]> {
    const now = new Date();
    const from = new Date(now);

    if (options.lastNHours) {
      from.setHours(from.getHours() - options.lastNHours);
    } else {
      const days = options.lastNDays || 7; // Default: last 7 days
      from.setDate(from.getDate() - days);
    }

    return await this.storage.search({
      from,
      to: now,
      query: options.query,
      speaker: options.speaker,
      limit: options.limit || 100,
    });
  }

  /**
   * Get messages around a specific timestamp (context window)
   */
  async getContextAround(options: SearchAroundTimestampOptions): Promise<ChatRecord[]> {
    const beforeMinutes = options.beforeMinutes || 5;
    const afterMinutes = options.afterMinutes || 5;

    return await this.storage.getContextAround(
      options.timestamp,
      beforeMinutes,
      afterMinutes
    );
  }

  /**
   * Search for messages containing specific keywords
   */
  async searchByKeyword(
    keyword: string,
    options: {
      lastNDays?: number;
      speaker?: ChatRecord["speaker"];
      limit?: number;
    } = {}
  ): Promise<ChatRecord[]> {
    const days = options.lastNDays || 30; // Default: last 30 days
    const from = new Date();
    from.setDate(from.getDate() - days);

    return await this.storage.search({
      from,
      to: new Date(),
      query: keyword,
      speaker: options.speaker,
      limit: options.limit || 50,
    });
  }

  /**
   * Get all user messages in a date range
   */
  async getUserMessages(from: Date, to: Date, limit = 100): Promise<ChatRecord[]> {
    return await this.storage.search({
      from,
      to,
      speaker: "user",
      limit,
    });
  }

  /**
   * Get all assistant messages in a date range
   */
  async getAssistantMessages(from: Date, to: Date, limit = 100): Promise<ChatRecord[]> {
    return await this.storage.search({
      from,
      to,
      speaker: "assistant",
      limit,
    });
  }

  /**
   * Get conversation summary (user + assistant messages) for a date range
   */
  async getConversation(
    from: Date,
    to: Date,
    limit = 200
  ): Promise<{ user: ChatRecord[]; assistant: ChatRecord[] }> {
    const allMessages = await this.storage.search({
      from,
      to,
      limit,
    });

    return {
      user: allMessages.filter((m) => m.speaker === "user"),
      assistant: allMessages.filter((m) => m.speaker === "assistant"),
    };
  }

  /**
   * Search within a specific session
   */
  async searchInSession(
    sessionId: string,
    options: {
      query?: string;
      speaker?: ChatRecord["speaker"];
      limit?: number;
    } = {}
  ): Promise<ChatRecord[]> {
    // Get broad date range (last 30 days)
    const from = new Date();
    from.setDate(from.getDate() - 30);

    return await this.storage.search({
      from,
      to: new Date(),
      sessionId,
      query: options.query,
      speaker: options.speaker,
      limit: options.limit || 100,
    });
  }

  /**
   * Get the most recent N messages
   */
  async getMostRecent(count: number): Promise<ChatRecord[]> {
    const from = new Date();
    from.setDate(from.getDate() - 7); // Look back 7 days

    return await this.storage.search({
      from,
      to: new Date(),
      limit: count,
    });
  }
}
