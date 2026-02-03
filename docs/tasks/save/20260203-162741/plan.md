# Implementation Plan: UIAskUserQuestion Foundation

**Objective**: Implement foundational infrastructure for interactive choice UI in Telegram bot

## Selected Tasks

### soma-9oa: Inject UIAskUserQuestion rules to systemPrompt (P0, 60min)
**Goal**: Add JSON contract and examples to Claude's system prompt

**Approach**:
1. Create `UI_ASKUSER_INSTRUCTIONS` constant in config.ts
2. Document single choice format with examples
3. Document multi-question form format with examples
4. Specify rules: choice limits, ID format, label length
5. Integrate into `systemPrompt` in session.ts

**Rationale**: Separate from SAFETY_PROMPT (security vs UI behavior)

### soma-0ex: Build Telegram InlineKeyboard for single choice (P0, 60min)
**Goal**: Create builder class to convert UserChoice JSON → Telegram keyboards

**Approach**:
1. Create `TelegramChoiceBuilder` static utility class
2. Implement `buildSingleChoiceKeyboard()` method
3. Implement `buildMultiChoiceKeyboards()` method
4. Compress sessionKey via Bun.hash() to fit <64 byte limit
5. Sanitize option/question IDs (alphanumeric, max 4 chars)
6. Validate callback data length
7. Truncate labels to 30 chars
8. Include direct input button

**Rationale**: Static methods match UserChoiceExtractor pattern, hash-based compression avoids state management

## Dependencies

- ✅ soma-27z: JSON normalization & text filtering (completed)
- soma-0ex blocks → soma-utf (callback handler)

## Architecture Decisions (From Oracle)

1. **Prompt location**: Separate UI_ASKUSER_INSTRUCTIONS constant
2. **Builder architecture**: Static methods (stateless)
3. **Compression**: 8-char hash of sessionKey (36^8 combinations)
4. **Validation**: Prompt = soft, Builder = hard, Callback = security
5. **Security**: Acceptable with Telegram auth + sanitization

## Quality Pipeline

1. **Parallel research**: Oracle (architecture) + Explore (code patterns)
2. **Implementation**: soma-9oa → soma-0ex
3. **Self-review**: Check compilation, obvious issues
4. **Oracle review**: Architecture, security, edge cases
5. **PR review**: code-reviewer, comment-analyzer, code-simplifier
6. **Quality gates**: tests, lint, fmt
7. **Deploy**: commit, push, close tasks

## Expected Outcome

✅ Achieved:
- UI instructions integrated into system prompt
- TelegramChoiceBuilder class ready for use
- All tests passing
- Code simplified (~314 lines reduced)
- Committed and pushed (e334821)
- soma-utf unblocked

**Integration gaps** (expected):
- Keyboards not yet displayed (streaming.ts integration)
- Callback handler not yet implemented (callback.ts)
- Direct input handler not yet implemented (text.ts)

→ These are soma-utf (callback), soma-wca (state), and soma-9zt (direct input) tasks
