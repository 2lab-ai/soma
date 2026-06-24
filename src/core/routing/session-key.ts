const SESSION_KEY_SEPARATOR = ":";
const STORAGE_PARTITION_SEPARATOR = "/";
const DISALLOWED_IDENTITY_CHARS = /[:/\\]/;

export const SESSION_KEY_FORMAT = "tenant:channel:thread";
export const STORAGE_PARTITION_FORMAT = "tenant/channel/thread";

/**
 * Tenant id used for cron/scheduler-originated sessions.
 *
 * Scheduler sessions carry a literal `channelId` ("scheduler") that is not a
 * real chat, so they must be detected explicitly when resolving a delivery
 * target (see {@link resolveSendFileChatId}).
 */
export const SCHEDULER_TENANT_ID = "cron";

declare const tenantIdBrand: unique symbol;
declare const channelIdBrand: unique symbol;
declare const threadIdBrand: unique symbol;
declare const sessionKeyBrand: unique symbol;
declare const storagePartitionKeyBrand: unique symbol;

export type TenantId = string & { readonly [tenantIdBrand]: "TenantId" };
export type ChannelId = string & { readonly [channelIdBrand]: "ChannelId" };
export type ThreadId = string & { readonly [threadIdBrand]: "ThreadId" };
export type SessionKey = string & { readonly [sessionKeyBrand]: "SessionKey" };
export type StoragePartitionKey = string & {
  readonly [storagePartitionKeyBrand]: "StoragePartitionKey";
};

export interface SessionIdentityInput {
  tenantId: string;
  channelId: string;
  threadId: string;
}

export interface SessionIdentity {
  tenantId: TenantId;
  channelId: ChannelId;
  threadId: ThreadId;
}

export type SessionIdentityField = keyof SessionIdentityInput;
type SessionIdentityContractField =
  | SessionIdentityField
  | "sessionKey"
  | "storagePartitionKey";

export type SessionIdentityInvariantCode =
  | "IDENTITY_EMPTY"
  | "IDENTITY_CONTAINS_SEPARATOR"
  | "SESSION_KEY_INVALID_FORMAT"
  | "STORAGE_PARTITION_INVALID_FORMAT";

export class SessionIdentityInvariantError extends Error {
  readonly code: SessionIdentityInvariantCode;
  readonly field: SessionIdentityContractField;
  readonly value: string;

  constructor(
    code: SessionIdentityInvariantCode,
    field: SessionIdentityContractField,
    value: string
  ) {
    super(`Invalid ${field} (${code}): "${value}"`);
    this.name = "SessionIdentityInvariantError";
    this.code = code;
    this.field = field;
    this.value = value;
  }
}

function validateIdentitySegment(
  field: SessionIdentityField,
  rawValue: string
): string {
  const normalized = rawValue.trim();
  if (!normalized) {
    throw new SessionIdentityInvariantError("IDENTITY_EMPTY", field, rawValue);
  }
  if (DISALLOWED_IDENTITY_CHARS.test(normalized)) {
    throw new SessionIdentityInvariantError(
      "IDENTITY_CONTAINS_SEPARATOR",
      field,
      normalized
    );
  }
  return normalized;
}

function splitIdentityTriplet(
  value: string,
  separator: string,
  code: SessionIdentityInvariantCode,
  field: "sessionKey" | "storagePartitionKey"
): [string, string, string] {
  const parts = value.split(separator);
  if (parts.length !== 3) {
    throw new SessionIdentityInvariantError(code, field, value);
  }

  const [tenantId, channelId, threadId] = parts as [string, string, string];
  return [tenantId, channelId, threadId];
}

export function toTenantId(value: string): TenantId {
  return validateIdentitySegment("tenantId", value) as TenantId;
}

export function toChannelId(value: string): ChannelId {
  return validateIdentitySegment("channelId", value) as ChannelId;
}

export function toThreadId(value: string): ThreadId {
  return validateIdentitySegment("threadId", value) as ThreadId;
}

