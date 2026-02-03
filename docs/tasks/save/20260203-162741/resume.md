# Resume Instructions: UIAskUserQuestion Foundation

**Save ID**: 20260203-162741
**Status**: ✅ Work completed, ready for next phase

## Quick Summary

Completed soma-9oa + soma-0ex:
- ✅ UI instructions in system prompt
- ✅ TelegramChoiceBuilder class created
- ✅ All tests passing, code simplified, deployed
- ✅ Commit e334821 pushed to main

## To Resume Work Session

If you need to continue this work stream:

```bash
cd ~/2lab.ai/soma
git log --oneline -1  # Should show e334821
bd ready              # Check next tasks
```

## Next Natural Task

**soma-utf** (P0, 60min): Callback handler for single choice selection
- Now unblocked by soma-0ex completion
- Implement `c:` prefix handler in handlers/callback.ts
- Parse sessionKey + optionId from callback data
- Update message: "✓ Selected: {label}"
- Send choice result to Claude session
- **Estimated**: 1 hour

## Context to Remember

1. **Callback Format**: `c:{sessionKey}:{optId}` or `c:{sessionKey}:{qId}:{optId}`
2. **Compression**: sessionKey → 8-char hash via `Bun.hash().toString(36).slice(0,8)`
3. **Security**: IDs sanitized (alphanumeric, max 4 chars), callback data validated (<64 bytes)
4. **Integration Gap**: Keyboards extracted but not displayed (soma-utf will fix)

## Files to Know

**Modified in this session**:
- `src/config.ts` - UI_ASKUSER_INSTRUCTIONS constant
- `src/session.ts` - systemPrompt integration
- `src/utils/telegram-choice-builder.ts` - NEW builder class

**Will modify in soma-utf**:
- `src/handlers/callback.ts` - Add `c:` prefix handler
- `src/handlers/streaming.ts` - Display keyboards after extraction

## Review Findings to Consider

From comment-analyzer:
- callback.ts currently only handles `askuser:` format (legacy MCP)
- Need to implement `c:` format parser in soma-utf
- Consider adding explicit error for unrecognized formats

From Oracle:
- ChoiceState not persisted (acceptable, short-lived)
- Direct input flow incomplete (soma-9zt will handle)
- All critical validation implemented

## bd Task Status

**Closed**:
- soma-9oa ✅
- soma-0ex ✅

**Ready**:
- soma-utf (P0) - Next task
- soma-g7f (P1) - Port pending-forms state storage
- soma-6zx (P1) - Unit tests for UIAskUserQuestion

## If Starting Fresh

Don't need to read this save unless:
1. Continuing UIAskUserQuestion implementation (soma-utf)
2. Debugging choice UI system
3. Understanding TelegramChoiceBuilder architecture

Otherwise, just run `bd ready` and pick next task normally.
