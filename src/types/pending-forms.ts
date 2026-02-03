import type { UserChoiceQuestion } from "./user-choice.js";

export interface PendingFormData {
  formId: string;
  sessionKey: string;
  chatId: number;
  threadId?: number;
  messageIds: number[];
  questions: UserChoiceQuestion[];
  selections: Record<string, { choiceId: string; label: string }>;
  createdAt: number;
}

export interface SerializedFormData extends PendingFormData {
  id: string;
}
