# Trace: Tool Input Validation Hardening

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| 1 | Grep/Glob path validation | small | Ready |
| 2 | Bash file-read command path extraction | small | Ready |
| 3 | HTML-escape block reasons | tiny | Ready |
| 4 | Abort error alignment | tiny | Ready |

---

## Scenario 1: Grep/Glob path validation

### Callstack
1. Model calls `Grep` with `{ path: "/etc/passwd", pattern: "root" }`
2. SDK fires `PreToolUse` hook → `preToolUseHook()` at `query-runtime.ts:43`
3. Hook calls `checkToolInputSafety("Grep", { path: "/etc/passwd" })` at `query-runtime.ts:61`
4. **Current**: `checkToolInputSafety` does NOT check Grep → returns `{ allowed: true }` ❌
5. **Fix**: Add `["Grep", "Glob"].includes(toolName)` branch → extract `path` → `resolve(path)` → `isPathAllowed(resolvedPath)`
6. Returns `{ allowed: false, reason: "..." }` → hook returns `{ decision: "block", reason }`

### Contract Tests (RED)
```typescript
test("blocks Grep with path outside allowed directories", () => {
  const result = checkToolInputSafety("Grep", { path: "/etc/passwd", pattern: "root" });
  expect(result.allowed).toBe(false);
});

test("blocks Glob with path outside allowed directories", () => {
  const result = checkToolInputSafety("Glob", { path: "/home/user/secrets", pattern: "*.key" });
  expect(result.allowed).toBe(false);
});

test("allows Grep with path in allowed directories", () => {
  const result = checkToolInputSafety("Grep", { path: "/tmp/project", pattern: "TODO" });
  expect(result).toEqual({ allowed: true });
});
```

---

## Scenario 2: Bash file-read command path extraction

### Callstack
1. Model calls `Bash` with `{ command: "cat /etc/passwd" }`
2. SDK fires `PreToolUse` → `checkToolInputSafety("Bash", { command: "cat /etc/passwd" })`
3. `checkCommandSafety("cat /etc/passwd")` → `[true, ""]` (not in BLOCKED_PATTERNS) ❌
4. **Fix**: After `checkCommandSafety`, extract file paths from known file-reading commands
5. Pattern: `/\b(cat|head|tail|less|more|cp|mv|tee|wc|sort|grep|awk|sed|curl\s+-o)\s+([^\s|;&>]+)/gi`
6. For each extracted path → `resolve(path)` → `isPathAllowed(resolvedPath)`
7. If any path not allowed → `{ allowed: false, reason: "Bash command accesses blocked path: ..." }`

### Contract Tests (RED)
```typescript
test("blocks Bash cat of file outside allowed paths", () => {
  const result = checkToolInputSafety("Bash", { command: "cat /etc/passwd" });
  expect(result.allowed).toBe(false);
});

test("blocks Bash head of file outside allowed paths", () => {
  const result = checkToolInputSafety("Bash", { command: "head -5 /home/user/secret.txt" });
  expect(result.allowed).toBe(false);
});

test("allows Bash cat of file in temp paths", () => {
  const result = checkToolInputSafety("Bash", { command: "cat /tmp/output.log" });
  expect(result).toEqual({ allowed: true });
});

test("allows Bash echo (no file access)", () => {
  const result = checkToolInputSafety("Bash", { command: "echo hello world" });
  expect(result).toEqual({ allowed: true });
});
```

---

## Scenario 3: HTML-escape block reasons

### Callstack
1. `validateToolInput()` at `query-runtime.ts:264` calls `checkToolInputSafety()`
2. If blocked, `result.reason` contains raw file path (e.g., `File access blocked: /path/<script>alert(1)</script>`)
3. `statusCallback("tool", result.reason)` → `streaming.ts:349` → `ctx.reply(content, { parse_mode: "HTML" })` ❌
4. **Fix**: Import `escapeHtml` from `formatting.ts`, apply to `result.reason` before `statusCallback`
5. `await statusCallback("tool", escapeHtml(result.reason));`

### Contract Tests (RED)
```typescript
test("escapeHtml handles angle brackets in paths", () => {
  // This is a formatting.ts test, already covered
  // Integration: verify validateToolInput uses escapeHtml
});
```

---

## Scenario 4: Abort error alignment

### Callstack
1. `preToolUseHook` at `query-runtime.ts:55`: `throw new Error("Abort requested by user")`
2. Error propagates to `session.ts:861` catch block
3. `isAbortError(error)` at `error-classification.ts:132` checks:
   - `error.name === "AbortError"` → NO (name is "Error")
   - message in ["aborted", "cancelled", ...] → NO ("Abort requested by user" not in list)
4. Result: `isExpectedAbort = false` → error logged + re-thrown ❌
5. **Fix**: Create proper AbortError: `const err = new Error("Abort requested by user"); err.name = "AbortError"; throw err;`

### Contract Tests (RED)
```typescript
test("abort error from hook is recognized by isAbortError", () => {
  const err = new Error("Abort requested by user");
  err.name = "AbortError";
  expect(isAbortError(err)).toBe(true);
});
```
