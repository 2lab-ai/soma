import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { AnthropicClient, createAnthropicClient } from "./anthropic-client";

const mockFetch = mock(() => Promise.resolve(new Response()));

describe("AnthropicClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = mockFetch;
    mockFetch.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("should throw if API key is missing", () => {
      expect(() => new AnthropicClient({ apiKey: "" })).toThrow("API key is required");
    });

    it("should use default values", () => {
      const client = new AnthropicClient({ apiKey: "test-key" });
      expect(client).toBeDefined();
    });

    it("should accept custom config", () => {
      const client = new AnthropicClient({
        apiKey: "test-key",
        model: "claude-3-opus-20240229",
        baseUrl: "https://custom.api.com",
        timeout: 60000,
        maxTokens: 2048,
      });
      expect(client).toBeDefined();
    });
  });

  describe("complete", () => {
    it("should make API request with correct headers", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "msg_123",
            content: [{ type: "text", text: "Hello!" }],
            model: "claude-3-5-haiku-20241022",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 }
        )
      );

      const client = new AnthropicClient({ apiKey: "test-key" });
      const response = await client.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const call = mockFetch.mock.calls[0];
      expect(call?.[0]).toContain("/v1/messages");
      expect(call?.[1]?.headers).toMatchObject({
        "Content-Type": "application/json",
        "x-api-key": "test-key",
        "anthropic-version": "2023-06-01",
      });
    });

    it("should return parsed response", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "msg_123",
            content: [{ type: "text", text: "Hello!" }],
            model: "claude-3-5-haiku-20241022",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 }
        )
      );

      const client = new AnthropicClient({ apiKey: "test-key" });
      const response = await client.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(response.id).toBe("msg_123");
      expect(response.content).toBe("Hello!");
      expect(response.model).toBe("claude-3-5-haiku-20241022");
      expect(response.usage.inputTokens).toBe(10);
      expect(response.usage.outputTokens).toBe(5);
    });

    it("should include system prompt when provided", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "msg_123",
            content: [{ type: "text", text: "Response" }],
            model: "claude-3-5-haiku-20241022",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200 }
        )
      );

      const client = new AnthropicClient({ apiKey: "test-key" });
      await client.complete({
        messages: [{ role: "user", content: "Hi" }],
        system: "You are a helpful assistant",
      });

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1]?.body as string);
      expect(body.system).toBe("You are a helpful assistant");
    });

    it("should throw on API error", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { type: "invalid_request_error", message: "Bad request" },
          }),
          { status: 400 }
        )
      );

      const client = new AnthropicClient({ apiKey: "test-key" });

      await expect(
        client.complete({ messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("Bad request");
    });

    it("should retry on 429 rate limit", async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Rate limit exceeded" } }), {
            status: 429,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "msg_123",
              content: [{ type: "text", text: "Success" }],
              model: "claude-3-5-haiku-20241022",
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
            { status: 200 }
          )
        );

      const client = new AnthropicClient({ apiKey: "test-key" });
      const response = await client.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(response.content).toBe("Success");
    });

    it("should retry on 500 server error", async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Internal error" } }), {
            status: 500,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: "msg_123",
              content: [{ type: "text", text: "Success" }],
              model: "claude-3-5-haiku-20241022",
              stop_reason: "end_turn",
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
            { status: 200 }
          )
        );

      const client = new AnthropicClient({ apiKey: "test-key" });
      const response = await client.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(response.content).toBe("Success");
    });

    it("should not retry on 401 unauthorized", async () => {
      mockFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "Unauthorized" } }), {
          status: 401,
        })
      );

      const client = new AnthropicClient({ apiKey: "test-key" });

      await expect(
        client.complete({ messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("Unauthorized");

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("summarize", () => {
    it("should call complete with summarization prompt", async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "msg_123",
            content: [{ type: "text", text: "Summary: Key points discussed." }],
            model: "claude-3-5-haiku-20241022",
            stop_reason: "end_turn",
            usage: { input_tokens: 50, output_tokens: 20 },
          }),
          { status: 200 }
        )
      );

      const client = new AnthropicClient({ apiKey: "test-key" });
      const summary = await client.summarize("User: Hello\nAssistant: Hi there!");

      expect(summary).toBe("Summary: Key points discussed.");

      const call = mockFetch.mock.calls[0];
      const body = JSON.parse(call?.[1]?.body as string);
      expect(body.system).toContain("summarizer");
      expect(body.messages[0].content).toContain("Hello");
    });
  });

  describe("createAnthropicClient", () => {
    it("should create client with config", () => {
      const client = createAnthropicClient({ apiKey: "test-key" });
      expect(client).toBeInstanceOf(AnthropicClient);
    });
  });
});
