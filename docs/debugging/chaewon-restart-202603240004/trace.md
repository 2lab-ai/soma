# Bug Trace: 채원봇 tool call 중 재시작

## AS-IS: 채원봇이 이미지 처리 + greeting 생성 tool call 실행 중 갑자기 재시작됨
## TO-BE: tool call 실행 중 서비스가 비정상 재시작되면 안 됨

## 에러 로그 분석

### /tmp/chaewon-bot.err 핵심 에러:
```
NormalizedProviderError: Claude Code process exited with code 143
  at normalizeProviderError (error-normalizer.ts:94:10)
  at streamEvents (claude-adapter.ts:244:31)
```

**Exit code 143 = 128 + 15 = SIGTERM (signal 15)**

### 연쇄 패턴:
```
[STUCK] isProcessing stuck for 60s, auto-releasing  ← 반복 발생
NormalizedProviderError: Claude Code process exited with code 143  ← 반복
[CONTEXT-SAVE] Failed to notify user: Error: Timeout
```

## Phase 1: 가설 검증

### 가설 1: SIGTERM이 tool call 중 Claude Code 프로세스를 죽임 ✅ 확정
- Exit code 143 = SIGTERM received by Claude Code child process
- 누가 SIGTERM을 보냈나?
  - 스크린샷의 "유형: make up / systemctl restart" → systemd restart가 SIGTERM 전송
  - systemd `Restart=always` + `RestartSec=10` → 프로세스 죽으면 자동 재시작

### 가설 2: context 349.8% 때문에 자동 재시작? ❌ 배제
- session.ts: 95% 경고는 로그만 남김, 재시작 트리거 없음
- 349.8%는 context 계산 버그 (soma-nok6, 이건 별개 이슈)

### 가설 3: tool call timeout이 crash 유발? ❌ 배제
- `PROCESSING_TIMEOUT_MS = 60_000` (60초)
- timeout 시: `[STUCK] isProcessing stuck for 60s, auto-releasing` → isProcessing만 해제
- process.exit() 호출 안 함, crash 아님

## 결론: SIGTERM 원인은 외부

채원봇의 재시작 원인은:
1. **외부에서 `make up` 또는 `systemctl restart` 실행** (스크린샷에 명시)
2. **systemd가 soma 프로세스에 SIGTERM 전송**
3. **Claude Code 자식 프로세스가 SIGTERM 받아서 exit code 143으로 종료**
4. **adapter에서 NormalizedProviderError 발생**
5. **이게 unhandled rejection으로 전파 → process.exit(1)**
6. **systemd Restart=always → 자동 재시작**

### [STUCK] 반복의 원인:
- SIGTERM 이후 Claude Code 프로세스는 죽었지만 isProcessing flag는 해제 안 됨
- 60초 timeout guard가 반복적으로 [STUCK] 로그 남김
- 이건 bug는 아니고 timeout guard가 정상 작동하는 것

## 핵심 질문에 대한 답:

**"tool call이 타임아웃 나면서 재시작될 수 있음?"**

→ **직접적으로는 NO.** tool call timeout은 `[STUCK]` 로그 + isProcessing 해제만 함. process.exit() 호출 안 함.

→ **간접적으로는 YES.** Claude Code 프로세스가 SIGTERM 받으면 (systemd restart, make up 등) exit code 143 → NormalizedProviderError → unhandled rejection → process.exit(1) → systemd가 재시작.

→ 이 케이스는 **외부에서 `make up / systemctl restart`가 트리거**된 것. 누가 했는지는 로그에서 확인 필요.
