import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createSessionIdentity } from "../routing/session-key";
import {
  buildQueryRuntimeMetadata,
  buildQueryRuntimeOptions,
  checkToolInputSafety,
  createQueryRuntimeHooks,
  executeQueryRuntime,
  extractBashFilePaths,
} from "./query-runtime";
import { isAbortError } from "../../utils/error-classification";

function toAsyncGenerator(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  return (async function* () {
    for (const message of messages) {
      yield message;
    }
  })();
}

describe("checkToolInputSafety", () => {
  test("allows file access within temp paths", () => {
    const result = checkToolInputSafety("Read", { file_path: "/tmp/test.ts" });
    expect(result).toEqual({ allowed: true });
  });

  test("blocks file access outside allowed paths without throwing", () => {
    const result = checkToolInputSafety("Read", {
      file_path: "/home/zhugehyuk/kl-v2.png",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("File access blocked");
      expect(result.reason).toContain("/home/zhugehyuk/kl-v2.png");
    }
  });

  test("blocks unsafe bash commands without throwing", () => {
    const result = checkToolInputSafety("Bash", { command: "rm -rf /" });
    expect(result.allowed).toBe(false);
  });

  test("allows safe bash commands", () => {
    const result = checkToolInputSafety("Bash", { command: "echo hello" });
    expect(result).toEqual({ allowed: true });
  });

  test("BUG agi-2ry: blocks Write to temp paths outside ALLOWED_PATHS", () => {
    // Bot-generated attachments under TEMP_PATHS are readable but not general
    // working directories — Write must not be permitted just because the path
    // is inside /tmp.
    const result = checkToolInputSafety("Write", { file_path: "/tmp/out.ts" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("File access blocked");
    }
  });

  test("BUG agi-2ry: blocks Edit to temp paths outside ALLOWED_PATHS", () => {
    const result = checkToolInputSafety("Edit", { file_path: "/tmp/out.ts" });
    expect(result.allowed).toBe(false);
  });

  // --- Path traversal tests (Issue #9) ---

  test("blocks path traversal via /tmp/../etc/passwd", () => {
    const result = checkToolInputSafety("Read", {
      file_path: "/tmp/../etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks path traversal via /private/tmp/../../etc/shadow", () => {
    const result = checkToolInputSafety("Read", {
      file_path: "/private/tmp/../../etc/shadow",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks /.claude/ substring injection in unrelated path", () => {
    const result = checkToolInputSafety("Read", {
      file_path: "/malicious/.claude/../../etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  // --- Write/Edit block tests ---

  test("blocks Write to path outside allowed directories", () => {
    const result = checkToolInputSafety("Write", {
      file_path: "/etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Edit to path outside allowed directories", () => {
    const result = checkToolInputSafety("Edit", {
      file_path: "/home/user/secret.txt",
    });
    expect(result.allowed).toBe(false);
  });

  // --- Malformed input tests ---

  test("allows when file_path is empty string", () => {
    const result = checkToolInputSafety("Read", { file_path: "" });
    expect(result).toEqual({ allowed: true });
  });

  test("allows when file_path is missing from tool_input", () => {
    const result = checkToolInputSafety("Read", {});
    expect(result).toEqual({ allowed: true });
  });

  test("allows unknown tool names without validation", () => {
    const result = checkToolInputSafety("WebFetch", {
      url: "https://example.com",
    });
    expect(result).toEqual({ allowed: true });
  });

  // --- Grep/Glob path validation (Issue #12, Scenario 1) ---

  test("blocks Grep with path outside allowed directories", () => {
    const result = checkToolInputSafety("Grep", {
      path: "/etc/passwd",
      pattern: "root",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Grep path blocked");
    }
  });

  test("blocks Glob with path outside allowed directories", () => {
    const result = checkToolInputSafety("Glob", {
      path: "/home/user/secrets",
      pattern: "*.key",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Glob path blocked");
    }
  });

  test("BUG agi-2ry: blocks Grep with path in temp directories outside ALLOWED_PATHS", () => {
    // TEMP_PATHS are runtime-compat roots for bot-owned attachments, not
    // general working directories — Grep must not enumerate them.
    const result = checkToolInputSafety("Grep", {
      path: "/tmp/project",
      pattern: "TODO",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Grep path blocked");
    }
  });

  test("allows Grep without path parameter", () => {
    const result = checkToolInputSafety("Grep", { pattern: "TODO" });
    expect(result).toEqual({ allowed: true });
  });

  // --- Bash file-read command detection (Issue #12, Scenario 2) ---

  test("blocks Bash cat of file outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "cat /etc/passwd",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Bash command accesses blocked path");
    }
  });

  test("blocks Bash head of file outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "head -5 /home/user/secret.txt",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Bash tail of file outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "tail -f /var/log/auth.log",
    });
    expect(result.allowed).toBe(false);
  });

  test("BUG agi-2ry: blocks Bash cat of file in temp paths outside ALLOWED_PATHS", () => {
    // Same policy as Write/Grep: bot-owned attachments under /tmp are not a
    // general working directory the model can enumerate via bash.
    const result = checkToolInputSafety("Bash", {
      command: "cat /tmp/output.log",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Bash command accesses blocked path");
    }
  });

  test("allows Bash echo (no file access)", () => {
    const result = checkToolInputSafety("Bash", {
      command: "echo hello world",
    });
    expect(result).toEqual({ allowed: true });
  });

  test("allows Bash ls (no file-read path extraction)", () => {
    const result = checkToolInputSafety("Bash", {
      command: "ls -la /etc",
    });
    expect(result).toEqual({ allowed: true });
  });

  // --- Codex review findings: two-token flags ---

  test("blocks Bash head -n 5 of file outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "head -n 5 /etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Bash tail -n 20 of file outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "tail -n 20 /etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Bash sed with file argument outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "sed -n '1p' /etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Bash awk with file argument outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "awk '{print $1}' /etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  // --- Codex review findings: multi-operand (cp/mv destination) ---

  test("blocks Bash cp when destination is outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "cp /tmp/ok /etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Bash mv when destination is outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "mv /tmp/ok /root/.ssh/authorized_keys",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Bash tee to file outside allowed paths", () => {
    const result = checkToolInputSafety("Bash", {
      command: "tee /tmp/ok /etc/passwd",
    });
    expect(result.allowed).toBe(false);
  });

  // --- Codex review findings: piped commands ---

  test("blocks piped Bash command accessing blocked file", () => {
    const result = checkToolInputSafety("Bash", {
      command: "echo foo | cat /etc/shadow",
    });
    expect(result.allowed).toBe(false);
  });

  // --- Codex review findings: Grep/Glob traversal ---

  test("blocks Grep with path traversal via /tmp/../etc/passwd", () => {
    const result = checkToolInputSafety("Grep", {
      path: "/tmp/../etc/passwd",
      pattern: "root",
    });
    expect(result.allowed).toBe(false);
  });

  test("blocks Glob with path traversal via /tmp/../home/user", () => {
    const result = checkToolInputSafety("Glob", {
      path: "/tmp/../home/user",
      pattern: "*.key",
    });
    expect(result.allowed).toBe(false);
  });

  test("BUG agi-2ry: blocks Glob with path in temp directories outside ALLOWED_PATHS", () => {
    const result = checkToolInputSafety("Glob", {
      path: "/tmp/project",
      pattern: "*.ts",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("Glob path blocked");
    }
  });

  // Read carve-out for bot-owned attachments must survive the Write/Edit block.

  test("BUG agi-2ry: allows Read of file under /tmp (bot-owned attachment)", () => {
    const result = checkToolInputSafety("Read", {
      file_path: "/tmp/soma/photo-123.jpg",
    });
    expect(result).toEqual({ allowed: true });
  });

  test("BUG agi-2ry: allows Read of file under /private/tmp (bot-owned attachment)", () => {
    const result = checkToolInputSafety("Read", {
      file_path: "/private/tmp/soma/doc-456.pdf",
    });
    expect(result).toEqual({ allowed: true });
  });

  // "/tmp" prefix must not accidentally match "/tmpx/foo".
  test("BUG agi-2ry: blocks Write with sibling-prefix path (not a true child of TEMP root)", () => {
    const result = checkToolInputSafety("Write", {
      file_path: "/tmpx/foo.txt",
    });
    expect(result.allowed).toBe(false);
  });

  // Symlink whose textual path is inside an allowed root but whose realpath
  // escapes must be rejected (parallels src/security.ts:90-96); otherwise any
  // symlink under an allowed dir becomes a universal escape hatch. Control
  // case: a regular sibling stays allowed, proving the block is driven by
  // realpath and not by the parent directory.
  describe("symlink target follows realpath (existing paths)", () => {
    const scratchDir = join(import.meta.dir, ".query-runtime-symlink-test");
    let outsideDir = "";
    let outsideTarget = "";
    const symlinkPath = join(scratchDir, "link-to-outside.txt");
    const regularPath = join(scratchDir, "regular-inside.txt");

    beforeAll(() => {
      rmSync(scratchDir, { recursive: true, force: true });
      mkdirSync(scratchDir, { recursive: true });
      outsideDir = mkdtempSync(join(tmpdir(), "soma-symlink-test-"));
      outsideTarget = join(outsideDir, "target.txt");
      writeFileSync(outsideTarget, "outside\n");
      writeFileSync(regularPath, "inside\n");
      // realpathSync only follows the link when both link AND target exist.
      symlinkSync(outsideTarget, symlinkPath);
    });

    afterAll(() => {
      rmSync(scratchDir, { recursive: true, force: true });
      if (outsideDir) {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    test("BUG agi-2ry: Write to symlink inside allowed root is blocked when realpath escapes", () => {
      const result = checkToolInputSafety("Write", { file_path: symlinkPath });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("File access blocked");
      }
    });

    test("BUG agi-2ry: Write to regular file at the same allowed parent stays allowed", () => {
      // Control against the block above.
      const result = checkToolInputSafety("Write", { file_path: regularPath });
      expect(result.allowed).toBe(true);
    });
  });

  // thread-workdir.ts:8,29-36 stages each Telegram thread as a directory
  // symlink `/tmp/soma-thread-workdirs-*/…` → WORKING_DIR. A Write to a
  // not-yet-created child under that alias must resolve via the deepest
  // EXISTING ancestor (the alias itself → WORKING_DIR) and be permitted; a
  // child that is itself a symlink whose realpath escapes must still be
  // rejected. Both directions are load-bearing.
  describe("BUG agi-2ry: thread-workdirs alias containment", () => {
    const aliasParent = join(
      tmpdir(),
      `soma-agi2ry-alias-${process.pid}-${Date.now()}`
    );
    const aliasDir = join(aliasParent, "tenant__channel__thread");
    // process.cwd() is under HOME → ALLOWED_PATHS by default.
    const allowedRootTarget = process.cwd();
    const notYetCreatedThroughAlias = join(aliasDir, "agi-2ry-new-file.md");
    let escapeOutsideDir = "";
    let escapeOutsideTarget = "";
    const escapeLinkThroughAlias = join(aliasDir, "agi-2ry-escape-link.txt");

    beforeAll(() => {
      mkdirSync(aliasParent, { recursive: true });
      symlinkSync(allowedRootTarget, aliasDir, "dir");
      escapeOutsideDir = mkdtempSync(join(tmpdir(), "soma-agi2ry-escape-"));
      escapeOutsideTarget = join(escapeOutsideDir, "outside.txt");
      writeFileSync(escapeOutsideTarget, "outside\n");
      // Symlinks created through the alias physically land inside the target
      // worktree — the afterAll cleanup order below reflects that.
      symlinkSync(escapeOutsideTarget, escapeLinkThroughAlias);
    });

    afterAll(() => {
      // Escape symlink lives inside the worktree via the alias — remove
      // first, then the alias, then the parents.
      rmSync(escapeLinkThroughAlias, { force: true });
      rmSync(aliasDir, { force: true });
      rmSync(aliasParent, { recursive: true, force: true });
      if (escapeOutsideDir) {
        rmSync(escapeOutsideDir, { recursive: true, force: true });
      }
    });

    test("BUG agi-2ry: Write to not-yet-created child through legitimate alias symlink is permitted", () => {
      const result = checkToolInputSafety("Write", {
        file_path: notYetCreatedThroughAlias,
      });
      expect(result.allowed).toBe(true);
    });

    test("BUG agi-2ry: Write to existing symlink child through the alias whose target escapes is rejected", () => {
      // Parent realpaths to an allowed root, but the final component is a
      // symlink whose realpath escapes — the whole input must be realpathed.
      const result = checkToolInputSafety("Write", {
        file_path: escapeLinkThroughAlias,
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toContain("File access blocked");
      }
    });
  });

  // macOS autofs: /home and /net are demand-mounted, so realpath on them
  // blocks trying to reach an NFS server. The guard must reject the input
  // before it hits realpath. We assert the observable outcome (blocked); the
  // non-blocking-realpath property is exercised by not hanging.
  test("BUG agi-2ry: Write to /home/** path is fail-closed without touching realpath", () => {
    const result = checkToolInputSafety("Write", {
      file_path: "/home/nonexistent-agi2ry/x.txt",
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain("File access blocked");
    }
  });

  test("BUG agi-2ry: Write to /net/** path is fail-closed without touching realpath", () => {
    const result = checkToolInputSafety("Write", {
      file_path: "/net/some-host/share/x.txt",
    });
    expect(result.allowed).toBe(false);
  });
});

// --- extractBashFilePaths unit tests ---

describe("extractBashFilePaths", () => {
  test("extracts single absolute path from cat", () => {
    expect(extractBashFilePaths("cat /etc/passwd")).toEqual(["/etc/passwd"]);
  });

  test("extracts path after two-token flag (head -n 5)", () => {
    expect(extractBashFilePaths("head -n 5 /etc/passwd")).toEqual(["/etc/passwd"]);
  });

  test("extracts all paths from cp (source + destination)", () => {
    const paths = extractBashFilePaths("cp /tmp/a /etc/passwd");
    expect(paths).toContain("/tmp/a");
    expect(paths).toContain("/etc/passwd");
    expect(paths).toHaveLength(2);
  });

  test("skips quoted arguments (awk patterns)", () => {
    expect(extractBashFilePaths("awk '{print $1}' /etc/passwd")).toEqual([
      "/etc/passwd",
    ]);
  });

  test("extracts paths from piped commands", () => {
    const paths = extractBashFilePaths("echo foo | cat /etc/shadow");
    expect(paths).toEqual(["/etc/shadow"]);
  });

  test("returns empty for non-file commands", () => {
    expect(extractBashFilePaths("echo hello world")).toEqual([]);
    expect(extractBashFilePaths("ls -la /etc")).toEqual([]);
    expect(extractBashFilePaths("git status")).toEqual([]);
  });
});

describe("query-runtime hooks", () => {
  test("pre hook blocks tool execution when stop was requested", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => true,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    await expect(
      hooks.preToolUseHook({ tool_name: "Bash" }, null, null)
    ).rejects.toThrow("Abort requested by user");
  });

  test("abort error from hook has name AbortError for isAbortError recognition", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => true,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    try {
      await hooks.preToolUseHook({ tool_name: "Bash" }, null, null);
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error instanceof Error).toBe(true);
      expect((error as Error).name).toBe("AbortError");
      expect((error as Error).message).toBe("Abort requested by user");
      // Integration: verify isAbortError() actually recognizes this error
      expect(isAbortError(error)).toBe(true);
    }
  });

  test("pre hook returns decision:block for file access outside allowed paths", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const result = await hooks.preToolUseHook(
      {
        tool_name: "Read",
        tool_input: { file_path: "/home/zhugehyuk/kl-v2.png" },
      },
      null,
      null
    );

    expect(result.decision).toBe("block");
    expect(typeof result.reason).toBe("string");
    expect(result.reason as string).toContain("File access blocked");
  });

  test("pre hook blocks unsafe Bash command with decision:block", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const result = await hooks.preToolUseHook(
      {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      },
      null,
      null
    );

    expect(result.decision).toBe("block");
    expect(typeof result.reason).toBe("string");
    expect(result.reason as string).toContain("Unsafe command blocked");
  });

  test("pre hook blocks path traversal via /tmp/../etc/passwd", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const result = await hooks.preToolUseHook(
      {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/../etc/passwd" },
      },
      null,
      null
    );

    expect(result.decision).toBe("block");
    expect(result.reason as string).toContain("File access blocked");
  });

  test("pre hook allows tool with valid path (does not block)", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const result = await hooks.preToolUseHook(
      {
        tool_name: "Read",
        tool_input: { file_path: "/tmp/valid-file.ts" },
      },
      null,
      null
    );

    expect(result).toEqual({});
    expect(result.decision).toBeUndefined();
  });

  test("post hook injects steering payload when buffered messages exist", async () => {
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 2,
      trackBufferedMessagesForInjection: () => 2,
      consumeSteering: () => "[12:00:00] hello",
      getInjectedCount: () => 2,
    });

    const payload = await hooks.postToolUseHook({ tool_name: "Read" }, null, null);
    expect(payload).toEqual({
      systemMessage:
        "[USER SENT MESSAGE DURING EXECUTION]\n[12:00:00] hello\n[END USER MESSAGE]",
    });
  });
});

describe("query-runtime options", () => {
  test("builds Claude query options with tool hooks and abort controller", () => {
    const abortController = new AbortController();
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const options = buildQueryRuntimeOptions({
      model: "claude-opus-4-7",
      cwd: "/tmp",
      systemPrompt: "system",
      mcpServers: {},
      maxThinkingTokens: 10000,
      additionalDirectories: ["/tmp"],
      resumeSessionId: "session-1",
      pathToClaudeCodeExecutable: "/usr/local/bin/claude",
      abortController,
      hooks,
    });

    expect(options.model).toBe("claude-opus-4-7");
    expect(options.resume).toBe("session-1");
    expect(options.abortController).toBe(abortController);
    expect(options.pathToClaudeCodeExecutable).toBe("/usr/local/bin/claude");
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(options.hooks?.PostToolUse?.[0]?.hooks).toHaveLength(1);
  });

  test("Opus 4.7 strips maxThinkingTokens and applies adaptive + xhigh", () => {
    const abortController = new AbortController();
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const options = buildQueryRuntimeOptions({
      model: "claude-opus-4-7",
      cwd: "/tmp",
      systemPrompt: "system",
      mcpServers: {},
      maxThinkingTokens: 50000,
      additionalDirectories: ["/tmp"],
      resumeSessionId: null,
      abortController,
      hooks,
    });

    expect(
      (options as { maxThinkingTokens?: number }).maxThinkingTokens
    ).toBeUndefined();
    expect((options as { thinking?: { type: string } }).thinking).toEqual({
      type: "adaptive",
    });
    expect((options as { effort?: string }).effort).toBe("xhigh");
    // Untouched fields must survive the rewrite
    expect(options.model).toBe("claude-opus-4-7");
    expect(options.cwd).toBe("/tmp");
    expect(options.abortController).toBe(abortController);
  });

  test("Sonnet 4.5 keeps maxThinkingTokens (helper passthrough)", () => {
    const abortController = new AbortController();
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const options = buildQueryRuntimeOptions({
      model: "claude-sonnet-4-5-20250929",
      cwd: "/tmp",
      systemPrompt: "system",
      mcpServers: {},
      maxThinkingTokens: 50000,
      additionalDirectories: [],
      resumeSessionId: null,
      abortController,
      hooks,
    });

    expect((options as { maxThinkingTokens?: number }).maxThinkingTokens).toBe(50000);
    expect((options as { thinking?: unknown }).thinking).toBeUndefined();
    expect((options as { effort?: unknown }).effort).toBeUndefined();
  });

  // Issue #79: the runtime had no canUseTool at all, so an exceptional SDK
  // permission prompt had no user round-trip and the turn stalled.
  test("wires canUseTool through while keeping bypass mode for ordinary tools", () => {
    const abortController = new AbortController();
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });
    const canUseTool: CanUseTool = async () => ({
      behavior: "deny",
      message: "test",
    });

    const options = buildQueryRuntimeOptions({
      model: "claude-sonnet-4-5-20250929",
      cwd: "/tmp",
      systemPrompt: "system",
      mcpServers: {},
      maxThinkingTokens: 10000,
      additionalDirectories: [],
      resumeSessionId: null,
      abortController,
      hooks,
      canUseTool,
    });

    expect(options.canUseTool).toBe(canUseTool);
    // Ordinary tools must stay autonomous — only exceptional prompts
    // (explicit ask rules, org-ask connectors, critical-path rm/rmdir,
    // requiresUserInteraction) reach canUseTool under bypass.
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    // Hard denies still run first, in the PreToolUse hook.
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  test("omits canUseTool when no permission broker is bound", () => {
    const abortController = new AbortController();
    const hooks = createQueryRuntimeHooks({
      getStopRequested: () => false,
      getSteeringCount: () => 0,
      trackBufferedMessagesForInjection: () => 0,
      consumeSteering: () => null,
      getInjectedCount: () => 0,
    });

    const options = buildQueryRuntimeOptions({
      model: "claude-sonnet-4-5-20250929",
      cwd: "/tmp",
      systemPrompt: "system",
      mcpServers: {},
      maxThinkingTokens: 10000,
      additionalDirectories: [],
      resumeSessionId: null,
      abortController,
      hooks,
    });

    expect(options.canUseTool).toBeUndefined();
    expect(options.permissionMode).toBe("bypassPermissions");
  });
});

describe("query-runtime execution", () => {
  test("streams assistant events and returns usage/tool timing summary", async () => {
    const statusEvents: Array<{ type: string; content: string }> = [];
    const sessionIds: string[] = [];
    const toolDisplays: string[] = [];
    const queryGeneration = 1;

    const events: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-1",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "/tmp/a.ts" },
            },
            {
              type: "text",
              text: "hello world from query runtime stream",
            },
          ],
        },
      } as unknown as SDKMessage,
      {
        type: "result",
        modelUsage: {
          claude: {
            inputTokens: 12,
            outputTokens: 6,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const result = await executeQueryRuntime({
      prompt: "hello",
      options: {
        model: "claude-opus-4-7",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async (type, content) => {
        statusEvents.push({ type, content });
      },
      queryGeneration,
      getCurrentGeneration: () => queryGeneration,
      shouldStop: () => false,
      onSessionId: (sessionId: string) => {
        sessionIds.push(sessionId);
      },
      onToolDisplay: (toolDisplay: string) => {
        toolDisplays.push(toolDisplay);
      },
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      queryFactory: () => toAsyncGenerator(events),
    });

    expect(sessionIds).toEqual(["session-1"]);
    expect(toolDisplays).toHaveLength(1);
    expect(statusEvents.some((event) => event.type === "tool")).toBe(true);
    expect(statusEvents.some((event) => event.type === "text")).toBe(true);
    expect(result.fullResponse).toBe("hello world from query runtime stream");
    expect(result.toolDurations.Read?.count).toBe(1);
    expect(result.contextWindowSize).toBe(200000);
    expect(result.lastUsage).toEqual({
      input_tokens: 12,
      output_tokens: 6,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 1,
    });
    expect(result.queryCompleted).toBe(true);
  });

  test("BUG soma-wzyw: direct runtime prefers assistant-turn usage and lookup max for context state", async () => {
    const queryGeneration = 1;

    const events: SDKMessage[] = [
      {
        type: "system",
        subtype: "init",
        betas: ["context-1m-2025-08-07"],
        session_id: "session-1",
      } as unknown as SDKMessage,
      {
        type: "assistant",
        session_id: "session-1",
        message: {
          usage: {
            input_tokens: 2000,
            output_tokens: 400,
            cache_read_input_tokens: 300,
            cache_creation_input_tokens: 100,
          },
          content: [
            {
              type: "text",
              text: "assistant turn with usage payload",
            },
          ],
        },
      } as unknown as SDKMessage,
      {
        type: "result",
        modelUsage: {
          claude: {
            inputTokens: 4300,
            outputTokens: 900,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            contextWindow: 200000,
          },
        },
      } as unknown as SDKMessage,
    ];

    const result = await executeQueryRuntime({
      prompt: "hello",
      options: {
        model: "claude-opus-4-7",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async () => {},
      queryGeneration,
      getCurrentGeneration: () => queryGeneration,
      shouldStop: () => false,
      onSessionId: () => {},
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      queryFactory: () => toAsyncGenerator(events),
    });

    expect(result.contextWindowUsage).toEqual({
      input_tokens: 2000,
      output_tokens: 400,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    });
    expect(result.lastUsage).toEqual({
      input_tokens: 4300,
      output_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(result.contextWindowSize).toBe(1_000_000);
    expect(result.actualContextMax).toBe(1_000_000);
  });

  test("drops session id when generation changed mid-query", async () => {
    let observedSessionId: string | null = null;
    const queryGeneration = 1;
    const events: SDKMessage[] = [
      {
        type: "assistant",
        session_id: "session-ignored",
        message: { content: [] },
      } as unknown as SDKMessage,
    ];

    const result = await executeQueryRuntime({
      prompt: "hello",
      options: {
        model: "claude-opus-4-7",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async () => {},
      queryGeneration,
      getCurrentGeneration: () => queryGeneration + 1,
      shouldStop: () => false,
      onSessionId: (sessionId: string) => {
        observedSessionId = sessionId;
      },
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      queryFactory: () => toAsyncGenerator(events),
    });

    expect(observedSessionId).toBeNull();
    expect(result.fullResponse).toBe("No response from Claude.");
    expect(result.queryCompleted).toBe(false);
  });

  test("routes production runtime through provider orchestrator when configured", async () => {
    const executeCalls: Array<{
      primaryProviderId: string;
      fallbackProviderId?: string;
      prompt: string;
    }> = [];

    const orchestrator = {
      executeProviderQuery: async (params: {
        primaryProviderId: string;
        fallbackProviderId?: string;
        input: { prompt: string; queryId: string };
        onEvent: (event: {
          providerId: string;
          queryId: string;
          timestamp: number;
          type: string;
          providerSessionId?: string;
          resumed?: boolean;
          delta?: string;
          reason?: "completed" | "aborted" | "failed";
        }) => Promise<void>;
      }) => {
        executeCalls.push({
          primaryProviderId: params.primaryProviderId,
          fallbackProviderId: params.fallbackProviderId,
          prompt: params.input.prompt,
        });

        await params.onEvent({
          providerId: "codex",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "session",
          providerSessionId: "provider-session",
          resumed: false,
        });
        await params.onEvent({
          providerId: "codex",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "text",
          delta: "fallback text from provider orchestrator runtime",
        });
        await params.onEvent({
          providerId: "codex",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "done",
          reason: "completed",
        });

        return { providerId: "codex", attempts: 1 };
      },
    } as const;

    const observedSessionIds: string[] = [];
    const statusEvents: string[] = [];
    const result = await executeQueryRuntime({
      prompt: "hello from orchestrator runtime",
      options: {
        model: "claude-opus-4-7",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async (type) => {
        statusEvents.push(type);
      },
      queryGeneration: 1,
      getCurrentGeneration: () => 1,
      shouldStop: () => false,
      onSessionId: (sessionId: string) => {
        observedSessionIds.push(sessionId);
      },
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      providerExecution: {
        orchestrator:
          orchestrator as unknown as import("../../providers/orchestrator").ProviderOrchestrator,
        identity: createSessionIdentity({
          tenantId: "default",
          channelId: "chat-1",
          threadId: "main",
        }),
        primaryProviderId: "anthropic",
        fallbackProviderId: "codex",
      },
    });

    expect(executeCalls).toHaveLength(1);
    expect(executeCalls[0]).toEqual({
      primaryProviderId: "anthropic",
      fallbackProviderId: "codex",
      prompt: "hello from orchestrator runtime",
    });
    expect(observedSessionIds).toEqual(["provider-session"]);
    expect(statusEvents.some((type) => type === "text")).toBe(true);
    expect(result.providerId).toBe("codex");
    expect(result.fullResponse).toBe(
      "fallback text from provider orchestrator runtime"
    );
    expect(result.queryCompleted).toBe(true);
  });

  // Issue #79: production runs through the provider orchestrator, so the
  // permission callback must survive that hop or the Telegram round trip is
  // dead code in production.
  test("forwards canUseTool to the provider boundary", async () => {
    const canUseTool: CanUseTool = async () => ({
      behavior: "deny",
      message: "test",
    });
    let forwarded: unknown = "not-called";

    const orchestrator = {
      executeProviderQuery: async (params: {
        input: { queryId: string; canUseTool?: unknown };
        onEvent: (event: {
          providerId: string;
          queryId: string;
          timestamp: number;
          type: string;
          reason?: "completed" | "aborted" | "failed";
        }) => Promise<void>;
      }) => {
        forwarded = params.input.canUseTool;
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "done",
          reason: "completed",
        });
        return { providerId: "anthropic", attempts: 1 };
      },
    } as const;

    await executeQueryRuntime({
      prompt: "hello",
      options: {
        model: "claude-opus-4-7",
        cwd: "/tmp",
        abortController: new AbortController(),
        canUseTool,
      },
      statusCallback: async () => {},
      queryGeneration: 1,
      getCurrentGeneration: () => 1,
      shouldStop: () => false,
      onSessionId: () => {},
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      providerExecution: {
        orchestrator:
          orchestrator as unknown as import("../../providers/orchestrator").ProviderOrchestrator,
        identity: createSessionIdentity({
          tenantId: "default",
          channelId: "chat-1",
          threadId: "main",
        }),
        primaryProviderId: "anthropic",
      },
    });

    expect(forwarded).toBe(canUseTool);
  });

  test("BUG soma-wzyw: provider runtime keeps assistant-turn context and aggregate billing separate", async () => {
    const orchestrator = {
      executeProviderQuery: async (params: {
        primaryProviderId: string;
        fallbackProviderId?: string;
        input: { prompt: string; queryId: string };
        onEvent: (event: {
          providerId: string;
          queryId: string;
          timestamp: number;
          type: string;
          providerSessionId?: string;
          resumed?: boolean;
          delta?: string;
          reason?: "completed" | "aborted" | "failed";
          usage?: {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens?: number;
            cacheCreationInputTokens?: number;
            usageKind?: "assistant_turn" | "aggregate";
          };
          usedTokens?: number;
          maxTokens?: number;
        }) => Promise<void>;
      }) => {
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "session",
          providerSessionId: "provider-session",
          resumed: false,
        });
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "usage",
          usage: {
            inputTokens: 2000,
            outputTokens: 400,
            cacheReadInputTokens: 300,
            cacheCreationInputTokens: 100,
            usageKind: "assistant_turn",
          },
        });
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "usage",
          usage: {
            inputTokens: 4300,
            outputTokens: 900,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            usageKind: "aggregate",
          },
        });
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "context",
          usedTokens: 2800,
          maxTokens: 1_000_000,
        });
        await params.onEvent({
          providerId: "anthropic",
          queryId: params.input.queryId,
          timestamp: Date.now(),
          type: "done",
          reason: "completed",
        });

        return { providerId: "anthropic", attempts: 1 };
      },
    } as const;

    const result = await executeQueryRuntime({
      prompt: "hello from anthropic provider runtime",
      options: {
        model: "claude-opus-4-7",
        cwd: "/tmp",
        abortController: new AbortController(),
      },
      statusCallback: async () => {},
      queryGeneration: 1,
      getCurrentGeneration: () => 1,
      shouldStop: () => false,
      onSessionId: () => {},
      onToolDisplay: () => {},
      onRefreshContextWindowUsageFromTranscript: async () => null,
      queryStartedMs: Date.now(),
      providerExecution: {
        orchestrator:
          orchestrator as unknown as import("../../providers/orchestrator").ProviderOrchestrator,
        identity: createSessionIdentity({
          tenantId: "default",
          channelId: "chat-1",
          threadId: "main",
        }),
        primaryProviderId: "anthropic",
      },
    });

    expect(result.contextWindowUsage).toEqual({
      input_tokens: 2000,
      output_tokens: 400,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    });
    expect(result.lastUsage).toEqual({
      input_tokens: 4300,
      output_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(result.actualContextUsed).toBe(2800);
    expect(result.actualContextMax).toBe(1_000_000);
  });
});

describe("query-runtime metadata", () => {
  test("builds metadata with duration and provider info", () => {
    const metadata = buildQueryRuntimeMetadata({
      usageBefore: { fiveHour: 10, sevenDay: 20 },
      usageAfter: { fiveHour: 11, sevenDay: 21 },
      toolDurations: { Read: { count: 1, totalMs: 30 } },
      queryStartedMs: 1000,
      queryEndedMs: 1250,
      contextUsagePercent: 52,
      contextUsagePercentBefore: 49,
      modelDisplayName: "Claude Opus",
    });

    expect(metadata.queryDurationMs).toBe(250);
    expect(metadata.currentProvider).toBe("anthropic");
    expect(metadata.modelDisplayName).toBe("Claude Opus");
    expect(metadata.toolDurations.Read?.count).toBe(1);
  });
});
