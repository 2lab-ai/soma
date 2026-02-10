import type { SessionIdentity, SessionKey, StoragePartitionKey } from "./session-key";

export interface RouteResolverInput {
  identity: SessionIdentity;
  channelType: string;
  accountId: string;
  peer: string;
  parentPeer?: string;
  preferredProviderId?: string;
  tags?: ReadonlyArray<string>;
}

export interface AgentRoute {
  identity: SessionIdentity;
  sessionKey: SessionKey;
  storagePartitionKey: StoragePartitionKey;
  accountId: string;
  peer: string;
  parentPeer?: string;
  providerId: string;
}

export type RouteResolverErrorCode =
  | "ROUTE_INVALID_INPUT"
  | "ROUTE_FORBIDDEN"
  | "ROUTE_NOT_FOUND";

export interface RouteResolverError extends Error {
  readonly code: RouteResolverErrorCode;
  readonly retryable: boolean;
}

export type RouteResolver = (
  input: RouteResolverInput
) => AgentRoute | Promise<AgentRoute>;

export interface RouteResolverContract {
  resolveAgentRoute: RouteResolver;
}
