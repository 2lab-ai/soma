import { homedir } from "os";
import { resolve, dirname } from "path";
import type { McpServerConfig } from "./types";

const HOME = homedir();

function parseEnvList(key: string): string[] {
  return (process.env[key] || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseEnvNumbers(key: string): number[] {
  return parseEnvList(key)
    .map((x) => parseInt(x, 10))
    .filter((x) => !isNaN(x));
}

function parseEnvBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (!val) return defaultValue;
  return val.toLowerCase() === "true";
}

function parseEnvInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (!val) return defaultValue;
  const parsed = parseInt(val, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

const EXTRA_PATHS = [
  `${HOME}/.local/bin`,
  `${HOME}/.bun/bin`,
  "/opt/homebrew/bin",
  "/opt/homebrew/sbin",
  "/usr/local/bin",
];

const currentPath = process.env.PATH || "";
const pathParts = currentPath.split(":");
for (const extraPath of EXTRA_PATHS) {
  if (!pathParts.includes(extraPath)) {
    pathParts.unshift(extraPath);
  }
}
process.env.PATH = pathParts.join(":");

export const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
export const ALLOWED_USERS = parseEnvNumbers("TELEGRAM_ALLOWED_USERS");

// System message prefix to distinguish from model responses
export const SYS_MSG_PREFIX = "⚡️";
export const ALLOWED_GROUPS = parseEnvNumbers("TELEGRAM_ALLOWED_GROUPS");
export const RESPOND_WITHOUT_MENTION = parseEnvBool("RESPOND_WITHOUT_MENTION", false);
export const WORKING_DIR = process.env.CLAUDE_WORKING_DIR || HOME;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

function findClaudeCli(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH;
  return Bun.which("claude") || "/usr/local/bin/claude";
}

export const CLAUDE_CLI_PATH = findClaudeCli();

let MCP_SERVERS: Record<string, McpServerConfig> = {};
try {
  const mcpConfigPath = resolve(dirname(import.meta.dir), "mcp-config.ts");
  const mcpModule = await import(mcpConfigPath).catch(() => null);
  if (mcpModule?.MCP_SERVERS) {
    MCP_SERVERS = mcpModule.MCP_SERVERS;

    // Inject CHAT_HISTORY_DATA_DIR env for chat-history MCP server
    // This ensures chat history is stored per working directory, not per project
    if (MCP_SERVERS["chat-history"] && "command" in MCP_SERVERS["chat-history"]) {
      const chatHistoryConfig = MCP_SERVERS["chat-history"] as { command: string; args?: string[]; env?: Record<string, string> };
      MCP_SERVERS["chat-history"] = {
        ...chatHistoryConfig,
        env: {
          ...chatHistoryConfig.env,
          CHAT_HISTORY_DATA_DIR: `${WORKING_DIR}/.db/chat-history`,
        },
      };
    }

    console.log(`Loaded ${Object.keys(MCP_SERVERS).length} MCP servers`);
  }
} catch {
  console.log("No mcp-config.ts found - running without MCPs");
}
export { MCP_SERVERS };

const defaultAllowedPaths = [
  WORKING_DIR,
  `${HOME}/Documents`,
  `${HOME}/Downloads`,
  `${HOME}/Desktop`,
  `${HOME}/.claude`,
];

const allowedPathsEnv = parseEnvList("ALLOWED_PATHS");
export const ALLOWED_PATHS = allowedPathsEnv.length
  ? allowedPathsEnv
  : defaultAllowedPaths;

function buildSafetyPrompt(allowedPaths: string[]): string {
  const pathsList = allowedPaths
    .map((p) => `   - ${p} (and subdirectories)`)
    .join("\n");

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - REFUSE any file operations outside these paths

3. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

4. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

export const SAFETY_PROMPT = buildSafetyPrompt(ALLOWED_PATHS);

export const UI_ASKUSER_INSTRUCTIONS = `
# UIAskUserQuestion - Interactive Choice System

When you need user clarification with discrete options, emit a JSON choice object.

## Single Choice Format

\`\`\`json
{
  "type": "user_choice",
  "question": "Which approach do you prefer?",
  "choices": [
    {"id": "a", "label": "Option A", "description": "More details about A"},
    {"id": "b", "label": "Option B", "description": "More details about B"}
  ],
  "context": "Optional context to help user decide"
}
\`\`\`

## Multi-Question Form Format

\`\`\`json
{
  "type": "user_choices",
  "title": "Configuration Setup",
  "description": "Please answer these questions to proceed",
  "questions": [
    {
      "id": "q1",
      "question": "Select database type",
      "choices": [
        {"id": "pg", "label": "PostgreSQL"},
        {"id": "my", "label": "MySQL"}
      ]
    },
    {
      "id": "q2",
      "question": "Enable caching?",
      "choices": [
        {"id": "y", "label": "Yes"},
        {"id": "n", "label": "No"}
      ]
    }
  ]
}
\`\`\`

## Rules

1. **Choice limits**: 2-8 options per question (Telegram keyboard limit)
2. **IDs**: Short alphanumeric (a-z, 0-9), max 4 characters
3. **Labels**: Max 30 characters (longer text will be truncated with "...")
4. **Placement**: Emit JSON AFTER your explanatory text, in a \`\`\`json code block
5. **One per response**: Only one choice JSON per message
6. **Question clarity**: Make questions clear and self-contained

## When to Use

- Multiple valid approaches exist
- Need user preference or decision
- Binary yes/no confirmation
- Selection from a known set of options

## When NOT to Use

- Open-ended questions (use regular text)
- Single obvious answer
- Follow-up to previous choice (just continue conversation)
`;

export const CHAT_HISTORY_ACCESS_INFO = `
# Chat History Access

You have access to the conversation history with this user. All messages are automatically saved and can be referenced.

## Available Context

- **Current Session**: Full conversation history in this session is available in your context
- **Past Conversations**: Previous conversations are logged to disk (NDJSON format)
- **Time Range**: Messages are retained indefinitely (subject to future retention policies)

## Capabilities

When the user asks about past conversations, you can:
1. **Reference recent discussions**: Use your current context window for recent messages
2. **Recall specific topics**: Search your memory for keywords or topics discussed
3. **Provide continuity**: Remember user preferences, project details, ongoing work

## Usage Patterns

**User asks about something discussed earlier:**
- Check your current context first
- If outside context window, acknowledge the limitation
- Offer to help based on available context

**Examples:**
- "What did we discuss about X?" → Check recent context, provide answer if available
- "You mentioned Y yesterday" → Acknowledge if in context, note if too far back
- "Continue working on Z" → Use context to understand Z

## Constraints

- **Privacy**: Only access conversations with the current user (chat ID: unique per user)
- **Scope**: Cannot access other users' conversations
- **Limitations**: Context window limits what's immediately available
- **Transparency**: Be honest about what you can/cannot recall

## Current Implementation

- Messages are logged automatically (user, assistant, tool outputs)
- Storage: Daily NDJSON files (data/chats/YYYY-MM-DD.ndjson)
- Session tracking: Each conversation has unique sessionId
- Token usage tracked per message

**Note**: Future updates will provide explicit search tools for deeper history access.
`;

export const BLOCKED_PATTERNS = [
  "rm -rf /",
  "rm -rf ~",
  "rm -rf $HOME",
  "sudo rm",
  ":(){ :|:& };:", // Fork bomb
  "> /dev/sd",
  "mkfs.",
  "dd if=",
];

export const QUERY_TIMEOUT_MS = 180_000;

const BASE_TRANSCRIPTION_PROMPT = `Transcribe this voice message accurately.
The speaker may use multiple languages (English, and possibly others).
Focus on accuracy for proper nouns, technical terms, and commands.`;

const TRANSCRIPTION_CONTEXT = process.env.TRANSCRIPTION_CONTEXT || "";
export const TRANSCRIPTION_PROMPT = TRANSCRIPTION_CONTEXT
  ? `${BASE_TRANSCRIPTION_PROMPT}\n\nAdditional context:\n${TRANSCRIPTION_CONTEXT}`
  : BASE_TRANSCRIPTION_PROMPT;
export const TRANSCRIPTION_AVAILABLE = !!OPENAI_API_KEY;

export const DEFAULT_THINKING_TOKENS = Math.min(
  Math.max(0, parseEnvInt("DEFAULT_THINKING_TOKENS", 0)),
  128000
);

export const THINKING_KEYWORDS = parseEnvList("THINKING_KEYWORDS").length
  ? parseEnvList("THINKING_KEYWORDS").map((k) => k.toLowerCase())
  : ["think", "pensa", "ragiona"];

export const THINKING_DEEP_KEYWORDS = parseEnvList("THINKING_DEEP_KEYWORDS").length
  ? parseEnvList("THINKING_DEEP_KEYWORDS").map((k) => k.toLowerCase())
  : ["ultrathink", "think hard", "pensa bene"];

export const DELETE_THINKING_MESSAGES = parseEnvBool(
  "DEFAULT_DELETE_THINKING_MESSAGES",
  true
);
export const DELETE_TOOL_MESSAGES = parseEnvBool("DEFAULT_DELETE_TOOL_MESSAGES", true);
export const PROGRESS_SPINNER_ENABLED = parseEnvBool("PROGRESS_SPINNER_ENABLED", false);
export const SHOW_ELAPSED_TIME = parseEnvBool("SHOW_ELAPSED_TIME", true);
export const PROGRESS_REACTION_ENABLED = parseEnvBool(
  "PROGRESS_REACTION_ENABLED",
  true
);

export const MEDIA_GROUP_TIMEOUT = 1000;
export const TELEGRAM_MESSAGE_LIMIT = 4096;
export const TELEGRAM_SAFE_LIMIT = 4000;
export const STREAMING_THROTTLE_MS = 500;
export const BUTTON_LABEL_MAX_LENGTH = 30;

export const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH || "/tmp/soma-audit.log";
export const AUDIT_LOG_JSON = parseEnvBool("AUDIT_LOG_JSON", false);

export const RATE_LIMIT_ENABLED = parseEnvBool("RATE_LIMIT_ENABLED", true);
export const RATE_LIMIT_REQUESTS = parseEnvInt("RATE_LIMIT_REQUESTS", 20);
export const RATE_LIMIT_WINDOW = parseEnvInt("RATE_LIMIT_WINDOW", 60);

export const RESTART_FILE = "/tmp/soma-restart.json";
export const TEMP_DIR = "/tmp/soma";
export const TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"];

// Chat history configuration
export const CHAT_HISTORY_ENABLED = parseEnvBool("CHAT_HISTORY_ENABLED", true);
export const CHAT_HISTORY_DATA_DIR = process.env.CHAT_HISTORY_DATA_DIR || `${WORKING_DIR}/.db/chat-history`;

// Usage display settings
export const SHOW_CURRENT_PROVIDER_USAGE = parseEnvBool(
  "SHOW_CURRENT_PROVIDER_USAGE",
  true
);
export const SHOW_ANTHROPIC_USAGE = parseEnvBool("SHOW_ANTHROPIC_USAGE", false);
export const SHOW_CODEX_USAGE = parseEnvBool("SHOW_CODEX_USAGE", false);
export const SHOW_GEMINI_USAGE = parseEnvBool("SHOW_GEMINI_USAGE", false);

await Bun.write(`${TEMP_DIR}/.keep`, "");

if (!TELEGRAM_TOKEN) {
  console.error("ERROR: TELEGRAM_BOT_TOKEN required");
  process.exit(1);
}

if (!ALLOWED_USERS.length) {
  console.error("ERROR: TELEGRAM_ALLOWED_USERS required");
  process.exit(1);
}

console.log(`Config: ${ALLOWED_USERS.length} users, dir=${WORKING_DIR}`);
