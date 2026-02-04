import { randomUUID } from "crypto";
import type {
  Summary,
  SummaryGranularity,
  ChatRecord,
  IChatStorage,
  ISummaryStorage,
} from "../types/chat-history";
import { AnthropicClient, createAnthropicClient } from "./anthropic-client";

const MAX_CONTENT_TOKENS = 4000;
const CHARS_PER_TOKEN = 4;
const MAX_CONTENT_CHARS = MAX_CONTENT_TOKENS * CHARS_PER_TOKEN;

export interface SummaryGeneratorConfig {
  anthropicApiKey?: string;
  model?: string;
}

export interface GenerateSummaryOptions {
  granularity: SummaryGranularity;
  periodStart: Date;
  periodEnd: Date;
}

export interface GenerateSummaryResult {
  success: boolean;
  summary?: Summary;
  error?: string;
  chatCount: number;
}

export class SummaryGenerator {
  private client: AnthropicClient | null = null;
  private model: string;

  constructor(
    private chatStorage: IChatStorage,
    private summaryStorage: ISummaryStorage,
    config: SummaryGeneratorConfig = {}
  ) {
    this.model = config.model || "claude-3-5-haiku-20241022";

    const apiKey = config.anthropicApiKey || process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = createAnthropicClient({
        apiKey,
        model: this.model,
        maxTokens: 1024,
      });
    }
  }

  async generate(options: GenerateSummaryOptions): Promise<GenerateSummaryResult> {
    const { granularity, periodStart, periodEnd } = options;

    const chats = await this.chatStorage.search({
      from: periodStart,
      to: periodEnd,
      limit: 1000,
    });

    if (chats.length === 0) {
      return {
        success: true,
        chatCount: 0,
        error: "No chats found in period",
      };
    }

    if (!this.client) {
      return {
        success: false,
        chatCount: chats.length,
        error: "Anthropic API key not configured",
      };
    }

    try {
      const content = this.formatChatsForSummary(chats);
      const summaryText = await this.callHaiku(content, granularity);

      const summary: Summary = {
        id: randomUUID(),
        periodStart: periodStart.toISOString(),
        periodEnd: periodEnd.toISOString(),
        granularity,
        model: this.model,
        content: summaryText,
        chatCount: chats.length,
      };

      await this.summaryStorage.saveSummary(summary);

      return {
        success: true,
        summary,
        chatCount: chats.length,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[SummaryGenerator] Failed to generate summary: ${error}`);

      return {
        success: false,
        chatCount: chats.length,
        error,
      };
    }
  }

  async generateHourly(date: Date): Promise<GenerateSummaryResult> {
    const periodStart = new Date(date);
    periodStart.setMinutes(0, 0, 0);

    const periodEnd = new Date(periodStart);
    periodEnd.setHours(periodEnd.getHours() + 1);

    return this.generate({ granularity: "hourly", periodStart, periodEnd });
  }

  async generateDaily(date: Date): Promise<GenerateSummaryResult> {
    const periodStart = new Date(date);
    periodStart.setHours(0, 0, 0, 0);

    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 1);

    return this.generate({ granularity: "daily", periodStart, periodEnd });
  }

  async generateWeekly(date: Date): Promise<GenerateSummaryResult> {
    const periodStart = this.getWeekStart(date);
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + 7);

    return this.generate({ granularity: "weekly", periodStart, periodEnd });
  }

  async generateMonthly(date: Date): Promise<GenerateSummaryResult> {
    const periodStart = new Date(date.getFullYear(), date.getMonth(), 1);
    const periodEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);

    return this.generate({ granularity: "monthly", periodStart, periodEnd });
  }

  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    return d;
  }

  private formatChatsForSummary(chats: ChatRecord[]): string {
    const sorted = [...chats].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    let result = "";

    for (const chat of sorted) {
      const speaker = chat.speaker === "user" ? "User" : "Assistant";
      const time = new Date(chat.timestamp).toLocaleTimeString();

      if (chat.speaker === "tool") {
        continue;
      }

      const line = `[${time}] ${speaker}: ${chat.content}\n`;

      if (result.length + line.length > MAX_CONTENT_CHARS) {
        result += "\n[... truncated for length ...]\n";
        break;
      }

      result += line;
    }

    return result;
  }

  private async callHaiku(content: string, granularity: SummaryGranularity): Promise<string> {
    if (!this.client) {
      throw new Error("Anthropic client not initialized");
    }

    const periodLabel = this.getPeriodLabel(granularity);

    const response = await this.client.complete({
      system: `You are a concise summarizer. Create brief, factual summaries of conversations.
Focus on:
- Key topics discussed
- Decisions made
- Action items or tasks mentioned
- Important information shared

Use bullet points. Keep summaries under 300 words for ${periodLabel} summaries.
If the conversation is technical, mention the main technologies/tools discussed.`,
      messages: [
        {
          role: "user",
          content: `Summarize this ${periodLabel} conversation:\n\n${content}`,
        },
      ],
      maxTokens: 1024,
      temperature: 0.3,
    });

    return response.content;
  }

  private getPeriodLabel(granularity: SummaryGranularity): string {
    switch (granularity) {
      case "hourly":
        return "hourly";
      case "daily":
        return "daily";
      case "weekly":
        return "weekly";
      case "monthly":
        return "monthly";
    }
  }
}
