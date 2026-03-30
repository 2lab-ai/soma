/**
 * Document handler for Claude Telegram Bot.
 *
 * Supports PDFs, image files, and text files with media group buffering.
 * PDF extraction uses pdftotext CLI (install via: brew install poppler)
 */

import type { Context } from "grammy";
import { sessionManager } from "../core/session/session-manager";
import { TEMP_DIR } from "../config";
import {
  type ChatType,
  isAuthorizedForChat,
  rateLimiter,
  shouldRespondInChat,
} from "../security";
import { auditLog, auditLogRateLimit } from "../utils/audit";
import { addTimestamp } from "../utils/interrupt";
import { startTypingIndicator } from "../utils/typing";
import { StreamingState, createStatusCallback } from "./streaming";
import { createMediaGroupBuffer, handleProcessingError } from "./media-group";
import { botUsername } from "./text";
import { Reactions } from "../constants/reactions";
import { downloadTelegramFile } from "../utils/telegram-file";
import { ensureSupportedImageFormat } from "../utils/image-format";
import { resolve } from "path";
import { sanitizeExtractedDir, isPathContained, isSymlink } from "../utils/archive-safety";

// Supported text file extensions
const TEXT_EXTENSIONS = [
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".xml",
  ".html",
  ".css",
  ".js",
  ".ts",
  ".py",
  ".sh",
  ".env",
  ".log",
  ".cfg",
  ".ini",
  ".toml",
];

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tiff", ".heic", ".avif"];
const IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpg",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/bmp",
  "image/tiff",
  "image/heic",
  "image/avif",
];

export function isImageDocumentType(fileName: string, mimeType?: string): boolean {
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  if (IMAGE_EXTENSIONS.includes(extension)) {
    return true;
  }

  return mimeType ? IMAGE_MIME_TYPES.includes(mimeType.toLowerCase()) : false;
}

function isImagePath(filePath: string): boolean {
  return isImageDocumentType(filePath);
}

// Supported archive extensions
const ARCHIVE_EXTENSIONS = [".zip", ".tar", ".tar.gz", ".tgz"];

// Max file size (10MB)
const MAX_FILE_SIZE = 10 * 1024 * 1024;

// Max content from archive (50K chars total)
const MAX_ARCHIVE_CONTENT = 50000;

// Create document-specific media group buffer
const documentBuffer = createMediaGroupBuffer({
  emoji: "📄",
  itemLabel: "document",
  itemLabelPlural: "documents",
});

/**
 * Download a document and return the local path.
 *
 * For image documents, validates the actual format from magic bytes and
 * converts unsupported formats to PNG. This prevents Claude Agent SDK
 * "unsupported image format" errors.
 */
async function downloadDocument(ctx: Context): Promise<string> {
  const doc = ctx.message?.document;
  if (!doc) {
    throw new Error("No document in message");
  }

  const fileName = doc.file_name || `doc_${Date.now()}`;
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");

  // Download via secure helper (token never exposed in errors)
  const rawBuffer = await downloadTelegramFile(ctx);

  // For image documents, validate and fix format before saving
  const isImage = isImageDocumentType(fileName, doc.mime_type);
  if (isImage) {
    const result = await ensureSupportedImageFormat(rawBuffer);
    if (!result) {
      throw new Error(
        `Unsupported image format for ${fileName}. Supported: JPEG, PNG, GIF, WebP.`
      );
    }

    // Use correct extension based on actual detected format
    const baseName = safeName.replace(/\.[^.]+$/, "");
    const docPath = `${TEMP_DIR}/${baseName}${result.extension}`;
    await Bun.write(docPath, result.buffer);
    return docPath;
  }

  // Non-image documents — save as-is
  const docPath = `${TEMP_DIR}/${safeName}`;
  await Bun.write(docPath, rawBuffer);
  return docPath;
}

/**
 * Extract text from a document.
 */
async function extractText(filePath: string, mimeType?: string): Promise<string> {
  const fileName = filePath.split("/").pop() || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();

  // PDF extraction using pdftotext CLI (install: brew install poppler)
  if (mimeType === "application/pdf" || extension === ".pdf") {
    try {
      const result = await Bun.$`pdftotext -layout ${filePath} -`.quiet();
      return result.text();
    } catch (error) {
      console.error("PDF parsing failed:", error);
      return "[PDF parsing failed - ensure pdftotext is installed: brew install poppler]";
    }
  }

  // Text files
  if (TEXT_EXTENSIONS.includes(extension) || mimeType?.startsWith("text/")) {
    const text = await Bun.file(filePath).text();
    // Limit to 100K chars
    return text.slice(0, 100000);
  }

  throw new Error(`Unsupported file type: ${extension || mimeType}`);
}

