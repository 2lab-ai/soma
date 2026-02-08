import {
  buildSessionKey,
  buildStoragePartitionKey,
  createSessionIdentity,
  type SessionIdentity,
  type SessionKey,
  type StoragePartitionKey,
} from "../routing/session-key";

const SCHEDULER_TENANT_ID = "cron";
const SCHEDULER_CHANNEL_ID = "scheduler";

function sanitizeThreadId(rawName: string): string {
  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || "job";
}

export interface SchedulerRoute {
  identity: SessionIdentity;
  sessionKey: SessionKey;
  storagePartitionKey: StoragePartitionKey;
}

export function buildSchedulerRoute(scheduleName: string): SchedulerRoute {
  const identity = createSessionIdentity({
    tenantId: SCHEDULER_TENANT_ID,
    channelId: SCHEDULER_CHANNEL_ID,
    threadId: sanitizeThreadId(scheduleName),
  });

  return {
    identity,
    sessionKey: buildSessionKey(identity),
    storagePartitionKey: buildStoragePartitionKey(identity),
  };
}
