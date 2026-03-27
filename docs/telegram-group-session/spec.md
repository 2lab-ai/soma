# Telegram Group as Independent DM-like Session — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

soma 텔레그램 봇이 그룹에 추가되면, 해당 그룹을 자동으로 감지하고 DM과 동일한 방식으로 독립 세션을 생성하여 동작한다. 현재 그룹은 환경변수로 수동 등록해야 하며, @멘션/리플라이 없이는 응답하지 않는다. 이 기능은 그룹 진입을 자동화하고, 응답 정책을 DM과 동일하게 만든다.

## 2. User Stories

- As a bot owner, I want the bot to auto-detect when added to a group, so that I don't need to manually register group IDs in environment variables.
- As a group user, I want to message the bot naturally (without @mention), so that the group experience is identical to DM.
- As a bot owner, I want the bot to clean up when removed from a group, so that resources are freed.
- As a group user, I want all media types (voice, photo, document) to work in groups, so that functionality is not degraded.

## 3. Acceptance Criteria

- [ ] Bot detects `my_chat_member` event when added to a group/supergroup
- [ ] Only ALLOWED_USERS can trigger group auto-registration (security gate)
- [ ] Auto-registered groups are persisted across bot restarts
- [ ] Bot responds to all messages in registered groups without @mention requirement
- [ ] Bot detects removal from group and cleans up registration
- [ ] Existing TELEGRAM_ALLOWED_GROUPS env var continues to work (backward compatible)
- [ ] Voice, photo, document handlers work in groups same as DM
- [ ] Session isolation per group maintained (existing chatId-based routing)

## 4. Scope

### In-Scope
- `my_chat_member` event handler for add/remove detection
- Dynamic group registry (runtime mutable, file-persisted)
- `shouldRespond()` policy change for registered groups
- `isAuthorizedForChat()` to accept dynamically registered groups
- Backward compatibility with `TELEGRAM_ALLOWED_GROUPS` env var

### Out-of-Scope
- Per-user session isolation within groups (all users share group session)
- Group-specific configuration (custom prompts, models per group)
- Admin commands for group management (`/addgroup`, `/removegroup`)
- Group member permission management

## 5. Architecture

### 5.1 Layer Structure

```
Grammy my_chat_member event
    → GroupMembershipHandler (NEW)
    → GroupRegistry (NEW) - dynamic allowlist
    → security.ts - isAuthorizedForChat() updated
    → shouldRespond() updated
    → existing session pipeline (unchanged)
```

### 5.2 New Components

#### GroupRegistry (`src/core/group-registry.ts`)
- Mutable `Set<number>` of dynamically registered group chatIds
- File persistence: `/tmp/soma-groups.json`
- Methods: `register(chatId)`, `unregister(chatId)`, `isRegistered(chatId)`, `loadFromDisk()`, `saveToDisk()`
- Merges with static `ALLOWED_GROUPS` from env

#### GroupMembershipHandler (`src/handlers/group-membership.ts`)
- Handles `my_chat_member` Grammy event
- On bot added to group: validate adder is ALLOWED_USER → register group
- On bot removed from group: unregister group, optionally kill session

### 5.3 Modified Components

#### `src/security.ts`
- `isAuthorizedForChat()`: check both static `ALLOWED_GROUPS` AND dynamic `groupRegistry.isRegistered(chatId)`
- `shouldRespond()`: for registered groups, return `true` (like private chats)

#### `src/app/telegram-bot.ts`
- `registerBotHandlers()`: add `bot.on("my_chat_member", handleGroupMembership)`

#### `src/handlers/text/inbound-guard.ts`
- No changes needed (flows through `shouldRespond()`)

### 5.4 Integration Points

| Component | Integration |
|-----------|-------------|
| `security.ts` | Import `groupRegistry`, use in auth + response checks |
| `telegram-bot.ts` | Register new `my_chat_member` handler |
| `session-manager.ts` | No changes (already routes by chatId) |
| `channel-boundary.ts` | No changes (auth flows through policy) |
| `config/index.ts` | No changes (ALLOWED_GROUPS stays as fallback) |

### 5.5 Data Flow: Bot Added to Group

```
1. User adds bot to group
2. Telegram sends my_chat_member update
3. Grammy routes to handleGroupMembership()
4. Check: was bot's status changed to "member"/"administrator"?
5. Check: is the user who added bot in ALLOWED_USERS?
6. YES → groupRegistry.register(chatId) + persist to disk
7. Send welcome message to group
8. All subsequent messages in group flow through normal pipeline
9. shouldRespond() returns true for registered groups
```

### 5.6 Data Flow: Bot Removed from Group

```
1. User removes bot from group (or bot kicked)
2. Telegram sends my_chat_member update
3. Grammy routes to handleGroupMembership()
4. Check: was bot's status changed to "left"/"kicked"?
5. YES → groupRegistry.unregister(chatId) + persist to disk
6. Optionally: sessionManager.killSession(chatId)
```

## 6. Non-Functional Requirements

- **Performance**: GroupRegistry lookup is O(1) Set operation. No impact.
- **Security**: Only ALLOWED_USERS can trigger group registration. Unauthorized additions are silently ignored.
- **Persistence**: Group list survives bot restarts via file persistence.
- **Backward Compatibility**: Static `TELEGRAM_ALLOWED_GROUPS` env var continues to work alongside dynamic registry.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| File-based persistence for group registry | tiny | Follows existing `session-store.ts` pattern. `/tmp/soma-groups.json` |
| Merge static + dynamic groups (OR logic) | tiny | Non-breaking: env var groups always work, dynamic adds more |
| Security: only ALLOWED_USERS can register groups | small | Prevents unauthorized group access. Follows existing auth pattern |
| Respond without mention in registered groups | small | User explicitly requested "DM처럼" behavior |
| Welcome message on group join | tiny | Standard UX pattern, easily removed |
| No per-user session isolation in groups | small | Current architecture is chatId-based. User didn't request per-user isolation. Can be added later by changing session key to include userId |
| Kill session on bot removal | tiny | Resource cleanup, follows existing cleanup pattern |

## 8. Open Questions

None. User requirements are clear and architecture follows established patterns.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/telegram-group-session/spec.md`
