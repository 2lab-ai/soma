# Telegram Group Owner Confirmation Flow — Spec

> STV Spec | Created: 2026-03-28

## 1. Overview

현재 봇이 그룹에 추가되면 ALLOWED_USERS 검증 후 자동 등록된다. 그러나 실제로는 봇 오너에게 DM으로 확인을 받은 후에만 그룹이 활성화되어야 한다. 그룹에서는 오너의 메시지만 응답한다.

핵심 변경: 자동 등록(auto-register) → 오너 DM 확인(owner-confirm) 흐름으로 전환.

## 2. User Stories

- As a bot owner, I want to be asked via DM before my bot activates in a group, so that I control where it operates.
- As a bot owner, I want to accept or reject group activation with inline buttons, so that confirmation is frictionless.
- As a bot owner, I want only my messages answered in activated groups, so that other users don't consume my bot's resources.
- As a bot owner, I want to deactivate a group later, so that I can revoke access.

## 3. Acceptance Criteria

- [ ] Bot detects group add via `my_chat_member` (existing)
- [ ] Instead of auto-registering, sends DM to owner with group info + accept/reject buttons
- [ ] Owner clicks "Accept" → group registered in GroupRegistry → welcome message in group
- [ ] Owner clicks "Reject" → pending removed, bot optionally leaves group
- [ ] In activated groups, only owner's messages get responses (not all ALLOWED_USERS)
- [ ] Pending confirmations expire after 24h (auto-reject)
- [ ] Owner can deactivate group via `/deactivate` command in group or DM
- [ ] Persisted across restarts (pending state + registered groups)

## 4. Scope

### In-Scope
- Owner DM confirmation flow with InlineKeyboard
- Callback handler for `grp:` prefix
- Group-to-owner mapping (which owner activated which group)
- Owner-only message filtering in security layer
- Pending confirmation expiry (24h TTL)

### Out-of-Scope
- Multiple owners per group
- Per-group permission configuration (who can use bot in group)
- Group admin commands beyond activate/deactivate
- Notification when pending expires

## 5. Architecture

### 5.1 Layer Structure

```
my_chat_member event
  → GroupMembershipHandler (MODIFIED: no auto-register, send DM instead)
  → PendingGroupStore (NEW: Map<chatId, PendingConfirmation>)
  → bot.api.sendMessage(ownerId, ..., { reply_markup: keyboard })

callback_query "grp:*"
  → handleCallback (MODIFIED: add grp: prefix routing)
  → handleGroupConfirmCallback (NEW)
  → GroupRegistry.register() on accept
  → PendingGroupStore.remove() on accept/reject

Message in group
  → security.ts isAuthorizedForChat (MODIFIED: owner-only check)
  → shouldRespondInChat (unchanged — dynamic groups already DM-like)
```

### 5.2 New Components

#### PendingGroupStore (`src/core/pending-group-store.ts`)
- `Map<number, PendingConfirmation>` — key = group chatId
- `PendingConfirmation { chatId, chatTitle, adderId, ownerId, messageId, createdAt }`
- Methods: `add()`, `remove()`, `get()`, `isExpired()`, `cleanup()`
- TTL: 24h, cleanup on access (lazy expiry)
- File persistence: `/tmp/soma-pending-groups.json`

#### GroupConfirmCallback (`added to src/handlers/callback.ts`)
- Handles `grp:{chatId}:{action}` callbacks
- Actions: `accept`, `reject`

### 5.3 Modified Components

#### `src/handlers/group-membership.ts`
- `handleBotJoinedGroup`: replace `groupRegistry.register()` with `pendingGroupStore.add()` + DM to owner
- Owner = `ALLOWED_USERS[0]`
- DM message includes group title, adder info, accept/reject buttons

#### `src/handlers/callback.ts`
- Add `grp:` prefix routing in `handleCallback()`
- New `handleGroupConfirmCallback()` function

