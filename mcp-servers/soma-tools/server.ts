#!/usr/bin/env bun
/**
 * Soma Tools MCP Server
 *
 * Provides tools for Claude to manage the soma process itself.
 * Currently: restart_service - save a prompt and restart soma,
 * so the prompt is auto-executed in the new session.
 *
 * Flow:
 * 1. Claude calls restart_service(prompt)
 * 2. Prompt saved to /tmp/soma-restart-prompt.txt
 * 3. SIGTERM sent to soma process (via PID file)
 * 4. Soma's handleSigterm() reads prompt file → saves to restart marker
 * 5. On reboot, bootstrap auto-sends prompt to new Claude session
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { writeFileSync, readFileSync, existsSync } from "fs";

const RESTART_PROMPT_FILE = "/tmp/soma-restart-prompt.txt";
const SOMA_PID_FILE = "/tmp/soma.pid";

function getSomaPid(): number | null {
  try {
    if (!existsSync(SOMA_PID_FILE)) return null;
    const pid = parseInt(readFileSync(SOMA_PID_FILE, "utf-8").trim(), 10);
    if (isNaN(pid) || pid <= 0) return null;

    // Verify process exists
    try {
      process.kill(pid, 0); // Signal 0 = just check if process exists
      return pid;
    } catch {
      return null; // Process doesn't exist
    }
  } catch {
    return null;
  }
}

// --- MCP Server Setup ---

const server = new Server(
  { name: "soma-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "restart_service",
      description:
        "Restart the soma service with an auto-execute prompt. " +
        "The prompt will be saved and automatically sent to the new Claude session after restart. " +
        "Use this when you need to restart yourself (e.g., after code changes via make up) " +
        "and want to continue a task automatically. " +
        "Example: restart_service({ prompt: 'BD 이슈 확인하고 이어서 작업해줘' })",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description:
              "The prompt to auto-execute in the new session after restart. " +
              "This will be the first message sent to Claude after the service restarts. " +
              "Include enough context for the new session to continue the work.",
          },
          delay_ms: {
            type: "number",
            description:
              "Optional delay in milliseconds before sending SIGTERM (default: 500). " +
              "Allows the MCP response to be sent back before the process dies.",
          },
        },
        required: ["prompt"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "restart_service": {
        const { prompt, delay_ms } = args as {
          prompt: string;
          delay_ms?: number;
        };

        if (!prompt || typeof prompt !== "string") {
          return {
            content: [
              { type: "text", text: "Error: prompt is required and must be a string" },
            ],
            isError: true,
          };
        }

        if (prompt.length > 10000) {
          return {
            content: [
              { type: "text", text: "Error: prompt too long (max 10000 chars)" },
            ],
            isError: true,
          };
        }

        // Step 1: Save prompt to file
        writeFileSync(RESTART_PROMPT_FILE, prompt, "utf-8");

        // Step 2: Find soma PID
        const pid = getSomaPid();
        if (!pid) {
          return {
            content: [
              {
                type: "text",
                text:
                  `Prompt saved to ${RESTART_PROMPT_FILE} but could not find soma PID.\n` +
                  `PID file ${SOMA_PID_FILE} not found or process not running.\n` +
                  `You may need to manually restart the service.`,
              },
            ],
            isError: true,
          };
        }

        // Step 3: Schedule SIGTERM with delay (so this response gets back to Claude first)
        const delay = typeof delay_ms === "number" && delay_ms > 0 ? delay_ms : 500;
        setTimeout(() => {
          try {
            process.kill(pid, "SIGTERM");
          } catch (e) {
            // Process may have already exited
            console.error(`[soma-tools] Failed to send SIGTERM to ${pid}:`, e);
          }
        }, delay);

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Restart scheduled.\n\n` +
                `Prompt saved (${prompt.length} chars) → ${RESTART_PROMPT_FILE}\n` +
                `SIGTERM will be sent to PID ${pid} in ${delay}ms.\n\n` +
                `Flow:\n` +
                `1. SIGTERM → soma reads prompt file → saves to restart marker\n` +
                `2. Process exits → process manager restarts soma\n` +
                `3. New session auto-executes your prompt\n\n` +
                `⚠️ This session will end shortly. See you on the other side.`,
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Error: Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        { type: "text", text: `Error: ${(error as Error).message}` },
      ],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
