# SDK Error Full Logging — Vertical Trace

## Implementation Status

| # | Scenario | Size | Status |
|---|----------|------|--------|
| S1 | extractErrorDetails SDK 속성 추출 | small | 🔴 Not started |
| S2 | query-runtime result error variant 처리 | small | 🔴 Not started |
| S3 | claude-adapter error result 전달 | small | 🔴 Not started |
| S4 | session.ts lastError 절단 완화 | tiny | 🔴 Not started |
| S5 | formatErrorForLog/User 전체 출력 | small | 🔴 Not started |
| S6 | silent catch → console.warn | small | 🔴 Not started |
| S7 | error-normalizer cause 체인 보존 | tiny | 🔴 Not started |

---

## S1: extractErrorDetails SDK 속성 추출

### Entry
`src/utils/error-classification.ts:186` → `extractErrorDetails(error)`

### Trace
```
extractErrorDetails(error: unknown)
  ├─ error instanceof Error → extract message, name, stack, cause
  ├─ NEW: error instanceof NormalizedProviderError → extract statusCode, code, providerId, retryable
  ├─ NEW: check for (error as any).statusCode, .status, .code, .type, .request_id
  └─ return ErrorDetails (extended interface)
```

### Parameters
```
ErrorDetails {
  + statusCode?: number        // HTTP status code
  + errorCode?: string         // RATE_LIMIT, AUTH, NETWORK, etc.
  + providerId?: string        // anthropic, codex, gemini
  + retryable?: boolean        // SDK says retryable?
  + requestId?: string         // API request ID
  + sdkErrors?: string[]       // SDK result event errors[]
}
```

### Contract Test
- Input: NormalizedProviderError(providerId="anthropic", code="RATE_LIMIT", message="429", retryable=true, statusCode=429)
- Expected: details.statusCode === 429, details.errorCode === "RATE_LIMIT", details.providerId === "anthropic"

---

## S2: query-runtime result error variant 처리

### Entry
`src/core/session/query-runtime.ts:700` → `if (event.type === "result")`

### Trace
```
for await (const event of queryInstance)
  └─ event.type === "result"
       ├─ event.subtype === "success" → existing logic (unchanged)
       └─ NEW: event.subtype starts with "error_"
            ├─ console.error("[SDK-RESULT-ERROR]", event.subtype, event.errors)
            ├─ queryCompleted = false  (not true!)
            └─ continue to usage/context extraction (unchanged)
```

### Contract Test
- Input: result event with subtype: "error_during_execution", errors: ["rate limit exceeded"]
- Expected: console.error called with full error details, queryCompleted = false

---

## S3: claude-adapter error result 전달

### Entry
`src/providers/claude-adapter.ts:244` → `if (event.type === "result")`

### Trace
```
event.type === "result"
  ├─ NEW: check event.subtype
  │   ├─ "success" → reason: "completed" (existing)
  │   └─ "error_*" → reason: "failed", errorMessage: event.errors?.join("; ")
  └─ onEvent({ type: "done", reason, errorMessage })
```

### Contract Test
- Input: result event with subtype: "error_during_execution", errors: ["billing_error"]
- Expected: done event emitted with reason: "failed", errorMessage includes "billing_error"

---

## S4: session.ts lastError 절단 완화

### Entry
`src/core/session/session.ts:869`

### Trace
```
catch (error)
  └─ this.lastError = String(error).slice(0, 100)
     → this.lastError = String(error).slice(0, 500)
```

### Contract Test
- Input: Error with 300-char message
- Expected: lastError preserves all 300 chars (not truncated to 100)

---

## S5: formatErrorForLog/User 전체 출력

### Entry
`src/utils/error-classification.ts:230,250`

### Trace
```
formatErrorForLog(error)
  ├─ existing: [ERROR] name: message, exitCode, stderr, cause, stack
  └─ NEW: + statusCode, errorCode, providerId, retryable, requestId, sdkErrors[]

formatErrorForUser(error)
  ├─ existing: ❌ name (code X) + message.slice(0, 800)
  └─ NEW:
       ├─ message.slice(0, 2000) (expanded)
       ├─ + HTTP {statusCode} if present
       ├─ + Error type: {errorCode} if present
       └─ + SDK errors: {sdkErrors.join()} if present
```

---

## S6: silent catch → console.warn

### Entry
Multiple files

### Trace
```
query-flow.ts:46   catch {} → catch (e) { console.warn("[REACT]", e); }
query-flow.ts:66   catch {} → catch (e) { console.warn("[REACT]", e); }
query-flow.ts:141  catch {} → catch (e) { console.warn("[SYSTEM-MSG]", e); }
query-flow.ts:283  catch {} → catch (e) { console.warn("[SYSTEM-MSG]", e); }
query-flow.ts:376  catch {} → catch (e) { console.warn("[REACT]", e); }
callback.ts:435    catch {} → catch (e) { console.warn("[CALLBACK]", e); }
callback.ts:703    catch {} → catch (e) { console.warn("[CALLBACK]", e); }
callback.ts:719    catch {} → catch (e) { console.warn("[CALLBACK]", e); }
callback.ts:739    catch {} → catch (e) { console.warn("[CALLBACK]", e); }
callback.ts:765    catch {} → catch (e) { console.warn("[CALLBACK]", e); }
```

---

## S7: error-normalizer cause 체인 보존

### Entry
`src/providers/error-normalizer.ts:83` → `normalizeProviderError()`

### Trace
```
normalizeProviderError(providerId, error)
  ├─ existing: new NormalizedProviderError(providerId, code, message, retryable, statusCode)
  └─ NEW: pass original error as cause
       → new NormalizedProviderError(..., { cause: error })
       → NormalizedProviderError constructor: super(message, { cause })
```

### Contract Test
- Input: original Error("rate limit") → normalizeProviderError("anthropic", error)
- Expected: result.cause === original error
