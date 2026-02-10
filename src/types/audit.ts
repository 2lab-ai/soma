// Audit log event types
export type AuditEventType = "message" | "auth" | "tool_use" | "error" | "rate_limit";

export interface AuditEvent {
  timestamp: string;
  event: AuditEventType;
  user_id: number;
  username?: string;
  [key: string]: unknown;
}