function buildImagePrompt(imagePaths: string[], caption?: string): string {
  if (imagePaths.length === 1) {
    return caption
      ? `[Image Document: ${imagePaths[0]}]\n\n${caption}`
      : `Please analyze this image: ${imagePaths[0]}`;
  }

  const imageList = imagePaths.map((path, index) => `${index + 1}. ${path}`).join("\n");
  return caption
    ? `[Image Documents:\n${imageList}]\n\n${caption}`
    : `Please analyze these ${imagePaths.length} images:\n${imageList}`;
}

async function processImageDocuments(
  ctx: Context,
  imagePaths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  threadId?: number
): Promise<void> {
  const session = sessionManager.getSession(chatId, threadId);

  await session.runSerializedQuery(async () => {
    const stopProcessing = session.startProcessing();

    try {
      await ctx.react(Reactions.PROCESSING);
    } catch {
      // Ignore reaction errors
    }

    const prompt = buildImagePrompt(imagePaths, caption);
    const typing = startTypingIndicator(ctx);
    const state = new StreamingState();
    const statusCallback = await createStatusCallback(ctx, state, session);

    try {
      const response = await session.sendMessageStreaming(
        addTimestamp(prompt),
        statusCallback,
        chatId
      );

      await auditLog(userId, username, "DOCUMENT_IMAGE", prompt, response);

      try {
        await ctx.react(Reactions.COMPLETE);
      } catch {
        // Ignore reaction errors
      }
    } catch (error) {
      await handleProcessingError(ctx, error, state.toolMessages, chatId, threadId);
    } finally {
      state.cleanup();
      stopProcessing();
      typing.stop();
    }
  });
}

async function processMixedDocumentInputs(
  ctx: Context,
  imagePaths: string[],
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  threadId?: number
): Promise<void> {
  const session = sessionManager.getSession(chatId, threadId);

  await session.runSerializedQuery(async () => {
    const stopProcessing = session.startProcessing();

    try {
      await ctx.react(Reactions.PROCESSING);
    } catch {
      // Ignore reaction errors
    }

    const imageSection =
      imagePaths.length === 1
        ? `Image:\n${imagePaths[0]}`
        : `Images:\n${imagePaths
            .map((path, index) => `${index + 1}. ${path}`)
            .join("\n")}`;
    const documentSection =
      documents.length === 1
        ? `Document: ${documents[0]!.name}\n\nContent:\n${documents[0]!.content}`
        : `${documents.length} Documents:\n\n${documents
            .map(
              (doc, index) =>
                `--- Document ${index + 1}: ${doc.name} ---\n${doc.content}`
            )
            .join("\n\n")}`;
    const promptBody = [imageSection, documentSection].join("\n\n");
    const prompt = caption
      ? `Please analyze these files:\n\n${promptBody}\n\n---\n\n${caption}`
      : `Please analyze these files:\n\n${promptBody}`;

    const typing = startTypingIndicator(ctx);
    const state = new StreamingState();
    const statusCallback = await createStatusCallback(ctx, state, session);

    try {
      const response = await session.sendMessageStreaming(
        addTimestamp(prompt),
        statusCallback,
        chatId
      );

      await auditLog(userId, username, "DOCUMENT_MIXED", prompt, response);

      try {
        await ctx.react(Reactions.COMPLETE);
      } catch {
        // Ignore reaction errors
      }
    } catch (error) {
      await handleProcessingError(ctx, error, state.toolMessages, chatId, threadId);
    } finally {
      state.cleanup();
      stopProcessing();
      typing.stop();
    }
  });
}

/**
 * Check if a file extension is an archive.
 */
function isArchive(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return ARCHIVE_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Get archive extension from filename.
 */
function getArchiveExtension(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".tar.gz")) return ".tar.gz";
  if (lower.endsWith(".tgz")) return ".tgz";
  if (lower.endsWith(".tar")) return ".tar";
  if (lower.endsWith(".zip")) return ".zip";
  return "";
}