#### `src/security.ts`
- `isAuthorizedForChat()`: for dynamic groups, check if user is the owner who activated that group (not just any ALLOWED_USER)
- GroupRegistry needs to store `{ chatId, ownerId }` instead of just `chatId`

#### `src/core/group-registry.ts`
- Change from `Set<number>` to `Map<number, GroupEntry>`
- `GroupEntry { chatId, ownerId, activatedAt }`
- `register(chatId, ownerId)` — stores owner association
- `getOwner(chatId): number | undefined` — returns owner for group
- Persistence format updated to include owner

### 5.4 Integration Points

| Component | Integration |
|-----------|-------------|
| `group-membership.ts` | Import `pendingGroupStore`, send DM via `ctx.api.sendMessage` |
| `callback.ts` | Route `grp:` callbacks to new handler |
| `security.ts` | Import updated `groupRegistry.getOwner()` |
| `telegram-bot.ts` | No changes (callback_query already registered) |
| `config/index.ts` | No changes |

### 5.5 Data Flow: Bot Added to Group

```
1. User adds bot to group
2. my_chat_member event fires
3. handleGroupMembership() detects join
4. Guard: chatType is group/supergroup
5. Guard: adder is ALLOWED_USER (if not, silent reject)
6. Guard: not in static ALLOWED_GROUPS (skip)
7. NEW: pendingGroupStore.add(chatId, chatTitle, adderId, ownerId)
8. NEW: bot.api.sendMessage(ownerId, confirmMessage, { reply_markup: acceptRejectKeyboard })
9. Bot sends "대기 중" message to group
```

### 5.6 Data Flow: Owner Accepts

```
1. Owner clicks "Accept" in DM
2. callback_query fires with "grp:{chatId}:accept"
3. handleGroupConfirmCallback() processes
4. pendingGroupStore.remove(chatId)
5. groupRegistry.register(chatId, ownerId)
6. Edit DM message: "✅ 그룹 활성화됨"
7. bot.api.sendMessage(chatId, welcomeMessage)
```

### 5.7 Data Flow: Owner Rejects

```
1. Owner clicks "Reject" in DM
2. callback_query fires with "grp:{chatId}:reject"
3. handleGroupConfirmCallback() processes
4. pendingGroupStore.remove(chatId)
5. Edit DM message: "❌ 그룹 거부됨"
6. Optionally: bot.api.leaveChat(chatId)
```

### 5.8 Callback Data Format

```
grp:{chatId}:{action}
```
- `chatId`: number as string (e.g., "-1001234567890")
- `action`: "accept" | "reject"
- Total length: ~30 bytes — well within 64-byte limit

## 6. Non-Functional Requirements

- **Performance**: PendingGroupStore is O(1) Map lookup. No impact.
- **Security**: Only the specific owner (ALLOWED_USERS[0]) who receives the DM can click the buttons. Callback handler validates userId === ownerId.
- **Persistence**: Both pending and registered states survive restarts.
- **Backward Compatibility**: Static ALLOWED_GROUPS unchanged. Existing registered groups (from PR #2) need migration to include ownerId.

## 7. Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| Owner = ALLOWED_USERS[0] | tiny | Bot is single-owner. First user is primary. |
| Callback format `grp:{chatId}:{action}` | tiny | Follows existing prefix pattern (c:, model:, sk:, lost:). Fits 64-byte limit. |
| PendingGroupStore as separate module | small | Single responsibility. GroupRegistry stays clean. |
| Lazy expiry (check on access) | tiny | No timer needed. Simpler. |
| GroupRegistry stores ownerId | small | Required for owner-only filtering. Map<number, GroupEntry> replaces Set<number>. |
| Don't auto-leave on reject | tiny | Less disruptive. Owner can add again later. |
| 24h TTL for pending | tiny | Reasonable timeout. Configurable later. |

## 8. Open Questions

None. Requirements are explicit from user.

## 9. Next Step

→ Proceed with Vertical Trace via `stv:trace docs/group-owner-confirm/spec.md`
