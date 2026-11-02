import { describe, expect, test } from "bun:test";
import { buildSafetyPrompt } from "./safety-prompt";
import { ALLOWED_PATHS, SAFETY_PROMPT, TEMP_DIR, TRUST_MODE } from "./index";
import { resolveTempDir } from "./env";
import { USER_DENIED_MESSAGE } from "../core/session/permission-broker";

// Regression: agi-2ry
//
// Telegram media handlers (src/handlers/photo.ts:61, src/handlers/document.ts:126/132,
// src/handlers/voice.ts:104) write bot-generated attachments under a single
// staging root TEMP_DIR=/tmp/soma and reference those paths in the prompt.
// src/security.ts:98-103 additionally permits broader runtime-compat roots
// (TEMP_PATHS = ["/tmp/", "/private/tmp/", "/var/folders/"]) at the
// isPathAllowed layer, but the *safety prompt* the model reads must NOT
// advertise those broader roots — they are executable-layer compatibility,
// not model-facing policy. Advertising them would over-broaden the read
// carve-out relative to what the bot actually creates.
//
// Desired contract: buildSafetyPrompt must distinguish ordinary user-access
// roots (ALLOWED_PATHS) from the bot's own attachment staging root
// (TEMP_DIR), permit reading bot-generated attachments under TEMP_DIR, and
// NOT list TEMP_DIR as an ordinary ALLOWED_PATH.
describe("buildSafetyPrompt (agi-2ry telegram temp-policy)", () => {
  const ALLOWED = ["/Users/bot/Documents", "/Users/bot/Downloads"];
  const TEMP_DIR = "/tmp/soma";
  const TEMP = [TEMP_DIR];

  test("BUG agi-2ry: prompt distinguishes bot temp attachment root from ALLOWED_PATHS", () => {
    const prompt = buildSafetyPrompt(ALLOWED, TEMP);

    // 1) Temp attachment policy must be explicitly stated (bot-generated
    //    files under TEMP_DIR are readable). Match trailing-slash-safe:
    //    the staging root must appear either bare or with a trailing "/".
    expect(prompt).toMatch(/tmp|attachment|bot-generated/i);
    for (const tempPath of TEMP) {
      const escaped = tempPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(prompt).toMatch(new RegExp(`${escaped}/?`));
    }

    // 2) TEMP_DIR must NOT be listed as an ordinary ALLOWED_PATHS bullet
    //    (it's a separate class: readable bot-generated attachments, not a
    //    general user-access root).
    const allowedBulletLine = (p: string) => `- ${p} (and subdirectories)`;
    for (const tempPath of TEMP) {
      expect(prompt).not.toContain(allowedBulletLine(tempPath));
    }

    // 3) Broader runtime-compat roots MUST NOT leak into the model-facing
    //    prompt — those are executable-layer only (src/security.ts:98-103,
    //    src/core/session/query-runtime.ts `checkToolInputSafety`).
    expect(prompt).not.toContain("/private/tmp/");
    expect(prompt).not.toContain("/var/folders/");

    // 4) The blanket "REFUSE any file operations outside these paths" line
    //    must be qualified so that bot-generated temp attachments are not
    //    swept into the refusal.
    const blanketRefusal = /REFUSE any file operations outside these paths\s*$/m;
    expect(prompt).not.toMatch(blanketRefusal);
  });
});

// Regression: agi-2ry (exported wiring)
//
// buildSafetyPrompt is only the shape; the exported SAFETY_PROMPT is what the
// live session.ts hands to the model (src/core/session/session.ts:862). The
// shape test above is worthless if config/index.ts wires it with the wrong
// input — e.g. passing TEMP_PATHS (["/tmp/","/private/tmp/","/var/folders/"])
// instead of [TEMP_DIR] would silently re-broaden the model-facing carve-out.
// Assert the actual exported string here.
describe("SAFETY_PROMPT (exported wiring)", () => {
  test("BUG agi-2ry: advertises /tmp/soma as the sole attachment root, hides runtime-compat roots", () => {
    // Bot-generated attachment root that the Telegram handlers stage under
    // must appear. (test/preload.ts points TEMP_DIR at scratch; production is
    // /tmp/soma — pinned by the resolveTempDir test below.)
    expect(SAFETY_PROMPT).toContain(TEMP_DIR);

    // Runtime-compat siblings (executable-layer only) MUST NOT leak into the
    // model-facing prompt. The user-access roots themselves may legitimately
    // live under those prefixes (test/preload.ts realpaths WORKING_DIR, so a
    // checkout under /tmp yields /private/tmp/...), so mask them first.
    const compatPrefixed = [...ALLOWED_PATHS, TEMP_DIR].filter(
      (root) => root.startsWith("/private/tmp/") || root.startsWith("/var/folders/")
    );
    const withoutAllowedRoots = compatPrefixed.reduce(
      (prompt, root) => prompt.split(root).join("<ALLOWED_ROOT>"),
      SAFETY_PROMPT
    );
    expect(withoutAllowedRoots).not.toContain("/private/tmp");
    expect(withoutAllowedRoots).not.toContain("/var/folders");

    // Attachment policy must explicitly narrow reads to attachments called
    // out in the current message and mark them read-only. Without both, the
    // carve-out drifts back into "general working directory" territory.
    expect(SAFETY_PROMPT).toContain("referenced in the current message");
    expect(SAFETY_PROMPT).toContain("read-only");
  });
});