/**
 * Extract an archive to a temp directory.
 */
async function extractArchive(archivePath: string, fileName: string): Promise<string> {
  const ext = getArchiveExtension(fileName);
  const extractDir = `${TEMP_DIR}/archive_${Date.now()}`;
  await Bun.$`mkdir -p ${extractDir}`;

  if (ext === ".zip") {
    await Bun.$`unzip -q -o ${archivePath} -d ${extractDir}`.quiet();
  } else if (ext === ".tar" || ext === ".tar.gz" || ext === ".tgz") {
    // --no-same-permissions prevents setuid bit preservation
    await Bun.$`tar --no-same-permissions -xf ${archivePath} -C ${extractDir}`.quiet();
  } else {
    throw new Error(`Unknown archive type: ${ext}`);
  }

  // Post-extraction security: remove path traversals and symlinks
  const removed = await sanitizeExtractedDir(extractDir);
  if (removed.length > 0) {
    console.warn(`[SECURITY] Archive ${fileName} contained dangerous entries:`, removed);
  }

  return extractDir;
}

/**
 * Build a file tree from a directory.
 */
async function buildFileTree(dir: string): Promise<string[]> {
  const entries = await Array.fromAsync(
    new Bun.Glob("**/*").scan({ cwd: dir, dot: false, followSymlinks: false })
  );
  entries.sort();
  return entries.slice(0, 100); // Limit to 100 files
}

/**
 * Extract text content from archive files.
 */
async function extractArchiveContent(extractDir: string): Promise<{
  tree: string[];
  contents: Array<{ name: string; content: string }>;
}> {
  const tree = await buildFileTree(extractDir);
  const contents: Array<{ name: string; content: string }> = [];
  let totalSize = 0;

  for (const relativePath of tree) {
    const fullPath = resolve(extractDir, relativePath);

    // Security: skip escaped paths and symlinks
    if (!isPathContained(extractDir, relativePath)) continue;
    if (isSymlink(fullPath)) continue;

    const stat = await Bun.file(fullPath).exists();
    if (!stat) continue;

    // Check if it's a directory
    const fileInfo = Bun.file(fullPath);
    const size = fileInfo.size;
    if (size === 0) continue;

    const ext = "." + (relativePath.split(".").pop() || "").toLowerCase();
    if (!TEXT_EXTENSIONS.includes(ext)) continue;

    // Skip large files
    if (size > 100000) continue;

    try {
      const text = await fileInfo.text();
      const truncated = text.slice(0, 10000); // 10K per file max
      if (totalSize + truncated.length > MAX_ARCHIVE_CONTENT) break;
      contents.push({ name: relativePath, content: truncated });
      totalSize += truncated.length;
    } catch {
      // Skip binary or unreadable files
    }
  }

  return { tree, contents };
}

/**
 * Process an archive file.
 */
async function processArchive(
  ctx: Context,
  archivePath: string,
  fileName: string,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  threadId?: number
): Promise<void> {
  const session = sessionManager.getSession(chatId, threadId);

  await session.runSerializedQuery(async () => {
    const stopProcessing = session.startProcessing();

    // Update reaction to show processing
    try {
      await ctx.react(Reactions.PROCESSING);
    } catch {
      // Ignore reaction errors
    }

    const typing = startTypingIndicator(ctx);
    const state = new StreamingState();

    // Show extraction progress
    const statusMsg = await ctx.reply(`📦 Extracting <b>${fileName}</b>...`, {
      parse_mode: "HTML",
    });

    try {
      // Extract archive
      console.log(`Extracting archive: ${fileName}`);
      const extractDir = await extractArchive(archivePath, fileName);
      const { tree, contents } = await extractArchiveContent(extractDir);
      console.log(`Extracted: ${tree.length} files, ${contents.length} readable`);

      // Update status
      await ctx.api.editMessageText(
        statusMsg.chat.id,
        statusMsg.message_id,
        `📦 Extracted <b>${fileName}</b>: ${tree.length} files, ${contents.length} readable`,
        { parse_mode: "HTML" }
      );

      // Build prompt
      const treeStr = tree.length > 0 ? tree.join("\n") : "(empty)";
      const contentsStr =
        contents.length > 0
          ? contents
              .map(
                (c) => `--- ${c.name} ---
${c.content}`
              )
              .join("\n\n")
          : "(no readable text files)";

      const prompt = caption
        ? `Archive: ${fileName}

File tree (${tree.length} files):
${treeStr}

Extracted contents:
${contentsStr}

---

${caption}`
        : `Please analyze this archive (${fileName}):

File tree (${tree.length} files):
${treeStr}

Extracted contents:
${contentsStr}`;

      // Create streaming callback
      const statusCallback = await createStatusCallback(ctx, state, session);

      const response = await session.sendMessageStreaming(
        addTimestamp(prompt),
        statusCallback,
        chatId
      );

      await auditLog(
        userId,
        username,
        "ARCHIVE",
        `[${fileName}] ${caption || ""}`,
        response
      );

      // Update reaction to show complete
      try {
        await ctx.react(Reactions.COMPLETE);
      } catch {
        // Ignore reaction errors
      }

      // Cleanup
      await Bun.$`rm -rf ${extractDir}`.quiet();

      // Delete status message
      try {
        await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
      } catch {
        // Ignore deletion errors
      }
    } catch (error) {
      console.error("Archive processing error:", error);
      // Delete status message on error
      try {
        await ctx.api.deleteMessage(statusMsg.chat.id, statusMsg.message_id);
      } catch {
        // Ignore
      }
      await ctx.reply(`❌ Failed to process archive: ${String(error).slice(0, 100)}`);
    } finally {
      state.cleanup();
      stopProcessing();
      typing.stop();
    }
  });
}

