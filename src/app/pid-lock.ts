import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";

const DEFAULT_PID_FILE = "/tmp/soma.pid";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killProcess(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[PID-LOCK] Sent SIGTERM to stale process ${pid}`);

    const start = Date.now();
    while (isProcessAlive(pid) && Date.now() - start < 3000) {
      Bun.sleepSync(100);
    }

    if (isProcessAlive(pid)) {
      process.kill(pid, "SIGKILL");
      console.log(`[PID-LOCK] Sent SIGKILL to stale process ${pid}`);
    }
  } catch (e) {
    console.warn(`[PID-LOCK] Failed to kill stale process ${pid}:`, e);
  }
}

export function acquirePidLock(pidFile = DEFAULT_PID_FILE): void {
  if (existsSync(pidFile)) {
    try {
      const existingPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (!isNaN(existingPid) && existingPid !== process.pid) {
        if (isProcessAlive(existingPid)) {
          console.warn(`[PID-LOCK] Killing stale bot process ${existingPid}`);
          killProcess(existingPid);
        } else {
          console.log(`[PID-LOCK] Stale PID file (process ${existingPid} dead), overwriting`);
        }
      }
    } catch (e) {
      console.warn(`[PID-LOCK] Error reading PID file:`, e);
    }
  }

  writeFileSync(pidFile, String(process.pid));
  console.log(`[PID-LOCK] Acquired lock (PID ${process.pid})`);
}

export function releasePidLock(pidFile = DEFAULT_PID_FILE): void {
  try {
    if (existsSync(pidFile)) {
      const filePid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (filePid === process.pid) {
        unlinkSync(pidFile);
        console.log(`[PID-LOCK] Released lock`);
      }
    }
  } catch (e) {
    console.warn(`[PID-LOCK] Error releasing lock:`, e);
  }
}
