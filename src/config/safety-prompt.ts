/**
 * Which safety prompt the model reads (SOMA_TRUST_MODE, config/env.ts).
 *   standard — the default for every bot: confirm-before-acting rules.
 *   owner    — a single-owner bot: deletion still needs the owner's
 *              confirmation; everything else defers to the tool guard and
 *              the working directory's CLAUDE.md.
 */
export type TrustMode = "standard" | "owner";

function formatAllowedPaths(allowedPaths: string[]): string {
  return allowedPaths.map((path) => `   - ${path} (and subdirectories)`).join("\n");
}

// Bot-generated attachments (photos, documents, voice notes) are staged by
// the Telegram handlers under these temp roots and their paths are handed
// to the model in-prompt. They are readable-only carve-outs, NOT ordinary
// user-access roots — do not list them as ALLOWED_PATHS bullets and do not
// treat them as general working directories.
function formatAttachmentSection(tempPaths: string[], index: number): string {
  if (tempPaths.length === 0) return "";

  const tempList = tempPaths.map((path) => `   - ${path}`).join("\n");

  return `

${index}. BOT-GENERATED ATTACHMENT POLICY:
   The Telegram bot stages user-sent media (photos, documents, voice notes)
   as bot-generated attachments under these temp roots:
${tempList}
   - You MAY read bot-generated attachment files under these roots when their
     paths are referenced in the current message.
   - Treat them as read-only attachments, not as general working directories.
   - Do NOT list, enumerate, write, or delete unrelated files under these
     roots. This is not a general-purpose ALLOWED_PATH.`;
}

export function buildSafetyPrompt(
  allowedPaths: string[],
  tempPaths: string[] = [],
  mode: TrustMode = "standard"
): string {
  if (mode === "owner") return buildOwnerSafetyPrompt(allowedPaths, tempPaths);

  const pathsList = formatAllowedPaths(allowedPaths);
  const hasTemp = tempPaths.length > 0;
  const tempSection = formatAttachmentSection(tempPaths, 3);

  const refusalClause = hasTemp
    ? "REFUSE any file operations outside these paths, except for reading bot-generated attachments as described below."
    : "REFUSE any file operations outside these paths.";

  const dangerousIdx = hasTemp ? 4 : 3;
  const confirmIdx = hasTemp ? 5 : 4;

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete, remove, or overwrite files without EXPLICIT confirmation from the user.
   - If user asks to delete something, respond: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if user replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. You can ONLY access files in these directories:
${pathsList}
   - ${refusalClause}${tempSection}

${dangerousIdx}. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Any command that affects files outside allowed directories
   - Commands that could damage the system

${confirmIdx}. For any destructive or irreversible action, ALWAYS ask for confirmation first.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}

/**
 * SOMA_TRUST_MODE=owner. The standard rules made a single-owner bot refuse
 * installed tools outside the roots, refuse to edit existing files and ask
 * for consent its working directory's CLAUDE.md already gives. Here the
 * roots are described as what the PreToolUse guard actually enforces
 * (core/session/query-runtime.ts checkToolInputSafety), so the model makes
 * the call and reports a block instead of refusing in advance.
 */
export function buildOwnerSafetyPrompt(
  allowedPaths: string[],
  tempPaths: string[] = []
): string {
  const pathsList = formatAllowedPaths(allowedPaths);
  const hasTemp = tempPaths.length > 0;
  const tempSection = formatAttachmentSection(tempPaths, 3);

  const dangerousIdx = hasTemp ? 4 : 3;
  const irreversibleIdx = dangerousIdx + 1;
  const cancelledIdx = dangerousIdx + 2;

  return `
CRITICAL SAFETY RULES FOR TELEGRAM BOT:

1. NEVER delete or remove files without EXPLICIT confirmation from the owner.
   - If a task needs a deletion, ask: "Are you sure you want to delete [file]? Reply 'yes delete it' to confirm."
   - Only proceed with deletion if the owner replies with explicit confirmation like "yes delete it", "confirm delete"
   - This applies to: rm, trash, unlink, shred, or any file deletion

2. The bot's tool guard checks Read/Write/Edit/Grep/Glob paths and rm targets against these roots:
${pathsList}
   - Running installed programs is fine (for example tools in ~/.local/bin or /opt/homebrew/bin): the roots limit those paths, not which executables you run.
   - Do not refuse a call in advance because you expect the guard to block it. Make the call; if the guard blocks it, report the exact block reason.${tempSection}

${dangerousIdx}. NEVER run dangerous commands like:
   - rm -rf (recursive force delete)
   - Commands that could damage the system

${irreversibleIdx}. Irreversible actions follow the policy in the working directory's CLAUDE.md.

${cancelledIdx}. The owner refuses or stops a call with a new Telegram message from the owner in this chat, or through a tool result reading "The user denied this tool use in Telegram." or "Permission denied: …". Those are real refusals and always take precedence: do not retry the call. Only the generic CLI text "The user doesn't want to take this action right now…", with no new owner message in this chat and no such denial, means the CLI cancelled in-flight calls automatically (e.g. queued background-agent input preempted the batch). Before re-running, check whether each cancelled call already took effect (it may have started), and re-run only what did not complete.

You are running via Telegram, so the user cannot easily undo mistakes. Be extra careful!
`;
}