export function createSessionIdentity(input: SessionIdentityInput): SessionIdentity {
  return {
    tenantId: toTenantId(input.tenantId),
    channelId: toChannelId(input.channelId),
    threadId: toThreadId(input.threadId),
  };
}

export function buildSessionKey(identity: SessionIdentity): SessionKey {
  return `${identity.tenantId}${SESSION_KEY_SEPARATOR}${identity.channelId}${SESSION_KEY_SEPARATOR}${identity.threadId}` as SessionKey;
}

export function buildSessionKeyFromInput(input: SessionIdentityInput): SessionKey {
  return buildSessionKey(createSessionIdentity(input));
}

export function parseSessionKey(sessionKey: string): SessionIdentity {
  const [tenantId, channelId, threadId] = splitIdentityTriplet(
    sessionKey,
    SESSION_KEY_SEPARATOR,
    "SESSION_KEY_INVALID_FORMAT",
    "sessionKey"
  );
  return createSessionIdentity({ tenantId, channelId, threadId });
}

export function buildStoragePartitionKey(
  identity: SessionIdentity
): StoragePartitionKey {
  return `${identity.tenantId}${STORAGE_PARTITION_SEPARATOR}${identity.channelId}${STORAGE_PARTITION_SEPARATOR}${identity.threadId}` as StoragePartitionKey;
}

export function buildStoragePartitionKeyFromInput(
  input: SessionIdentityInput
): StoragePartitionKey {
  return buildStoragePartitionKey(createSessionIdentity(input));
}

export function parseStoragePartitionKey(storagePartitionKey: string): SessionIdentity {
  const [tenantId, channelId, threadId] = splitIdentityTriplet(
    storagePartitionKey,
    STORAGE_PARTITION_SEPARATOR,
    "STORAGE_PARTITION_INVALID_FORMAT",
    "storagePartitionKey"
  );
  return createSessionIdentity({ tenantId, channelId, threadId });
}

/**
 * Resolve the Telegram chat id that the `send-file` MCP should target for a
 * given query.
 *
 * The chat id is injected per query into the `send-file` MCP env. There are two
 * kinds of sessions:
 *
 * - **User sessions** — the handler passes the originating chat id as the query
 *   `chatId`, which equals the session's `channelId`. Either source works.
 * - **Cron/scheduler sessions** — the session `channelId` is a literal label
 *   ("scheduler"), NOT a chat. Injecting it makes `send_photo`/`send_document`
 *   fail with Telegram `Bad Request: chat not found`. The scheduler instead
 *   passes the owner's numeric chat id (`ALLOWED_USERS[0]`) as the query
 *   `chatId`.
 *
 * Strategy: always prefer the query `chatId` when present; only fall back to the
 * session `channelId` for non-scheduler sessions. Returns `null` when there is
 * no usable chat id (e.g. a scheduler session with no query chat id), so the
 * caller can skip injection rather than send to an invalid target.
 */
export function resolveSendFileChatId(
  sessionKey: string,
  queryChatId: number | string | null | undefined
): string | null {
  if (
    queryChatId !== null &&
    queryChatId !== undefined &&
    String(queryChatId) !== ""
  ) {
    return String(queryChatId);
  }

  try {
    const identity = parseSessionKey(sessionKey);
    if (identity.tenantId === SCHEDULER_TENANT_ID) {
      // Scheduler channelId ("scheduler") is a label, not a chat — unusable.
      return null;
    }
    return identity.channelId;
  } catch {
    return null;
  }
}

export interface SessionKeyContract {
  createIdentity(input: SessionIdentityInput): SessionIdentity;
  buildSessionKey(identity: SessionIdentity): SessionKey;
  parseSessionKey(sessionKey: string): SessionIdentity;
  buildStoragePartitionKey(identity: SessionIdentity): StoragePartitionKey;
  parseStoragePartitionKey(storagePartitionKey: string): SessionIdentity;
}

export const sessionKeyContract: SessionKeyContract = {
  createIdentity: createSessionIdentity,
  buildSessionKey,
  parseSessionKey,
  buildStoragePartitionKey,
  parseStoragePartitionKey,
};