/**
 * Process documents with Claude.
 */
async function processDocuments(
  ctx: Context,
  documents: Array<{ path: string; name: string; content: string }>,
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  threadId?: number
): Promise<void> {
  // Get session for this chat/thread
  const session = sessionManager.getSession(chatId, threadId);

  await session.runSerializedQuery(async () => {
    // Mark processing started
    const stopProcessing = session.startProcessing();

    // Update reaction to show processing
    try {
      await ctx.react(Reactions.PROCESSING);
    } catch {
      // Ignore reaction errors
    }

    // Build prompt
    let prompt: string;
    if (documents.length === 1) {
      const doc = documents[0]!;
      prompt = caption
        ? `Document: ${doc.name}

Content:
${doc.content}

---

${caption}`
        : `Please analyze this document (${doc.name}):

${doc.content}`;
    } else {
      const docList = documents
        .map(
          (d, i) => `--- Document ${i + 1}: ${d.name} ---
${d.content}`
        )
        .join("\n\n");
      prompt = caption
        ? `${documents.length} Documents:

${docList}

---

${caption}`
        : `Please analyze these ${documents.length} documents:

${docList}`;
    }

    // Start typing
    const typing = startTypingIndicator(ctx);

    // Create streaming state
    const state = new StreamingState();
    const statusCallback = await createStatusCallback(ctx, state);

    try {
      const response = await session.sendMessageStreaming(
        addTimestamp(prompt),
        statusCallback,
        chatId
      );

      await auditLog(
        userId,
        username,
        "DOCUMENT",
        `[${documents.length} docs] ${caption || ""}`,
        response
      );

      // Update reaction to show complete
      try {
        await ctx.react(Reactions.COMPLETE);
      } catch {
        // Ignore reaction errors
      }
    } catch (error) {
      await handleProcessingError(ctx, error, state.toolMessages, chatId, threadId);
    } finally {
      state.cleanup();
      stopProcessing();
      typing.stop();
    }
  });
}

/**
 * Process document paths by extracting text and calling processDocuments.
 */
async function processDocumentPaths(
  ctx: Context,
  paths: string[],
  caption: string | undefined,
  userId: number,
  username: string,
  chatId: number,
  threadId?: number
): Promise<void> {
  const imagePaths = paths.filter((path) => isImagePath(path));
  const textPaths = paths.filter((path) => !isImagePath(path));
  const documents: Array<{ path: string; name: string; content: string }> = [];

  for (const path of textPaths) {
    try {
      const name = path.split("/").pop() || "document";
      const content = await extractText(path);
      documents.push({ path, name, content });
    } catch (error) {
      console.error("Failed to extract " + path + ":", error);
    }
  }

  if (imagePaths.length > 0 && documents.length > 0) {
    await processMixedDocumentInputs(
      ctx,
      imagePaths,
      documents,
      caption,
      userId,
      username,
      chatId,
      threadId
    );
    return;
  }

  if (imagePaths.length > 0) {
    await processImageDocuments(
      ctx,
      imagePaths,
      caption,
      userId,
      username,
      chatId,
      threadId
    );
    return;
  }

  if (documents.length === 0) {
    await ctx.reply("❌ Failed to extract any documents.");
    return;
  }

  await processDocuments(ctx, documents, caption, userId, username, chatId, threadId);
}

