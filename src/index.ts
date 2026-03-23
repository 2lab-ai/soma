/**
 * Claude Telegram Bot entrypoint.
 *
 * Runtime wiring is delegated to src/app/* modules.
 * This file keeps process-level signal hooks only.
 */

import { writeFileSync } from "fs";
import { bootstrapApplication } from "./app/bootstrap";

const CRASH_MARKER_FILE = "/tmp/soma-crash-marker.json";

/**
 * Write a crash marker so next boot knows WHY we restarted.
 * Reason types:
 *   "sigterm"  — graceful shutdown (make up, systemctl restart)
 *   "sigint"   — Ctrl+C
 *   "uncaughtException" — unhandled exception crashed process
 *   "unhandledRejection" — unhandled promise rejection crashed process
 */
function writeCrashMarker(reason: string, error?: unknown): void {
  try {
    const errorStr = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ""}`
      : error != null ? String(error) : undefined;

    writeFileSync(
      CRASH_MARKER_FILE,
      JSON.stringify({
        reason,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        error: errorStr?.slice(0, 2000),
      }),
      "utf-8"
    );
  } catch {
    // If we can't write the marker, at least log it
    console.error(`[CRASH-MARKER] Failed to write marker for reason=${reason}`);
  }
}

const app = await bootstrapApplication();
export const formStore = app.formStore;

let shuttingDown = false;

// ============================================================
// SIGNAL HANDLERS
// ============================================================

process.on("SIGINT", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] ========== SIGINT RECEIVED ==========`);
  console.log("[SIGINT] Ctrl+C detected, stopping without save...");
  writeCrashMarker("sigint");
  app.stopRunner();
  console.log("[SIGINT] Exiting with code 0");
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (shuttingDown) {
    console.log("[SIGTERM] Already shutting down, ignoring duplicate signal");
    return;
  }
  shuttingDown = true;
  writeCrashMarker("sigterm");
  await app.handleSigterm();
  console.log("[SIGTERM] All cleanup complete, exiting with code 0");
  process.exit(0);
});

// ============================================================
// CRASH HANDLERS — catch unhandled errors before process dies
// ============================================================

process.on("uncaughtException", (error) => {
  const ts = new Date().toISOString();
  console.error(`\n[${ts}] ========== UNCAUGHT EXCEPTION ==========`);
  console.error("[CRASH] Process will exit due to uncaught exception:");
  console.error(error);

  writeCrashMarker("uncaughtException", error);

  // Attempt to notify user via Telegram, then exit
  // Give 3 seconds for the message to send before dying
  try {
    app.notifyCrash?.("uncaughtException", error);
  } catch {}

  // Wait briefly for fire-and-forget Telegram message to send
  setTimeout(() => process.exit(1), 2000);
});

process.on("unhandledRejection", (reason) => {
  const ts = new Date().toISOString();
  console.error(`\n[${ts}] ========== UNHANDLED REJECTION ==========`);
  console.error("[CRASH] Process will exit due to unhandled promise rejection:");
  console.error(reason);

  writeCrashMarker("unhandledRejection", reason);

  // Attempt to notify user via Telegram, then exit
  try {
    app.notifyCrash?.("unhandledRejection", reason);
  } catch {}

  // Wait briefly for fire-and-forget Telegram message to send
  setTimeout(() => process.exit(1), 2000);
});
