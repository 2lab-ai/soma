# Work Session: UIAskUserQuestion Foundation (soma-9oa, soma-0ex)

**Session ID**: 20260203-162741
**Duration**: ~2 hours
**Status**: ✅ Completed & Deployed

## Tasks Completed

### ✅ soma-9oa: Inject UIAskUserQuestion rules to systemPrompt (P0)
- Added `UI_ASKUSER_INSTRUCTIONS` constant to config.ts
- Documented JSON contract for single choice and multi-question formats
- Specified rules: 2-8 options, alphanumeric IDs (max 4 chars), 30-char labels
- Integrated into `systemPrompt` in session.ts
- Examples provided for both formats

### ✅ soma-0ex: Build Telegram InlineKeyboard for single choice (P0)
- Created `TelegramChoiceBuilder` static utility class
- Implemented `buildSingleChoiceKeyboard()` for single choice questions
- Implemented `buildMultiChoiceKeyboards()` for multi-question forms
- Session key compression via Bun.hash() to 8-char base36 (stays <64 bytes)
- ID sanitization: alphanumeric only, max 4 chars
- Callback data validation: throws if >64 bytes
- Label truncation: max 30 chars with "..." suffix
- Direct input button included
- Callback format: `c:{sessionKey}:{optId}` or `c:{sessionKey}:{qId}:{optId}`

## Quality Metrics

**Tests**: 28/28 passing ✅
**Lint**: No errors (7 warnings in pre-existing code only) ✅
**Format**: All files formatted ✅
**Reviews**: 3/3 agents completed ✅
- Oracle: Architecture review + security analysis
- Comment Analyzer: Documentation quality check
- Code Simplifier: Refactored (~314 lines reduced)

## Code Changes

**Commit**: e334821
**Files Modified**: 10 files, +1060/-558 lines

Key changes:
- `src/config.ts`: Added UI_ASKUSER_INSTRUCTIONS + env parsing helpers
- `src/session.ts`: Integrated instructions into systemPrompt + refactored
- `src/utils/telegram-choice-builder.ts`: New builder class (85 lines)
- `src/types/user-choice.ts`: Type definitions
- `src/utils/user-choice-extractor.ts`: JSON extraction (pre-existing)
- Test files: streaming.test.ts, session.test.ts, user-choice-extractor.test.ts

## Review Findings

### Critical (Acknowledged)
- Callback handler format mismatch: callback.ts only handles `askuser:` format, not new `c:` format
  - **Status**: Expected - Integration is soma-utf task (next in queue)
  - **Action**: Will be fixed when implementing soma-utf

### Pre-existing Issues (Not Blocking)
- user-choice-extractor.ts has TypeScript errors (type imports, undefined guards)
- These existed before my changes

## Architecture Decisions (Oracle-validated)

1. **Prompt separation**: UI instructions separate from SAFETY_PROMPT
2. **Builder pattern**: Static utility class (matches UserChoiceExtractor)
3. **Compression strategy**: 8-char hash (36^8 = 2.8T combinations, negligible collision)
4. **Validation distribution**: Soft @ prompt, Hard @ builder, Security @ callback
5. **Security**: Acceptable with Telegram's userId auth + hash obscurity

## Next Steps

**Ready to implement**: soma-utf (P0, 60min)
- Callback handler for single choice selection
- Extend handlers/callback.ts to parse `c:` prefix
- Handle sessionKey + optionId from callback data
- Update message: "✓ Selected: {label}"
- Send choice result to Claude session
- **Blocked by**: soma-0ex ✅ (now completed)

## Project State

**Directory**: ~/2lab.ai/soma
**Branch**: main
**Last commit**: e334821 (pushed to remote)

**Open P0 tasks**: 2
- soma-utf: Callback handler (ready, unblocked)
- soma-wca: ActivityState transitions (blocked by soma-utf)

**Context usage**: 45% (safe, no reset needed)
