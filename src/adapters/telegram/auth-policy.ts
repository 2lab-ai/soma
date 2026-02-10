import { type ChatType, isAuthorizedForChat } from "../../security";

export type TelegramAuthorizeFn = (
  userId: number,
  chatId: number,
  chatType: ChatType | undefined
) => boolean;

export interface TelegramAuthPolicyInput {
  userId: number;
  chatId: number;
  chatType: ChatType | undefined;
}

export interface TelegramAuthPolicyResult {
  authorized: boolean;
}

export interface TelegramAuthPolicy {
  evaluate(input: TelegramAuthPolicyInput): TelegramAuthPolicyResult;
}

export function createTelegramAuthPolicy(
  authorize: TelegramAuthorizeFn = isAuthorizedForChat
): TelegramAuthPolicy {
  return {
    evaluate(input) {
      return {
        authorized: authorize(input.userId, input.chatId, input.chatType),
      };
    },
  };
}
