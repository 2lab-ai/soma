import type {
  UserChoice,
  UserChoices,
  UserChoiceQuestion,
  ExtractedChoice,
} from "../types/user-choice";

type ParseResult = { choice: UserChoice | null; choices: UserChoices | null };

export class UserChoiceExtractor {
  static extractUserChoice(text: string): ExtractedChoice {
    const jsonBlockPattern = /```json\s*\n?([\s\S]*?)\n?```/g;
    let match;
    while ((match = jsonBlockPattern.exec(text)) !== null) {
      const result = this.parseAndNormalizeChoice(match[1]!.trim());
      if (result.choice || result.choices) {
        return { ...result, textWithoutChoice: text.replace(match[0], "").trim() };
      }
    }

    const jsonStartPattern = /\{\s*"(?:type|question)"\s*:/g;
    let rawMatch;
    while ((rawMatch = jsonStartPattern.exec(text)) !== null) {
      const jsonStr = this.extractBalancedJson(text, rawMatch.index);
      if (jsonStr) {
        const result = this.parseAndNormalizeChoice(jsonStr);
        if (result.choice || result.choices) {
          return {
            ...result,
            textWithoutChoice: text.substring(0, rawMatch.index).trim(),
          };
        }
      }
    }

    return { choice: null, choices: null, textWithoutChoice: text };
  }

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

  private static parseAndNormalizeChoice(jsonStr: string): ParseResult {
    try {
      const parsed = JSON.parse(jsonStr);

      if (parsed.type === "user_choices" && Array.isArray(parsed.questions)) {
        return { choice: null, choices: parsed as UserChoices };
      }

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
            const q = questions[0]!;
            return {
              choice: {
                type: "user_choice",
                question: q.question,
                choices: q.choices,
                context: q.context,
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
      // Invalid JSON
    }

    return { choice: null, choices: null };
  }
}
