/**
 * Claude Telegram Bot entrypoint.
 *
 * Runtime wiring is delegated to src/app/* modules.
 * This file keeps process-level signal hooks only.
 */

import { bootstrapApplication } from "./app/bootstrap";

const app = await bootstrapApplication();
export const formStore = app.formStore;

let shuttingDown = false;

process.on("SIGINT", () => {
  if (shuttingDown) return;
  shuttingDown = true;
  const ts = new Date().toISOString();
  console.log(`\n[${ts}] ========== SIGINT RECEIVED ==========`);
  console.log("[SIGINT] Ctrl+C detected, stopping without save...");
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
  await app.handleSigterm();
  console.log("[SIGTERM] All cleanup complete, exiting with code 0");
  process.exit(0);
});
