# Telegram Group Owner Confirmation — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/group-owner-confirm/spec.md

## Table of Contents
1. [Scenario 1 — Bot Added: DM Confirmation Sent to Owner](#scenario-1)
2. [Scenario 2 — Owner Accepts Group Activation](#scenario-2)
3. [Scenario 3 — Owner Rejects Group](#scenario-3)
4. [Scenario 4 — Group Message: Owner-Only Filter](#scenario-4)
5. [Scenario 5 — Pending Expiry (24h TTL)](#scenario-5)
6. [Scenario 6 — GroupRegistry Migration (Set→Map with ownerId)](#scenario-6)

---

## Scenario 1 — Bot Added: DM Confirmation Sent to Owner

### 1. API Entry
- Event: Telegram `my_chat_member` update
- Handler: `handleGroupMembership(ctx)` in `src/handlers/group-membership.ts`
- Auth: adder must be in `ALLOWED_USERS`

### 2. Input
- `ctx.myChatMember.chat.id` → chatId (number, group/supergroup)
- `ctx.myChatMember.chat.title` → chatTitle (string)
- `ctx.myChatMember.from.id` → adderId (number)
- `ctx.myChatMember.old_chat_member.status` → old status
- `ctx.myChatMember.new_chat_member.status` → new status
- Validation: `!wasMember && isMember` (join transition)

### 3. Layer Flow

#### 3a. Handler (`src/handlers/group-membership.ts:handleBotJoinedGroup`)
- Guard: `ALLOWED_USERS.includes(adderId)` → if false, silent reject + warn log
- Guard: `ALLOWED_GROUPS.includes(chatId)` → if true, skip (static group)
- **CHANGED**: Instead of `groupRegistry.register(chatId)`:
  - Derive ownerId: `ALLOWED_USERS[0]`
  - Transform: `ctx.myChatMember.chat.id → PendingConfirmation.chatId`
  - Transform: `ctx.myChatMember.chat.title → PendingConfirmation.chatTitle`
  - Transform: `ctx.myChatMember.from.id → PendingConfirmation.adderId`
  - Transform: `ALLOWED_USERS[0] → PendingConfirmation.ownerId`
  - Call: `pendingGroupStore.add(pendingConfirmation)`

#### 3b. DM to Owner
- Build InlineKeyboard: `[✅ 활성화] [❌ 거부]`
- Callback data: `grp:{chatId}:accept` / `grp:{chatId}:reject`
- Call: `ctx.api.sendMessage(ownerId, confirmMessage, { parse_mode: "HTML", reply_markup: keyboard })`
- Store returned `message_id` in `PendingConfirmation.dmMessageId`

#### 3c. PendingGroupStore (`src/core/pending-group-store.ts`)
- `add()`: `pendingGroups.set(chatId, confirmation)` → `saveToDisk()`
- Persistence: `/tmp/soma-pending-groups.json`
- Format: `{ pending: [{ chatId, chatTitle, adderId, ownerId, dmMessageId, createdAt }], updatedAt }`

### 4. Side Effects
- Pending store: INSERT `PendingConfirmation` keyed by chatId
- DM sent to owner with inline buttons
- "대기 중" message sent to group chat

### 5. Error Paths
| Condition | Action | Log |
|-----------|--------|-----|
| Unauthorized adder | Silent return | `[GroupMembership] Unauthorized user {adderId}` |
| Static group | Silent return | `[GroupMembership] Bot added to static group` |
| DM send fails | Log error, still keep pending | `[GroupMembership] Failed to send DM to owner` |
| Already pending | Update existing pending (idempotent) | `[GroupMembership] Already pending for {chatId}` |

### 6. Output
- To owner DM: "🔔 **그룹 활성화 요청**\n\n그룹: {title}\n추가한 사용자: {adderId}\n\n활성화하시겠습니까?"
- To group: "⏳ 오너 확인을 기다리는 중입니다..."

### 7. Observability
- Log: `[GroupMembership] Pending confirmation sent for group {chatId} to owner {ownerId}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `sends DM to owner instead of auto-registering` | Happy Path | S1, Section 3a-3b |
| `stores pending confirmation` | Side-Effect | S1, Section 3c |
| `unauthorized adder gets silent reject` | Sad Path | S1, Section 5 |
| `static group skips pending flow` | Sad Path | S1, Section 5 |

---

## Scenario 2 — Owner Accepts Group Activation

### 1. API Entry
- Event: Telegram `callback_query` with data `grp:{chatId}:accept`
- Handler: `handleCallback(ctx)` → `handleGroupConfirmCallback(ctx, ...)`
- Auth: `ctx.from.id === ownerId` in pending record

### 2. Input
- `ctx.callbackQuery.data` → `"grp:{chatId}:accept"`
- `ctx.from.id` → userId (must match pending.ownerId)
- Parse: `parts = callbackData.split(":")` → `["grp", chatIdStr, "accept"]`

### 3. Layer Flow

#### 3a. Callback Router (`src/handlers/callback.ts:handleCallback`)
- New routing: `callbackData.startsWith("grp:")` → `handleGroupConfirmCallback(ctx, callbackData)`

#### 3b. GroupConfirmCallback (`src/handlers/callback.ts:handleGroupConfirmCallback`)
- Parse: `callbackData.split(":")` → `[_, chatIdStr, action]`
- Transform: `chatIdStr → Number(chatIdStr) → chatId`
- Lookup: `pendingGroupStore.get(chatId)` → pending
- Guard: `!pending` → "요청이 만료되었습니다"
- Guard: `pending.isExpired()` → remove + "요청이 만료되었습니다"
- Guard: `ctx.from.id !== pending.ownerId` → "권한이 없습니다"
- Action (accept):
  - `pendingGroupStore.remove(chatId)`
  - `groupRegistry.register(chatId, pending.ownerId)` — **ownerId stored**
  - `ctx.editMessageText("✅ 그룹 '{title}' 활성화됨")`
  - `ctx.api.sendMessage(chatId, welcomeMessage)`

### 4. Side Effects
- Pending store: DELETE pending entry for chatId
- Group registry: INSERT `{ chatId, ownerId, activatedAt }` + persist to disk
- DM message: edited to show acceptance
- Group chat: welcome message sent

### 5. Error Paths
| Condition | Action | Response |
|-----------|--------|----------|
| No pending for chatId | answerCallbackQuery | "요청이 만료되었습니다" |
| Pending expired | remove + answerCallbackQuery | "요청이 만료되었습니다" |
| userId !== ownerId | answerCallbackQuery | "권한이 없습니다" |
| GroupRegistry persist fails | answerCallbackQuery | "등록 실패. 다시 시도해주세요" |
| Welcome message to group fails | Log error, don't block | warn log |

### 6. Output
- To owner DM (edited): "✅ 그룹 **{title}** 활성화됨\n이제 이 그룹에서 메시지에 응답합니다."
- To group: "안녕하세요! 이 그룹에서 도움이 필요하시면 말씀해 주세요. 🤖"
- answerCallbackQuery: "그룹 활성화됨"

### 7. Observability
- Log: `[GroupConfirm] Owner {ownerId} accepted group {chatId}`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `accept registers group with ownerId` | Happy Path | S2, Section 3b |
| `accept removes pending entry` | Side-Effect | S2, Section 4 |
| `expired pending returns error` | Sad Path | S2, Section 5 |
| `non-owner cannot accept` | Sad Path | S2, Section 5 |

---

## Scenario 3 — Owner Rejects Group

### 1. API Entry
- Event: Telegram `callback_query` with data `grp:{chatId}:reject`
- Handler: `handleCallback(ctx)` → `handleGroupConfirmCallback(ctx, ...)`

### 2. Input
- Same parsing as Scenario 2, action = "reject"

### 3. Layer Flow

#### 3a-3b. Same routing as Scenario 2

#### 3c. Reject Action
- `pendingGroupStore.remove(chatId)`
- `ctx.editMessageText("❌ 그룹 '{title}' 거부됨")`
- GroupRegistry is NOT modified
- Bot stays in group (no auto-leave per auto-decision)

### 4. Side Effects
- Pending store: DELETE pending entry for chatId
- DM message: edited to show rejection
- No change to GroupRegistry

### 5. Error Paths
- Same guards as Scenario 2 (no pending, expired, wrong user)

### 6. Output
- To owner DM (edited): "❌ 그룹 **{title}** 거부됨\n봇은 그룹에 남아있지만 응답하지 않습니다."
- answerCallbackQuery: "그룹 거부됨"

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `reject removes pending without registering` | Happy Path | S3, Section 3c |
| `reject edits DM message` | Side-Effect | S3, Section 4 |

---

## Scenario 4 — Group Message: Owner-Only Filter

### 1. API Entry
- Event: Any message in a dynamically registered group
- Handler: `isAuthorizedForChat()` in `src/security.ts`

### 2. Input
- `userId`: number — message sender
- `chatId`: number — group chatId
- `chatType`: "group" | "supergroup"

### 3. Layer Flow

#### 3a. Security (`src/security.ts:isAuthorizedForChat`)
- **CHANGED** for dynamic groups:
  - `groupRegistry.isRegistered(chatId)` → true
  - `groupRegistry.getOwner(chatId)` → ownerId
  - Check: `userId === ownerId` (NOT `ALLOWED_USERS.includes(userId)`)
  - Transform: `userId → comparison with GroupEntry.ownerId`
- Static groups: unchanged (`ALLOWED_USERS.includes(userId)`)
- Private chat: unchanged

#### 3b. shouldRespondInChat (`src/security.ts`)
- Unchanged — dynamic groups already return true (DM-like)

### 4. Side Effects
- None

### 5. Error Paths
| Condition | Result |
|-----------|--------|
| Non-owner in dynamic group | `isAuthorizedForChat` returns false → message ignored |
| Owner in dynamic group | `isAuthorizedForChat` returns true → message processed |

### 6. Output
- Owner message: processed normally (session response)
- Non-owner message: silently ignored

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `owner message in dynamic group is authorized` | Happy Path | S4, Section 3a |
| `non-owner message in dynamic group is rejected` | Sad Path | S4, Section 5 |
| `static group still allows all ALLOWED_USERS` | Contract | S4, Section 3a |
| `private chat unchanged` | Contract | S4, Section 3a |

---

## Scenario 5 — Pending Expiry (24h TTL)

### 1. API Entry
- Triggered lazily: when `pendingGroupStore.get(chatId)` is called
- Or: when owner clicks accept/reject after 24h

### 2. Input
- `PendingConfirmation.createdAt` → timestamp
- Current time vs createdAt → age

### 3. Layer Flow

#### 3a. PendingGroupStore (`src/core/pending-group-store.ts`)
- `get(chatId)`: checks `isExpired(pending)` — `Date.now() - pending.createdAt > 24 * 60 * 60 * 1000`
- If expired: `remove(chatId)` → return undefined
- `isExpired()` is a pure function on `PendingConfirmation`

### 4. Side Effects
- Expired pending removed from store + persisted

### 5. Error Paths
- No errors — expiry is a normal lifecycle event

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `pending within TTL returns confirmation` | Happy Path | S5, Section 3a |
| `pending past TTL returns undefined and removes` | Contract | S5, Section 3a |

---

## Scenario 6 — GroupRegistry Migration (Set→Map with ownerId)

### 1. API Entry
- On startup: `GroupRegistry.loadFromDisk()`

### 2. Input
- Existing persistence file `/tmp/soma-groups.json` with format: `{ groups: number[] }`

### 3. Layer Flow

#### 3a. GroupRegistry (`src/core/group-registry.ts`)
- **CHANGED**: internal store from `Set<number>` to `Map<number, GroupEntry>`
- `GroupEntry { ownerId: number, activatedAt: string }`
- `register(chatId, ownerId)`: `registeredGroups.set(chatId, { ownerId, activatedAt })`
- `isRegistered(chatId)`: `registeredGroups.has(chatId)`
- `getOwner(chatId)`: `registeredGroups.get(chatId)?.ownerId`
- `unregister(chatId)`: `registeredGroups.delete(chatId)`

#### 3b. Migration on Load
- Old format: `{ groups: [chatId1, chatId2] }` — no ownerId
- New format: `{ groups: [{ chatId, ownerId, activatedAt }] }`
- Migration: if `typeof entry === "number"` → `{ chatId: entry, ownerId: ALLOWED_USERS[0], activatedAt: "migrated" }`
- Transform: `number[] → GroupEntry[]` with default ownerId

### 4. Side Effects
- Persistence format changes from array-of-numbers to array-of-objects
- On first load of old format: auto-migrates + saves new format

### 5. Error Paths
| Condition | Action |
|-----------|--------|
| Old format detected | Migrate with ALLOWED_USERS[0] as default owner |
| Invalid entry (not number or object) | Skip + warn |

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `register stores chatId with ownerId` | Happy Path | S6, Section 3a |
| `getOwner returns correct ownerId` | Contract | S6, Section 3a |
| `loads old number[] format with migration` | Contract | S6, Section 3b |
| `loads new GroupEntry[] format` | Happy Path | S6, Section 3b |
| `round-trip persistence with ownerId` | Contract | S6, Section 3a-3b |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| PendingGroupStore lazy expiry | tiny | Check on access, no background timer. Simpler. |
| Migration assigns ALLOWED_USERS[0] as default owner | small | Only safe assumption for existing groups. |
| Callback routing via string prefix | tiny | Follows exact pattern of existing c:, model:, sk:, lost: handlers. |
| No auto-leave on reject | tiny | User spec said "optionally". Less disruptive default. |

## Implementation Status

| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Bot Added: DM Confirmation | done | RED | Ready |
| 2. Owner Accepts Group | done | RED | Ready |
| 3. Owner Rejects Group | done | RED | Ready |
| 4. Group Message: Owner-Only | done | RED | Ready |
| 5. Pending Expiry | done | RED | Ready |
| 6. GroupRegistry Migration | done | RED | Ready |

## Next Step

→ Proceed with implementation + Trace Verify via `stv:work docs/group-owner-confirm/trace.md`