// SOMA_TRUST_MODE=standard (the default) must keep the prompt every other bot
// already runs with byte for byte. Golden strings captured from the builder
// before trust modes existed.
const STANDARD_PROMPT_WITH_TEMP = [
  "",
  "CRITICAL SAFETY RULES FOR TELEGRAM BOT:",
  "",
  "1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.",
  "   - If user asks to delete something, respond: \"Are you sure you want to delete [file]? Reply 'yes delete it' to confirm.\"",
  '   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"',
  "   - This applies to: rm, trash, unlink, shred, or any file deletion",
  "",
  "2. You can ONLY access files in these directories:",
  "   - /a/root (and subdirectories)",
  "   - /b/root (and subdirectories)",
  "   - REFUSE any file operations outside these paths, except for reading bot-generated attachments as described below.",
  "",
  "3. BOT-GENERATED ATTACHMENT POLICY:",
  "   The Telegram bot stages user-sent media (photos, documents, voice notes)",
  "   as bot-generated attachments under these temp roots:",
  "   - /tmp/soma",
  "   - You MAY read bot-generated attachment files under these roots when their",
  "     paths are referenced in the current message.",
  "   - Treat them as read-only attachments, not as general working directories.",
  "   - Do NOT list, enumerate, write, or delete unrelated files under these",
  "     roots. This is not a general-purpose ALLOWED_PATH.",
  "",
  "4. NEVER run dangerous commands like:",
  "   - rm -rf (recursive force delete)",
  "   - Any command that affects files outside allowed directories",
  "   - Commands that could damage the system",
  "",
  "5. For any destructive or irreversible action, ALWAYS ask for confirmation first.",
  "",
  "You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!",
  "",
].join("\n");

const STANDARD_PROMPT_WITHOUT_TEMP = [
  "",
  "CRITICAL SAFETY RULES FOR TELEGRAM BOT:",
  "",
  "1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.",
  "   - If user asks to delete something, respond: \"Are you sure you want to delete [file]? Reply 'yes delete it' to confirm.\"",
  '   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"',
  "   - This applies to: rm, trash, unlink, shred, or any file deletion",
  "",
  "2. You can ONLY access files in these directories:",
  "   - /a/root (and subdirectories)",
  "   - REFUSE any file operations outside these paths.",
  "",
  "3. NEVER run dangerous commands like:",
  "   - rm -rf (recursive force delete)",
  "   - Any command that affects files outside allowed directories",
  "   - Commands that could damage the system",
  "",
  "4. For any destructive or irreversible action, ALWAYS ask for confirmation first.",
  "",
  "You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!",
  "",
].join("\n");

describe("buildSafetyPrompt (SOMA_TRUST_MODE=standard)", () => {
  test("is byte-identical to the pre-trust-mode prompt", () => {
    expect(buildSafetyPrompt(["/a/root", "/b/root"], ["/tmp/soma"])).toBe(
      STANDARD_PROMPT_WITH_TEMP
    );
    expect(buildSafetyPrompt(["/a/root"])).toBe(STANDARD_PROMPT_WITHOUT_TEMP);
  });

  test("an explicit standard mode is the same prompt", () => {
    expect(buildSafetyPrompt(["/a/root", "/b/root"], ["/tmp/soma"], "standard")).toBe(
      STANDARD_PROMPT_WITH_TEMP
    );
    expect(buildSafetyPrompt(["/a/root"], [], "standard")).toBe(
      STANDARD_PROMPT_WITHOUT_TEMP
    );
  });

  test("the exported SAFETY_PROMPT is the standard prompt when SOMA_TRUST_MODE is unset", () => {
    expect(TRUST_MODE).toBe("standard");
    expect(SAFETY_PROMPT).toBe(buildSafetyPrompt(ALLOWED_PATHS, [TEMP_DIR]));
  });
});

