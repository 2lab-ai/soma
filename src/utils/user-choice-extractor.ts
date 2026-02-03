import {
  UserChoice,
  UserChoices,
  UserChoiceQuestion,
  ExtractedChoice,
} from "../types/user-choice";

/**
 * JSON extraction and parsing for UIAskUserQuestion
 * Ported from soma-work Slack implementation
 */
export class UserChoiceExtractor {
  /**
   * Extract UserChoice, UserChoices, or UserChoiceGroup JSON from message text
   * Supports both ```json blocks and raw JSON objects
   */
  static extractUserChoice(text: string): ExtractedChoice {
    let choice: UserChoice | null = null;
    let choices: UserChoices | null = null;
    let textWithoutChoice = text;

    // Try to find JSON in code blocks first
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;

    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const result = this.parseAndNormalizeChoice(match[1].trim());
      if (result.choice || result.choices) {
        textWithoutChoice = text.replace(match[0], "").trim();
        return { ...result, textWithoutChoice };
      }
    }

    // Try to find raw JSON objects (not in code blocks)
    const jsonStartPattern = /\{\s*"(?:type|question)"\s*:/g;
    let rawMatch;

    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const jsonStr = this.extractBalancedJson(text, rawMatch.index);
      if (jsonStr) {
        const result = this.parseAndNormalizeChoice(jsonStr);
        if (result.choice || result.choices) {
          textWithoutChoice = text.substring(0, rawMatch.index).trim();
          return {
            choice: result.choice,
            choices: result.choices,
            textWithoutChoice,
          };
        }
      }
    }

    return { choice, choices, textWithoutChoice };
  }

  /**
   * Extract a balanced JSON object starting from a given position
   */
  private static extractBalancedJson(text: string, startIndex: number): string | null {
    let braceCount = 0;
    let inString = false;
    let escape = false;
    let jsonStart = -1;

    for (let i = startIndex; i < text.length; i++) {
      const char = text[i];

      if (escape) {
        escape = false;
        continue;
      }

      if (char === "\\" && inString) {
        escape = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (char === "{") {
        if (braceCount === 0) jsonStart = i;
        braceCount++;
      } else if (char === "}") {
        braceCount--;
        if (braceCount === 0 && jsonStart !== -1) {
          return text.substring(jsonStart, i + 1);
        }
      }
    }

    return null;
  }

  /**
   * Parse JSON and normalize to UserChoice or UserChoices format
   */
  private static parseAndNormalizeChoice(jsonStr: string): {
    choice: UserChoice | null;
    choices: UserChoices | null;
  } {
    try {
      const parsed = JSON.parse(jsonStr);

      // Format 1: UserChoices (multi-question form)
      if (parsed.type === "user_choices" && Array.isArray(parsed.questions)) {
        return { choice: null, choices: parsed as UserChoices };
      }

      // Format 2: UserChoice (single choice with type field)
      if (parsed.type === "user_choice") {
        const opts = parsed.choices || parsed.options;
        if (Array.isArray(opts)) {
          return {
            choice: {
              type: "user_choice",
              question: parsed.question,
              choices: opts,
              context: parsed.context,
            },
            choices: null,
          };
        }
      }

      // Format 3: UserChoiceGroup (from system.prompt)
      if (
        parsed.question &&
        Array.isArray(parsed.choices) &&
        (!parsed.type || parsed.type === "user_choice_group")
      ) {
        const firstChoice = parsed.choices[0];
        if (
          firstChoice &&
          (firstChoice.type === "user_choice" ||
            firstChoice.options ||
            firstChoice.choices)
        ) {
          const questions: UserChoiceQuestion[] = parsed.choices.map(
            (c: any, idx: number) => ({
              id: `q${idx + 1}`,
              question: c.question,
              choices: c.options || c.choices || [],
              context: c.context,
            })
          );

          if (questions.length === 1) {
            return {
              choice: {
                type: "user_choice",
                question: questions[0].question,
                choices: questions[0].choices,
                context: questions[0].context,
              },
              choices: null,
            };
          }

          return {
            choice: null,
            choices: {
              type: "user_choices",
              title: parsed.question,
              description: parsed.context,
              questions,
            },
          };
        }
      }
    } catch {
      // Not valid JSON
    }

    return { choice: null, choices: null };
  }
}
