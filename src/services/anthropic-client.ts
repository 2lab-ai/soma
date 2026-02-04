const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-3-5-haiku-20241022";
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_MAX_TOKENS = 1024;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeout?: number;
  maxTokens?: number;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface CompletionResponse {
  id: string;
  content: string;
  model: string;
  stopReason: string | null;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export interface AnthropicError {
  type: string;
  message: string;
  status?: number;
}

export class AnthropicClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private timeout: number;
  private maxTokens: number;

  constructor(config: AnthropicConfig) {
    if (!config.apiKey) {
      throw new Error("Anthropic API key is required");
    }

    this.apiKey = config.apiKey;
    this.model = config.model || DEFAULT_MODEL;
    this.baseUrl = config.baseUrl || DEFAULT_BASE_URL;
    this.timeout = config.timeout || DEFAULT_TIMEOUT;
    this.maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.executeRequest(request);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));

        if (!this.isRetryable(lastError)) {
          throw lastError;
        }

        if (attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.warn(
            `[AnthropicClient] Retry ${attempt + 1}/${MAX_RETRIES} after ${backoff}ms: ${lastError.message}`
          );
          await this.sleep(backoff);
        }
      }
    }

    throw lastError || new Error("Max retries exceeded");
  }

  private async executeRequest(request: CompletionRequest): Promise<CompletionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const body = {
        model: this.model,
        max_tokens: request.maxTokens || this.maxTokens,
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        ...(request.system && { system: request.system }),
        ...(request.temperature !== undefined && { temperature: request.temperature }),
      };

      const response = await fetch(`${this.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        let parsed: { error?: { type?: string; message?: string } } = {};
        try {
          parsed = JSON.parse(errorBody);
        } catch {
          // ignore parse error
        }

        const error: AnthropicError = {
          type: parsed.error?.type || "api_error",
          message: parsed.error?.message || errorBody || response.statusText,
          status: response.status,
        };

        throw new Error(`Anthropic API error [${response.status}]: ${error.message}`);
      }

      const data = await response.json();

      return {
        id: data.id,
        content: data.content?.[0]?.text || "",
        model: data.model,
        stopReason: data.stop_reason,
        usage: {
          inputTokens: data.usage?.input_tokens || 0,
          outputTokens: data.usage?.output_tokens || 0,
        },
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private isRetryable(error: Error): boolean {
    const message = error.message.toLowerCase();

    if (message.includes("429") || message.includes("rate limit")) {
      return true;
    }
    if (message.includes("500") || message.includes("502") || message.includes("503")) {
      return true;
    }
    if (message.includes("timeout") || message.includes("abort")) {
      return true;
    }
    if (message.includes("econnreset") || message.includes("network")) {
      return true;
    }

    return false;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async summarize(content: string, options?: { maxTokens?: number }): Promise<string> {
    const response = await this.complete({
      system: `You are a concise summarizer. Create brief, factual summaries that capture key points, decisions, and action items. Use bullet points for clarity. Keep summaries under 500 words.`,
      messages: [
        {
          role: "user",
          content: `Summarize the following conversation:\n\n${content}`,
        },
      ],
      maxTokens: options?.maxTokens || 1024,
      temperature: 0.3,
    });

    return response.content;
  }
}

let defaultClient: AnthropicClient | null = null;

export function getAnthropicClient(): AnthropicClient {
  if (!defaultClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable is required");
    }
    defaultClient = new AnthropicClient({ apiKey });
  }
  return defaultClient;
}

export function createAnthropicClient(config: AnthropicConfig): AnthropicClient {
  return new AnthropicClient(config);
}
