/**
 * UIAskUserQuestion types for Telegram bot
 * Ported from soma-work Slack implementation
 */

export interface UserChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface UserChoiceQuestion {
  id: string;
  question: string;
  choices: UserChoiceOption[];
  context?: string;
}

export interface UserChoice {
  type: "user_choice";
  question: string;
  choices: UserChoiceOption[];
  context?: string;
}

export interface UserChoices {
  type: "user_choices";
  title?: string;
  description?: string;
  questions: UserChoiceQuestion[];
}

export interface ExtractedChoice {
  choice: UserChoice | null;
  choices: UserChoices | null;
  textWithoutChoice: string;
}

export interface ChoiceState {
  type: "single" | "multi";
  formId?: string; // For multi-form tracking
  messageIds: number[]; // All Telegram message IDs for validation (prevents stale replay)
  extractedChoice?: UserChoice; // For single choice
  extractedChoices?: UserChoices; // For multi-form
  selections?: Record<string, { choiceId: string; label: string }>; // For multi-form
}

export interface DirectInputState {
  type: "single" | "multi";
  formId?: string; // For multi-form
  questionId?: string; // For multi-form specific question
  messageId: number; // Original choice message ID
  createdAt: number; // Required - timestamp for expiration check (5 min)
}