// Regression: choa owner bot refused its own pipeline.
//
// The standard rules ("You can ONLY access files in these directories …
// REFUSE …", "NEVER … overwrite … without EXPLICIT confirmation", "ALWAYS ask
// for confirmation" on irreversible actions) made a single-owner bot refuse
// installed tools outside the roots, refuse to edit existing files, and ask
// consent the working directory's CLAUDE.md already gives. Owner mode keeps
// the deletion and rm -rf rules and points the model at the real guard.
describe("BUG choa-owner-trust: buildSafetyPrompt (SOMA_TRUST_MODE=owner)", () => {
  const owner = buildSafetyPrompt(["/a/root", "/b/root"], ["/tmp/soma"], "owner");
  const ownerNoTemp = buildSafetyPrompt(["/a/root"], [], "owner");

  test("keeps the deletion rule, drops overwrite and the blanket refusal", () => {
    for (const prompt of [owner, ownerNoTemp]) {
      expect(prompt).toContain(
        "NEVER delete or remove files without EXPLICIT confirmation from the owner."
      );
      expect(prompt).toContain(
        "This applies to: rm, trash, unlink, shred, or any file deletion"
      );
      expect(prompt).not.toContain("REFUSE");
      expect(prompt).not.toMatch(/overwrite/i);
      expect(prompt).not.toContain("ALWAYS ask for confirmation");
      expect(prompt).not.toContain(
        "Any command that affects files outside allowed directories"
      );
    }
  });

  test("lists the roots as what the tool guard enforces, without pre-refusal", () => {
    expect(owner).toContain(
      "   - /a/root (and subdirectories)\n   - /b/root (and subdirectories)"
    );
    expect(ownerNoTemp).toContain("   - /a/root (and subdirectories)");
    // Owner mode skips the Bash file-argument check, so the prompt names only
    // what the guard still checks (query-runtime.ts checkToolInputSafety).
    expect(owner).toContain(
      "2. The bot's tool guard checks Read/Write/Edit/Grep/Glob paths and rm targets against these roots:"
    );
    expect(owner).not.toContain("file arguments");
    expect(owner).toContain("Running installed programs is fine");
    expect(owner).toContain("report the exact block reason");
  });

  test("keeps the rm -rf rule, the CLAUDE.md policy pointer and the Telegram line", () => {
    for (const prompt of [owner, ownerNoTemp]) {
      expect(prompt).toContain(
        "   - rm -rf (recursive force delete)\n   - Commands that could damage the system"
      );
      expect(prompt).toContain(
        "Irreversible actions follow the policy in the working directory's CLAUDE.md."
      );
      expect(prompt).toContain(
        "You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!"
      );
    }
  });

  // Review REJECT B1: owner refusals reach the model as a new Telegram message
  // or a permission-broker denial; those always win. Only the bare CLI cancel
  // text, with neither, is an automatic cancellation — and a cancelled call
  // may already have started, so it is checked before it is re-run.
  test("owner refusals win; only the bare CLI cancel text is a cancellation", () => {
    for (const prompt of [owner, ownerNoTemp]) {
      // The broker's real denial strings are named as refusals.
      expect(prompt).toContain(`"${USER_DENIED_MESSAGE}"`);
      expect(prompt).toContain('"Permission denied: …"');
      expect(prompt).toContain("a new Telegram message from the owner in this chat");
      expect(prompt).toContain("real refusals and always take precedence");
      expect(prompt).toContain(
        'Only the generic CLI text "The user doesn\'t want to take this action right now…"'
      );
      expect(prompt).toContain("queued background-agent input preempted the batch");
    }
  });

  test("a cancelled call is checked before it is re-run", () => {
    for (const prompt of [owner, ownerNoTemp]) {
      expect(prompt).toContain(
        "Before re-running, check whether each cancelled call already took effect"
      );
      expect(prompt).toContain("re-run only what did not complete");
      expect(prompt).not.toContain("re-run the cancelled calls.");
    }
  });

  test("keeps the bot-generated attachment section as-is when temp roots exist", () => {
    const attachmentSection = STANDARD_PROMPT_WITH_TEMP.slice(
      STANDARD_PROMPT_WITH_TEMP.indexOf("3. BOT-GENERATED ATTACHMENT POLICY:"),
      STANDARD_PROMPT_WITH_TEMP.indexOf("\n\n4. NEVER run dangerous commands")
    );
    expect(owner).toContain(attachmentSection);
    expect(ownerNoTemp).not.toContain("BOT-GENERATED ATTACHMENT POLICY");
  });

  test("numbers the rules consecutively", () => {
    const numbers = (prompt: string) =>
      [...prompt.matchAll(/^(\d+)\. /gm)].map((match) => Number(match[1]));
    expect(numbers(owner)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(numbers(ownerNoTemp)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("resolveTempDir (attachment staging root)", () => {
  test("is /tmp/soma in production, whatever SOMA_TEMP_DIR says", () => {
    expect(resolveTempDir({})).toBe("/tmp/soma");
    expect(resolveTempDir({ NODE_ENV: "production", SOMA_TEMP_DIR: "/elsewhere" })).toBe("/tmp/soma");
  });

  test("honours SOMA_TEMP_DIR only under bun test (NODE_ENV=test)", () => {
    expect(resolveTempDir({ NODE_ENV: "test", SOMA_TEMP_DIR: "/scratch/attachments" })).toBe(
      "/scratch/attachments"
    );
    expect(resolveTempDir({ NODE_ENV: "test", SOMA_TEMP_DIR: "  " })).toBe("/tmp/soma");
  });
});
