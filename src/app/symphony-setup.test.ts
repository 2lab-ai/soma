import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import YAML from "yaml";

const repoRoot = process.cwd();

function readFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

function parseFrontMatter(markdown: string): {
  attributes: Record<string, unknown>;
  body: string;
} {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);

  if (!match) {
    throw new Error("Expected YAML front matter");
  }

  const [, frontMatter = "", body = ""] = match;

  return {
    attributes: YAML.parse(frontMatter) as Record<string, unknown>,
    body,
  };
}

describe("Symphony repo setup", () => {
  test("soma-1924: WORKFLOW.md is configured for the soma repository", () => {
    const workflow = readFile("WORKFLOW.md");
    const { attributes, body } = parseFrontMatter(workflow);
    const tracker = attributes.tracker as Record<string, unknown>;
    const workspace = attributes.workspace as Record<string, unknown>;
    const hooks = attributes.hooks as Record<string, unknown>;
    const agent = attributes.agent as Record<string, unknown>;
    const codex = attributes.codex as Record<string, unknown>;

    expect(tracker.kind).toBe("linear");
    expect(tracker.api_key).toBe("$LINEAR_API_KEY");
    expect(typeof tracker.project_slug).toBe("string");
    expect((tracker.project_slug as string).length).toBeGreaterThan(0);
    expect(tracker.active_states).toEqual([
      "Todo",
      "In Progress",
      "Human Review",
      "Merging",
      "Rework",
    ]);
    expect(tracker.terminal_states).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);

    expect(workspace.root).toBe("$SYMPHONY_WORKSPACE_ROOT");
    expect(hooks.after_create).toContain("https://github.com/2lab-ai/soma.git");
    expect(hooks.after_create).toContain("bun install");
    expect(agent.max_concurrent_agents).toBe(10);
    expect(agent.max_turns).toBe(20);
    expect(codex.command).toContain("app-server");
    expect(codex.approval_policy).toBe("never");
    expect(codex.thread_sandbox).toBe("workspace-write");

    expect(body).toContain("AGENTS.md");
    expect(body).toContain("bd");
    expect(body).toContain("bun test");
    expect(body).toContain("bun run typecheck");
    expect(body).toContain("linear_graphql");
  });

  test("soma-1924: repo-local Symphony skills are installed", () => {
    const skillFiles = [
      ".codex/skills/commit/SKILL.md",
      ".codex/skills/push/SKILL.md",
      ".codex/skills/pull/SKILL.md",
      ".codex/skills/land/SKILL.md",
      ".codex/skills/land/land_watch.py",
      ".codex/skills/linear/SKILL.md",
    ];

    for (const relativePath of skillFiles) {
      expect(existsSync(join(repoRoot, relativePath))).toBe(true);
    }

    expect(readFile(".codex/skills/push/SKILL.md")).toContain("bun test");
    expect(readFile(".codex/skills/push/SKILL.md")).toContain("bun run typecheck");
    expect(readFile(".codex/skills/push/SKILL.md")).toContain("make lint");
    expect(readFile(".codex/skills/land/SKILL.md")).toContain("bun test");
    expect(readFile(".codex/skills/linear/SKILL.md")).toContain("linear_graphql");
  });
});