/**
 * Handle incoming document messages.
 */
export async function handleDocument(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username || "unknown";
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type as ChatType | undefined;
  const threadId = ctx.message?.message_thread_id;
  const doc = ctx.message?.document;
  const mediaGroupId = ctx.message?.media_group_id;
  const caption = ctx.message?.caption;

  if (userId == null || chatId == null || doc == null) {
    return;
  }

  if (!isAuthorizedForChat(userId, chatId, chatType)) {
    if (chatType === "private") {
      await ctx.reply("Unauthorized. Contact the bot owner for access.");
    }
    return;
  }

  const isReplyToBot = Boolean(
    ctx.message?.reply_to_message?.from?.is_bot &&
    ctx.message?.reply_to_message?.from?.username === botUsername
  );
  if (!shouldRespondInChat(chatId, chatType, caption, botUsername, isReplyToBot)) {
    return;
  }

  try {
    await ctx.react(Reactions.READ);
  } catch (error) {
    console.debug("Failed to add reaction to user message:", error);
  }

  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    await ctx.reply("❌ File too large. Maximum size is 10MB.");
    return;
  }

  const fileName = doc.file_name || "";
  const extension = "." + (fileName.split(".").pop() || "").toLowerCase();
  const isPdf = doc.mime_type === "application/pdf" || extension === ".pdf";
  const isText =
    TEXT_EXTENSIONS.includes(extension) || doc.mime_type?.startsWith("text/");
  const isImage = isImageDocumentType(fileName, doc.mime_type);
  const isArchiveFile = isArchive(fileName);

  if ((isPdf || isText || isImage || isArchiveFile) === false) {
    await ctx.reply(
      "❌ Unsupported file type: " +
        (extension || doc.mime_type) +
        "\n\nSupported: PDF, images (" +
        IMAGE_EXTENSIONS.join(", ") +
        "), archives (" +
        ARCHIVE_EXTENSIONS.join(", ") +
        "), " +
        TEXT_EXTENSIONS.join(", ")
    );
    return;
  }

  let docPath: string;
  try {
    docPath = await downloadDocument(ctx);
  } catch (error) {
    console.error("Failed to download document:", error);
    await ctx.reply("❌ Failed to download document.");
    return;
  }

  if (isArchiveFile) {
    console.log("Received archive: " + fileName + " from @" + username);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (allowed === false) {
      const waitSeconds = retryAfter ?? 0;
      await auditLogRateLimit(userId, username, waitSeconds);
      await ctx.reply(
        "⏳ Rate limited. Please wait " + waitSeconds.toFixed(1) + " seconds."
      );
      return;
    }

    await processArchive(
      ctx,
      docPath,
      fileName,
      caption,
      userId,
      username,
      chatId,
      threadId
    );
    return;
  }

  if (!mediaGroupId) {
    console.log("Received document: " + fileName + " from @" + username);
    const [allowed, retryAfter] = rateLimiter.check(userId);
    if (allowed === false) {
      const waitSeconds = retryAfter ?? 0;
      await auditLogRateLimit(userId, username, waitSeconds);
      await ctx.reply(
        "⏳ Rate limited. Please wait " + waitSeconds.toFixed(1) + " seconds."
      );
      return;
    }

    try {
      if (isImage) {
        await processImageDocuments(
          ctx,
          [docPath],
          caption,
          userId,
          username,
          chatId,
          threadId
        );
        return;
      }

      const content = await extractText(docPath, doc.mime_type);
      await processDocuments(
        ctx,
        [{ path: docPath, name: fileName, content }],
        caption,
        userId,
        username,
        chatId,
        threadId
      );
    } catch (error) {
      console.error("Failed to extract document:", error);
      await ctx.reply("❌ Failed to process document: " + String(error).slice(0, 100));
    }
    return;
  }

  await documentBuffer.addToGroup(
    mediaGroupId,
    docPath,
    ctx,
    userId,
    username,
    processDocumentPaths,
    threadId
  );
}
