# Telegram Group as Independent DM-like Session — Vertical Trace

> STV Trace | Created: 2026-03-28
> Spec: docs/telegram-group-session/spec.md

## Table of Contents
1. [Scenario 1 — Bot Added to Group by Authorized User](#scenario-1)
2. [Scenario 2 — Bot Added to Group by Unauthorized User](#scenario-2)
3. [Scenario 3 — Bot Removed from Group](#scenario-3)
4. [Scenario 4 — Group Message Response Without Mention](#scenario-4)
5. [Scenario 5 — GroupRegistry Persistence Across Restarts](#scenario-5)
6. [Scenario 6 — Backward Compatibility with TELEGRAM_ALLOWED_GROUPS](#scenario-6)

---

## Scenario 1 — Bot Added to Group by Authorized User

### 1. API Entry
- Event: Grammy `my_chat_member` update
- Path: `bot.on("my_chat_member")` → `handleGroupMembership(ctx)`
- Auth: Adder userId must be in ALLOWED_USERS

### 2. Input
- Grammy Context:
  ```typescript
  ctx.myChatMember.chat.id        // number — group chatId (negative)
  ctx.myChatMember.chat.type      // "group" | "supergroup"
  ctx.myChatMember.from.id        // number — user who added bot
  ctx.myChatMember.old_chat_member.status  // "left" | "kicked"
  ctx.myChatMember.new_chat_member.status  // "member" | "administrator"
  ```
- Validation rules:
  - chat.type must be "group" or "supergroup" (not "private", "channel")
  - new_chat_member.status must be "member" or "administrator"
  - old_chat_member.status must be "left" or "kicked" (transition from non-member to member)
  - from.id must be in ALLOWED_USERS

### 3. Layer Flow

#### 3a. Handler (`src/handlers/group-membership.ts`)
- Extract: `ctx.myChatMember` → `{ chatId, chatType, adderId, oldStatus, newStatus }`
- Guard: `chatType` in ["group", "supergroup"]
- Guard: transition is join (old=left/kicked → new=member/administrator)
- Guard: `ALLOWED_USERS.includes(adderId)`
- Transformation:
  - `ctx.myChatMember.chat.id` → `chatId: number`
  - `ctx.myChatMember.from.id` → `adderId: number`
  - `ctx.myChatMember.new_chat_member.status` → `newStatus: string`

#### 3b. Service (`src/core/group-registry.ts`)
- `groupRegistry.register(chatId: number): boolean`
- Adds chatId to internal `Set<number>`
- Returns `true` if newly added, `false` if already existed
- Triggers `saveToDisk()`
- Transformation:
  - `chatId: number` → `registeredGroups.add(chatId)` → `/tmp/soma-groups.json`

#### 3c. Persistence
- File: `/tmp/soma-groups.json`
- Format: `{ "groups": [chatId1, chatId2, ...], "updatedAt": "ISO8601" }`
- Write: `JSON.stringify()` → `writeFileSync()`

### 4. Side Effects
- File WRITE: `/tmp/soma-groups.json` — adds chatId to groups array
- Telegram API: `ctx.reply("...")` — sends welcome message to group
- Console: `console.log("[GroupRegistry] Registered group {chatId}")`

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| chatType is "private" or "channel" | Ignore | Return silently (not a group event) |
| Transition is not a join (e.g., promoted) | Ignore | Return silently |
| adderId not in ALLOWED_USERS | Unauthorized | Log warning, return silently (don't register) |
| File write failure | Non-critical | Log error, group stays in memory Set (lost on restart) |

### 6. Output
- Telegram message to group: Welcome message (e.g., "안녕하세요! 이 그룹에서 도움이 필요하시면 말씀해 주세요.")
- No HTTP response (event-driven)

### 7. Observability
- Log: `[GroupMembership] Bot added to group {chatId} by user {adderId}`
- Log: `[GroupRegistry] Registered group {chatId} (total: {count})`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `group-membership: registers group when authorized user adds bot` | Happy Path | S1, Section 3 |
| `group-membership: ignores non-group chat types` | Sad Path | S1, Section 5, Row 1 |
| `group-membership: ignores non-join transitions` | Sad Path | S1, Section 5, Row 2 |
| `group-membership: rejects unauthorized adder` | Sad Path | S1, Section 5, Row 3 |
| `group-registry: register adds chatId to set and persists` | Side-Effect | S1, Section 4 |

---

## Scenario 2 — Bot Added to Group by Unauthorized User

### 1. API Entry
- Event: Grammy `my_chat_member` update
- Path: `bot.on("my_chat_member")` → `handleGroupMembership(ctx)`
- Auth: Adder userId NOT in ALLOWED_USERS

### 2. Input
- Same as Scenario 1, but `ctx.myChatMember.from.id` not in `ALLOWED_USERS`

### 3. Layer Flow

#### 3a. Handler (`src/handlers/group-membership.ts`)
- Extract same fields as S1
- Guard: `ALLOWED_USERS.includes(adderId)` → `false`
- Early return — do NOT register group

### 4. Side Effects
- Console: `console.warn("[GroupMembership] Unauthorized user {adderId} added bot to group {chatId}")`
- No file write
- No Telegram reply

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| adderId not in ALLOWED_USERS | Silent rejection | Log warning, return |

### 6. Output
- None (silent ignore)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `group-membership: does not register group for unauthorized user` | Sad Path | S2, Section 3 |
| `group-registry: register not called for unauthorized adder` | Contract | S2, Section 3→4 |

---

## Scenario 3 — Bot Removed from Group

### 1. API Entry
- Event: Grammy `my_chat_member` update
- Path: `bot.on("my_chat_member")` → `handleGroupMembership(ctx)`

### 2. Input
- Grammy Context:
  ```typescript
  ctx.myChatMember.chat.id        // number — group chatId
  ctx.myChatMember.chat.type      // "group" | "supergroup"
  ctx.myChatMember.old_chat_member.status  // "member" | "administrator"
  ctx.myChatMember.new_chat_member.status  // "left" | "kicked"
  ```
- Validation rules:
  - Transition is leave (old=member/administrator → new=left/kicked)

### 3. Layer Flow

#### 3a. Handler (`src/handlers/group-membership.ts`)
- Extract: `{ chatId, oldStatus, newStatus }`
- Guard: transition is leave (old=member/administrator → new=left/kicked)
- Call: `groupRegistry.unregister(chatId)`

#### 3b. Service (`src/core/group-registry.ts`)
- `groupRegistry.unregister(chatId: number): boolean`
- Removes chatId from internal `Set<number>`
- Returns `true` if was registered, `false` if wasn't
- Triggers `saveToDisk()`
- Transformation:
  - `chatId: number` → `registeredGroups.delete(chatId)` → `/tmp/soma-groups.json`

### 4. Side Effects
- File WRITE: `/tmp/soma-groups.json` — removes chatId from groups array
- Console: `console.log("[GroupRegistry] Unregistered group {chatId}")`
- No session kill (session will expire naturally via TTL)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Group was never registered | No-op | `unregister()` returns false, no side effects |
| File write failure | Non-critical | Log error, group removed from memory |

### 6. Output
- None (bot already left the group, can't send messages)

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `group-membership: unregisters group when bot is removed` | Happy Path | S3, Section 3 |
| `group-registry: unregister removes chatId and persists` | Side-Effect | S3, Section 4 |
| `group-registry: unregister of non-registered group is no-op` | Sad Path | S3, Section 5, Row 1 |

---

## Scenario 4 — Group Message Response Without Mention

### 1. API Entry
- Event: Grammy `message:text` (and `message:voice`, `message:photo`, `message:document`)
- Path: existing handler pipeline
- Auth: `isAuthorizedForChat()` → uses dynamic registry

### 2. Input
- Grammy Context:
  ```typescript
  ctx.chat.id       // number — group chatId (negative, registered in GroupRegistry)
  ctx.chat.type     // "group" | "supergroup"
  ctx.from.id       // number — message sender userId
  ctx.message.text  // string — message WITHOUT @mention
  ```

### 3. Layer Flow

#### 3a. Security (`src/security.ts`)

**`isAuthorizedForChat(userId, chatId, chatType)`:**
- chatType is "group" or "supergroup"
- Check 1: `ALLOWED_GROUPS.includes(chatId)` (static env) → if true, authorized
- Check 2: `groupRegistry.isRegistered(chatId)` (dynamic) → if true, authorized
- Check 3: `ALLOWED_USERS.includes(userId)` → must be true
- Transformation:
  - `chatId: number` → `groupRegistry.isRegistered(chatId): boolean` → `authorized: boolean`

**`shouldRespond(chatType, messageText, botUsername, isReplyToBot)`:**
- chatType is "group" or "supergroup"
- Check: `groupRegistry.isRegistered(chatId)` → if true, return `true` (like private chat)
- Fallback: existing logic (@mention, reply, RESPOND_WITHOUT_MENTION)
- Transformation:
  - `chatId: number` → `groupRegistry.isRegistered(chatId): boolean` → `shouldRespond: boolean`

#### 3b. Handler (`src/handlers/text.ts`)
- No changes — `inbound-guard.ts` calls `shouldRespond()` which now returns true for registered groups
- Session: `sessionManager.getSession(chatId, threadId)` — unchanged

#### 3c. Session (`src/core/session/session-manager.ts`)
- No changes — chatId-based routing already isolates group sessions
- Session key: `default:{chatId}:main`

### 4. Side Effects
- Same as existing DM flow (Claude query, streaming response, chat history, audit log)

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| Group not registered (neither static nor dynamic) | Auth failure | `isAuthorizedForChat()` returns false → silent ignore |
| User not in ALLOWED_USERS | Auth failure | Same as above |
| Rate limit exceeded | Rate limit | Standard rate limit response |

### 6. Output
- Same as DM: Claude streaming response via Telegram

### 7. Observability
- Existing audit logging applies

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `security: isAuthorizedForChat allows dynamically registered group` | Happy Path | S4, Section 3a |
| `security: shouldRespond returns true for registered group without mention` | Happy Path | S4, Section 3a |
| `security: shouldRespond falls back to mention check for unregistered group` | Contract | S4, Section 3a |
| `security: isAuthorizedForChat rejects unregistered group` | Sad Path | S4, Section 5, Row 1 |

---

## Scenario 5 — GroupRegistry Persistence Across Restarts

### 1. API Entry
- Lifecycle: Application startup + shutdown hooks
- Path: `GroupRegistry.loadFromDisk()` on init, `saveToDisk()` on change

### 2. Input
- File: `/tmp/soma-groups.json`
- Format:
  ```json
  {
    "groups": [-1001234567890, -1009876543210],
    "updatedAt": "2026-03-28T00:00:00.000Z"
  }
  ```

### 3. Layer Flow

#### 3a. Initialization (`src/core/group-registry.ts`)
- Constructor: `loadFromDisk()` → read file → parse JSON → populate `Set<number>`
- Transformation:
  - `/tmp/soma-groups.json` → `JSON.parse()` → `data.groups: number[]` → `registeredGroups: Set<number>`

#### 3b. Runtime Persistence
- Every `register()` / `unregister()` call → `saveToDisk()`
- Transformation:
  - `registeredGroups: Set<number>` → `Array.from()` → `JSON.stringify()` → `/tmp/soma-groups.json`

### 4. Side Effects
- File READ: `/tmp/soma-groups.json` on startup
- File WRITE: `/tmp/soma-groups.json` on every register/unregister

### 5. Error Paths
| Condition | Error | Behavior |
|-----------|-------|----------|
| File doesn't exist on startup | Expected | Start with empty Set, log info |
| File is corrupted JSON | Recovery | Start with empty Set, log error |
| File write fails | Non-critical | Log error, in-memory state preserved |

### 6. Output
- On startup: `console.log("[GroupRegistry] Loaded {N} groups from disk")`
- On startup with no file: `console.log("[GroupRegistry] No persisted groups, starting fresh")`

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `group-registry: loadFromDisk restores persisted groups` | Happy Path | S5, Section 3a |
| `group-registry: loadFromDisk handles missing file` | Sad Path | S5, Section 5, Row 1 |
| `group-registry: loadFromDisk handles corrupted JSON` | Sad Path | S5, Section 5, Row 2 |
| `group-registry: saveToDisk writes correct format` | Side-Effect | S5, Section 3b |
| `group-registry: register then restart preserves state` | Contract | S5, Section 3a→3b round-trip |

---

## Scenario 6 — Backward Compatibility with TELEGRAM_ALLOWED_GROUPS

### 1. API Entry
- Config: `TELEGRAM_ALLOWED_GROUPS` environment variable (existing)
- Auth check: `isAuthorizedForChat()` checks both static and dynamic

### 2. Input
- Environment: `TELEGRAM_ALLOWED_GROUPS="-1001234567890,-1009876543210"`
- Parsed: `ALLOWED_GROUPS: number[] = [-1001234567890, -1009876543210]`

### 3. Layer Flow

#### 3a. Security (`src/security.ts`)
- `isAuthorizedForChat()` — OR logic:
  - `ALLOWED_GROUPS.includes(chatId)` → authorized (static, env var)
  - `groupRegistry.isRegistered(chatId)` → authorized (dynamic, file)
  - Either true → group is authorized

#### 3b. Response Policy
- `shouldRespond()` — for statically configured groups:
  - Existing behavior preserved: @mention or reply or RESPOND_WITHOUT_MENTION
  - Only dynamically registered groups get "always respond" behavior
  - Rationale: Static groups were configured with existing expectation of mention-based response

### 4. Side Effects
- None (purely logic change in existing functions)

### 5. Error Paths
- None (backward compatible, no new failure modes)

### 6. Output
- Static groups: same behavior as before
- Dynamic groups: DM-like behavior

### Contract Tests (RED)
| Test Name | Category | Trace Reference |
|-----------|----------|-----------------|
| `security: static ALLOWED_GROUPS still works without GroupRegistry` | Happy Path | S6, Section 3a |
| `security: static group requires mention (existing behavior preserved)` | Contract | S6, Section 3b |
| `security: dynamic group + static group coexist` | Contract | S6, Section 3a OR logic |

---

## Auto-Decisions

| Decision | Tier | Rationale |
|----------|------|-----------|
| GroupRegistry as singleton class with Set<number> | small | Follows SessionManager singleton pattern |
| File path `/tmp/soma-groups.json` | tiny | Follows `/tmp/soma-sessions/` convention |
| JSON format for persistence | tiny | Follows session-store.ts pattern |
| Static groups keep mention-based response | small | Non-breaking: existing groups work exactly as before |
| Dynamic groups get DM-like response | small | User explicitly requested "DM처럼" |
| No session kill on bot removal | tiny | TTL cleanup is sufficient, avoid data loss |
| `shouldRespond()` needs chatId parameter | small | Function signature change, ~5 call sites to update |
| Welcome message in Korean | tiny | Target user is Korean-speaking |

## Implementation Status
| Scenario | Trace | Tests (RED) | Status |
|----------|-------|-------------|--------|
| 1. Bot Added by Authorized User | done | GREEN | Complete |
| 2. Bot Added by Unauthorized User | done | GREEN | Complete |
| 3. Bot Removed from Group | done | GREEN | Complete |
| 4. Group Message Without Mention | done | GREEN | Complete |
| 5. GroupRegistry Persistence | done | GREEN | Complete |
| 6. Backward Compatibility | done | GREEN | Complete |

## Next Step
→ Proceed with RED contract tests, then implementation via `stv:work`
