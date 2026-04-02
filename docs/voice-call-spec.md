# Telegram Real-Time Voice Call Spec

> **Status**: Draft / Research Complete
> **Date**: 2025-12-31 (updated 2026-03-27)
> **Author**: Elon (soma AGI)
> **Purpose**: 텔레그램 음성 통화를 통한 실시간 AI 대화 파이프라인 기획

---

## 1. Overview

사용자와 AI가 실시간으로 음성 대화하는 시스템. 두 가지 접근법을 비교.

**핵심 가치**: 음성 메시지(비동기)가 아닌, 실시간 양방향 통화.

### 접근법 비교

| | **Approach A: Userbot (VoIP)** | **Approach B: Mini App (WebRTC)** |
|---|---|---|
| **별도 계정** | ✅ 필요 (전화번호) | ❌ 불필요 |
| **마이크 접근** | pytgcalls (네이티브) | getUserMedia (WebView 제약 있음) |
| **UX** | 네이티브 통화 UI | 웹앱 커스텀 UI |
| **밴 리스크** | 있음 (Userbot) | 없음 (공식 Bot API) |
| **구현 난이도** | 중 (pytgcalls) | 중-상 (WebRTC + 서버) |
| **플랫폼 호환** | 높음 (네이티브 VoIP) | 중 (WebView 차이) |
| **권장** | Phase 2+ | **Phase 1 (PoC)** ✅ |

---

# PART A: Mini App 방식 (권장)

## A.1 개요

Telegram Mini App(WebApp) 내에서 브라우저 Web API로 마이크 접근 → WebSocket으로 서버에 실시간 오디오 전송 → STT → Claude → TTS → 오디오 스트림 다시 클라이언트로.

```
┌─────────────────────────────────────────────────┐
│         Telegram Client (Android/iOS)           │
│  ┌───────────────────────────────────────────┐  │
│  │          Mini App (WebView)               │  │
│  │                                           │  │
│  │  getUserMedia() → MediaRecorder/          │  │
│  │  AudioWorklet → WebSocket ──────────┐     │  │
│  │                                     │     │  │
│  │  <audio> / AudioContext ◄── WS ◄──┐ │     │  │
│  └───────────────────────────────────┘─┘─────┘  │
└──────────────────────────┬───┬──────────────────┘
                           │   │  WebSocket (wss://)
                           ▼   ▲
┌──────────────────────────────────────────────────┐
│              Voice Call Server (Node.js)          │
│                                                  │
│  WebSocket Server ─── Audio Pipeline Manager     │
│       │                    │          │          │
│       ▼                    ▼          ▼          │
│  ┌─────────┐    ┌──────────┐  ┌─────────────┐   │
│  │   VAD   │    │   STT    │  │    TTS      │   │
│  │ Silero  │    │  Cohere  │  │  fish-tts   │   │
│  └────┬────┘    └────┬─────┘  └──────▲──────┘   │
│       │              │               │           │
│       └──────────────▼───────────────┘           │
│                 ┌──────────┐                     │
│                 │  Claude  │                     │
│                 │   LLM    │                     │
│                 └──────────┘                     │
└──────────────────────────────────────────────────┘
```

**Telegram 네이티브 VoIP 미사용. 별도 계정 불필요.**

## A.2 Mini App 마이크 접근 — 현실적 제약

### getUserMedia in WebView

Telegram Mini App은 WebView(내장 브라우저) 안에서 실행됨.
`getUserMedia()`로 마이크 접근 가능하지만 **플랫폼별 차이**가 큼:

| Platform | getUserMedia Audio | Notes |
|----------|-------------------|-------|
| **Android** | ⚠️ 조건부 동작 | HTTPS 필수, Telegram 앱이 RECORD_AUDIO 퍼미션 보유 시 동작. 일부 기기에서 실패 보고 |
| **iOS** | ⚠️ 조건부 동작 | WKWebView에서 getUserMedia 지원. Telegram 앱의 마이크 권한 필요. 카메라는 블랙스크린 버그 있으나 오디오는 별도 |
| **Desktop** | ✅ 높은 호환성 | Chromium 기반 WebView, 표준 Web API 완전 지원 |
| **Web (browser)** | ✅ 완전 지원 | web.telegram.org에서 Mini App 실행 시 브라우저 네이티브 API |

### 핵심 발견

- Telegram 10.12+ 클라이언트는 **Mini App 오디오 샌드박싱** 기능 도입
- Mini App이 오디오 캡처하면 "Mini App audio lock"이 활성화됨
- 이는 **Mini App에서 마이크 접근이 가능하다는 증거**
- 공식 API에 `requestMicrophone()` 메서드는 없지만, WebView의 네이티브 `getUserMedia`로 접근

### Fallback 전략

```
1차: getUserMedia({ audio: true }) 시도
    ↓ 실패 시
2차: MediaRecorder API로 녹음 시도
    ↓ 실패 시
3차: 사용자에게 "브라우저에서 열기" 안내 (web.telegram.org)
    ↓ 또는
4차: 음성메시지 모드로 fallback (기존 비동기 방식)
```

## A.3 기술 스택

| Component | Technology | Description |
|-----------|-----------|-------------|
| **Mini App Frontend** | HTML5 + Vanilla JS (or React) | 전화 UI, 오디오 캡처/재생 |
| **Audio Capture** | `getUserMedia` + `AudioWorklet` | 실시간 마이크 입력 |
| **Audio Playback** | `AudioContext` + `AudioWorklet` | 실시간 오디오 출력 |
| **Transport** | **WebSocket** (wss://) | 양방향 실시간 오디오 스트리밍 |
| **Audio Codec** | PCM 16-bit 16kHz mono (upstream) | STT 최적 포맷 |
| | PCM 16-bit 24kHz mono (downstream) | TTS 출력 포맷 |
| **Voice Server** | **Node.js** + `ws` library | WebSocket 서버 + 파이프라인 오케스트레이션 |
| **VAD** | **Silero VAD** (ONNX) or `@ricky0123/vad-web` | 음성 구간 감지 |
| **STT** | **Cohere Transcribe** (localhost:8787) | 음성→텍스트 |
| **LLM** | **Claude** via soma session | 텍스트 응답 생성 |
| **TTS** | **fish-tts** (IU voice) | 텍스트→음성 |
| **Bot Integration** | **grammy** (기존 soma bot) | Mini App 런칭 + 세션 관리 |

## A.4 Detailed Flow

### A.4.1 Call Initiation

```
1. 사용자가 /call 명령 또는 인라인 버튼 클릭
2. Bot이 Mini App URL을 WebApp 버튼으로 전송
3. 사용자가 버튼 클릭 → Mini App 열림
4. Mini App이 마이크 권한 요청
5. 권한 획득 → WebSocket 연결 (wss://server:PORT/voice)
6. 서버에서 세션 생성 + 인증 (Telegram initData 검증)
7. 양방향 오디오 스트리밍 시작
```

**Bot 측 코드 (grammy):**
```typescript
// /call 명령 핸들러
bot.command("call", async (ctx) => {
  await ctx.reply("🎙️ 음성 통화를 시작합니다", {
    reply_markup: {
      inline_keyboard: [[
        {
          text: "📞 통화 시작",
          web_app: { url: `${VOICE_APP_URL}?session=${sessionId}` }
        }
      ]]
    }
  });
});
```

### A.4.2 Upstream (User → AI)

```
[Browser Microphone]
    → getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } })
    → AudioWorklet (PCM float32 → int16 변환)
    → WebSocket binary frames (매 20ms, 640 bytes)
    → Server VAD: 음성 구간 감지
    → Speech segment 추출 (silence 300ms 이상 → 발화 종료)
    → WAV 헤더 추가 → Cohere STT API
    → Transcribed text → Claude
```

**AudioWorklet Processor (client):**
```javascript
// voice-processor.js
class VoiceProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0][0]; // mono channel
    if (input) {
      // float32 → int16 변환
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        pcm16[i] = Math.max(-32768, Math.min(32767, input[i] * 32768));
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
    return true;
  }
}
registerProcessor('voice-processor', VoiceProcessor);
```

### A.4.3 Downstream (AI → User)

```
Claude text response
    → 문장 단위 분할 (마침표/물음표/느낌표 기준)
    → fish-tts → WAV (24kHz mono)
    → WAV → PCM int16 추출
    → WebSocket binary frames로 클라이언트에 전송
    → Client AudioContext → AudioWorklet → 스피커 재생
```

**Client 재생 코드:**
```javascript
// PCM 수신 → AudioBuffer → 재생
ws.onmessage = (event) => {
  if (event.data instanceof ArrayBuffer) {
    const pcm16 = new Int16Array(event.data);
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768;
    }
    const buffer = audioCtx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);
    // Queue for gapless playback
    playbackQueue.push(buffer);
    schedulePlayback();
  }
};
```

### A.4.4 WebSocket Protocol

```
// Client → Server (upstream audio)
Binary frame: PCM int16 mono 16kHz, 20ms chunks (640 bytes)

// Server → Client (downstream audio)
Binary frame: PCM int16 mono 24kHz, variable length

// Control messages (JSON)
{ "type": "call_start", "session": "abc123" }
{ "type": "transcription", "text": "안녕하세요" }  // STT 결과 표시용
{ "type": "response_text", "text": "네, 안녕하세요!" }  // Claude 응답 텍스트
{ "type": "speaking_start" }  // AI 발화 시작
{ "type": "speaking_end" }    // AI 발화 끝
{ "type": "call_end" }
{ "type": "error", "message": "..." }

// Client control
{ "type": "mute" }
{ "type": "unmute" }
{ "type": "hangup" }
{ "type": "interrupt" }  // AI 발화 중단 (barge-in)
```

## A.5 Mini App UI

```
┌──────────────────────────────┐
│     🎙️ AI Voice Call        │
│                              │
│    ┌──────────────────┐      │
│    │                  │      │
│    │   🔵 Connected   │      │
│    │   00:42          │      │
│    │                  │      │
│    └──────────────────┘      │
│                              │
│  💬 "안녕하세요, 지혁님"       │
│  🗣️ "네, 오늘 뭐 할까?"       │
│  💬 "오늘 계획을 알려드릴게요"   │
│                              │
│  ┌────┐  ┌────┐  ┌────┐     │
│  │🔇  │  │ ⏸️ │  │ 📞 │     │
│  │Mute│  │Hold│  │End │     │
│  └────┘  └────┘  └────┘     │
└──────────────────────────────┘
```

- 실시간 자막 (STT + Claude 응답 텍스트)
- 음소거/통화종료 버튼
- 통화 시간 표시
- 연결 상태 인디케이터

## A.6 File Structure

```
~/2lab.ai/soma/
├── src/
│   ├── voice-call/
│   │   ├── server.ts           # WebSocket voice server
│   │   ├── audio-pipeline.ts   # VAD + STT + TTS orchestration
│   │   ├── vad.ts              # Silero VAD (ONNX runtime)
│   │   └── session.ts          # Call session management
│   ├── handlers/
│   │   └── commands/
│   │       └── system-commands.ts  # /call command 추가
│   └── ...
├── public/
│   └── voice-app/
│       ├── index.html          # Mini App entry
│       ├── app.js              # Main app logic
│       ├── voice-processor.js  # AudioWorklet processor
│       ├── style.css           # Call UI styles
│       └── telegram-web-app.js # Telegram WebApp SDK
├── docs/
│   └── voice-call-spec.md     # ← 이 문서
└── ...
```

## A.7 Dependencies (Mini App 방식 추가분)

```
# Node.js (soma에 추가)
ws                      # WebSocket server
onnxruntime-node        # Silero VAD 실행 (Node.js용)

# Client-side (Mini App, CDN 또는 번들)
telegram-web-app.js     # Telegram WebApp SDK (공식)

# 기존 재사용
cohere-stt              # localhost:8787 (이미 설치됨)
fish-tts                # 이미 설치됨
```

## A.8 Risks & Mitigations (Mini App)

| Risk | Impact | Mitigation |
|------|--------|-----------|
| getUserMedia 실패 (일부 기기) | 마이크 접근 불가 | Fallback UI + "브라우저에서 열기" 안내 |
| WebView 오디오 레이턴시 | 지연 증가 | AudioWorklet 사용 (ScriptProcessorNode 대비 저지연) |
| iOS WKWebView 제약 | 블랙스크린/권한 문제 | 오디오만 사용 (비디오 제외), 명시적 권한 요청 |
| WebSocket 끊김 | 통화 중단 | 자동 재연결 + heartbeat (30s) |
| HTTPS 인증서 | getUserMedia 차단 | Let's Encrypt + 도메인 설정 필수 |
| GPU VRAM 부족 | STT/TTS 충돌 | Time-division (기존과 동일) |

## A.9 Implementation Plan (Mini App)

### Phase 1: Static Audio Test (1-2일)
1. Mini App 스켈레톤 생성 (HTML + JS)
2. getUserMedia로 마이크 캡처 테스트
3. WebSocket으로 오디오 바이너리 전송/수신 테스트
4. 서버에서 PCM 수신 → 파일 저장 → Cohere STT 호출 → 결과 반환

### Phase 2: Real-time Pipeline (3-5일)
5. VAD 통합 (발화 감지 → 자동 STT 호출)
6. Claude 연동 (STT 결과 → Claude → 응답 텍스트)
7. TTS 연동 (응답 텍스트 → fish-tts → PCM 스트림 → 클라이언트)
8. Gapless playback (문장 간 끊김 없는 재생)

### Phase 3: Polish (2-3일)
9. UI 마무리 (통화 시간, 자막, 버튼)
10. Barge-in (사용자 끼어들기 → AI 발화 중단)
11. 에러 핸들링 + reconnect
12. soma /call 커맨드 통합

---

# PART B: Userbot VoIP 방식 (대안)

---

## B.1 Critical Constraint: Bot API는 통화 불가

### ❌ Telegram Bot API 한계

- Telegram **Bot API**는 음성/영상 통화를 **지원하지 않음**
- Bot API로 가능한 것: 텍스트, 사진, 음성메시지, 파일, 인라인 키보드 등
- Bot API로 **불가능한 것**: VoIP 통화 걸기/받기, 그룹 음성채팅 참여

### ✅ 해결 방법: Userbot (MTProto)

- **Userbot**: 일반 사용자 계정으로 MTProto API에 직접 접속
- **pytgcalls**: Telegram 통화용 C++ Python 확장 라이브러리
- **Pyrogram / Telethon**: MTProto 클라이언트 라이브러리

> ⚠️ **Userbot은 별도 Telegram 계정 필요** (봇 계정이 아닌 일반 유저 계정)

---

## B.2 Architecture

### B.2.1 System Components

```
┌─────────────────────────────────────────────────────┐
│                    Telegram Cloud                    │
│              (VoIP / MTProto Protocol)               │
└──────────────┬──────────────────┬───────────────────┘
               │ Inbound Audio    │ Outbound Audio
               ▼                  ▲
┌──────────────────────────────────────────────────────┐
│              Voice Call Bridge (Python)               │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐ │
│  │ Pyrogram │  │ pytgcalls│  │ Audio Stream Mgr   │ │
│  │ (MTProto)│  │ (VoIP)   │  │ (PCM I/O Buffer)   │ │
│  └──────────┘  └──────────┘  └────────────────────┘ │
└──────────┬───────────────────────────┬──────────────┘
           │ PCM chunks (20ms)         │ PCM chunks
           ▼                           ▲
┌─────────────────────┐    ┌─────────────────────────┐
│   STT Pipeline      │    │    TTS Pipeline          │
│                     │    │                          │
│ VAD (Silero/WebRTC) │    │  fish-tts (IU voice)    │
│ → Cohere Transcribe │    │  → PCM 48kHz 2ch        │
│ → Text output       │    │  → pytgcalls stream     │
└─────────┬───────────┘    └──────────▲──────────────┘
          │ Text                      │ Text
          ▼                           │
┌──────────────────────────────────────────────────────┐
│                  Claude (LLM)                        │
│            Streaming text response                   │
│              via Claude Agent SDK                    │
└──────────────────────────────────────────────────────┘
```

### B.2.2 Audio Format

| Parameter | Value | Notes |
|-----------|-------|-------|
| Format | PCM (raw) | s16le (signed 16-bit little-endian) |
| Channels | 2 (stereo) | pytgcalls requirement |
| Sample Rate | 48,000 Hz | Telegram VoIP standard |
| Bit Depth | 16-bit | |
| Frame Size | 20ms | 960 samples/ch × 2ch × 2bytes = 3,840 bytes/frame |

### B.2.3 Component Stack

| Layer | Technology | Role |
|-------|-----------|------|
| MTProto Client | **Pyrogram** 2.x | Telegram 사용자 인증 + API |
| VoIP Engine | **pytgcalls** 1.x | 통화 연결 + 오디오 스트리밍 |
| VAD | **Silero VAD** or WebRTC VAD | 음성 구간 감지 (발화 시작/끝) |
| STT | **Cohere Transcribe** (local, port 8787) | 음성→텍스트 |
| LLM | **Claude** (claude-sonnet-4-20250514) | 텍스트 응답 생성 |
| TTS | **fish-tts** (IU voice, local GPU) | 텍스트→음성 |
| Audio Convert | **ffmpeg** | WAV↔PCM 포맷 변환 |

---

## B.3 Detailed Flow

### B.3.1 Call Initiation

```python
from pyrogram import Client
from pytgcalls import PyTgCalls

# 1. Userbot 로그인 (별도 계정)
app = Client("ai_caller", api_id=API_ID, api_hash=API_HASH)
pytgcalls = PyTgCalls(app)

# 2. 통화 걸기 (Private Call)
await pytgcalls.start()

# Private call to user
from pytgcalls.types import AudioStream
stream = AudioStream(
    AudioPiped("silence.raw"),  # 초기 무음
)
await pytgcalls.call_participant(chat_id=USER_ID, stream=stream)
```

### B.3.2 Inbound Audio Processing (User → AI)

```
[pytgcalls raw stream]
    → PCM 48kHz stereo, 20ms frames
    → Ring buffer (accumulate ~2-3 seconds)
    → VAD: detect speech end (300ms silence threshold)
    → Extract speech segment
    → Convert: PCM 48kHz stereo → WAV 16kHz mono (for STT)
    → Cohere STT API → transcribed text
    → Send to Claude
```

**VAD Strategy**:
- **Silero VAD** (neural, more accurate) OR **WebRTC VAD** (faster, lighter)
- Speech start: 3+ consecutive voiced frames
- Speech end: 300ms+ silence after speech
- Min utterance: 500ms (ignore very short sounds)
- Max utterance: 30s (force segment at 30s)

### B.3.3 LLM Processing

```
Transcribed text
    → Claude via soma session (reuse existing infrastructure)
    → Streaming text response
    → Sentence-level chunking for TTS
```

**Streaming Strategy**:
- Claude 응답을 문장 단위로 잘라서 TTS에 바로 전달
- 첫 문장이 TTS 완료되면 바로 재생 시작 (latency 최소화)
- 나머지 문장은 파이프라인으로 계속 처리

### B.3.4 Outbound Audio (AI → User)

```
Claude text response (sentence chunks)
    → fish-tts (IU voice) → WAV file
    → Convert: WAV → PCM 48kHz stereo (for pytgcalls)
    → Feed to pytgcalls output stream
    → User hears AI response
```

---

## B.4 Latency Budget

| Stage | Target | Notes |
|-------|--------|-------|
| VAD + Silence detection | ~300ms | Speech end detection |
| Audio → STT | ~500-800ms | Cohere Transcribe, local GPU |
| STT → Claude (first token) | ~200-500ms | Streaming, depends on prompt |
| Claude → TTS (first sentence) | ~500-1000ms | fish-tts, local GPU |
| TTS → Audio playback | ~100ms | PCM conversion + buffer |
| **Total (speech end → AI voice start)** | **~1.5-2.5s** | Acceptable for conversation |

> 참고: 일반 인간 대화의 turn-taking gap은 ~200-500ms.
> 2초대 지연은 "약간 느리지만 자연스러운 대화" 수준.

---

## B.5 GPU Resource Management

### 문제: STT와 TTS가 동시에 GPU를 사용

| Model | VRAM Usage | Notes |
|-------|-----------|-------|
| Cohere Transcribe 2B | ~6 GB | STT |
| fish-speech 1.5 | ~17 GB | TTS |
| **Total** | **~23 GB** | RTX 4090 Laptop = 16GB ❌ |

### 해결 방안

**Option A: Time-Division (현재 구현)**
```
Listen (STT on GPU) → Think (CPU) → Speak (TTS on GPU)
```
- STT와 TTS를 시간적으로 분리
- 한 번에 하나만 GPU 사용
- ❌ 파이프라인 병렬화 불가, latency 증가

**Option B: Model Offloading**
```
STT: GPU (항상 로드)
TTS: CPU fallback or smaller model
```
- STT를 항상 GPU에 유지 (우선순위 높음)
- TTS는 CPU로 fallback하거나 경량 모델 사용
- ❌ TTS 품질/속도 저하

**Option C: Dedicated GPU (Recommended)**
```
GPU 0: STT (Cohere Transcribe)
GPU 1: TTS (fish-tts)
```
- 별도 GPU 확보 (데스크탑 RTX 4090 24GB 등)
- 또는 클라우드 GPU 인스턴스
- ✅ 완전한 병렬 파이프라인 가능

**Option D: Streaming STT + Chunked TTS**
```
STT: 작은 청크로 점진적 인식
TTS: 문장 단위로 빠르게 생성 후 GPU 해제
```
- STT 청크 처리 동안 TTS idle → TTS 실행
- 타이밍 최적화로 VRAM 충돌 최소화
- ⚠️ 구현 복잡도 높음

### 권장: Phase 1은 Option A, Phase 2에서 Option C 또는 D

---

## B.6 Implementation Plan (Userbot)

### Phase 1: Proof of Concept

**목표**: 통화 연결 + 기본 STT→Claude→TTS 파이프라인 동작 확인

1. **Userbot 설정**
   - 별도 Telegram 계정 준비 (전화번호 필요)
   - Pyrogram 세션 생성 + api_id/api_hash 발급
   - `my.telegram.org` → API development tools

2. **pytgcalls 기본 통화**
   - Private call 걸기/받기 테스트
   - Raw PCM 오디오 캡처 확인
   - 무음 스트림 → 고정 WAV 재생 테스트

3. **Audio Pipeline MVP**
   - Inbound: PCM → WAV → Cohere STT → text
   - Process: text → Claude → response text
   - Outbound: text → fish-tts → WAV → PCM → stream
   - Time-division GPU (Option A)

4. **VAD 통합**
   - Silero VAD로 발화 구간 감지
   - 적절한 청크 크기로 STT 호출

### Phase 2: Optimization

**목표**: 실시간 대화에 적합한 latency + 안정성

5. **Streaming Pipeline**
   - Claude 응답 문장 단위 스트리밍
   - TTS 파이프라인 병렬화
   - 오디오 버퍼 관리 최적화

6. **Interruption Handling**
   - 사용자가 AI 발화 중 끼어들기 (barge-in)
   - TTS 출력 즉시 중단 + 새 STT 시작
   - Echo cancellation (AI 출력이 마이크로 피드백되는 문제)

7. **GPU Optimization**
   - Option C (dedicated GPU) 또는 Option D (time-division 최적화)
   - VRAM 사용량 모니터링 + 자동 조절

### Phase 3: Production

8. **soma 통합**
   - Voice call bridge를 soma 서비스로 통합
   - 기존 세션 관리 시스템과 연동
   - `/call` 명령어로 AI가 전화 걸기

9. **품질 개선**
   - Noise suppression (RNNoise 등)
   - Adaptive VAD threshold
   - TTS 감정/톤 조절
   - Multi-turn context 관리

---

## B.7 File Structure (Userbot)

```
~/2lab.ai/soma/
├── src/
│   ├── voice-call/
│   │   ├── bridge.py           # Pyrogram + pytgcalls 브릿지
│   │   ├── audio-pipeline.py   # PCM ↔ WAV 변환 + 버퍼 관리
│   │   ├── vad.py              # Voice Activity Detection
│   │   ├── call-manager.py     # 통화 상태 관리
│   │   └── config.py           # Voice call 설정
│   └── ...
├── docs/
│   └── voice-call-spec.md      # ← 이 문서
└── ...
```

> **Note**: voice-call 모듈은 Python (pytgcalls 의존성).
> soma 본체(TypeScript)와는 HTTP/WebSocket으로 통신.

---

## B.8 Dependencies (Userbot)

```
# Python packages (별도 venv 권장)
pyrogram>=2.0           # MTProto client
pytgcalls>=1.0          # Telegram VoIP
py-tgcalls              # C++ binding for VoIP
silero-vad              # Voice Activity Detection (optional, can use webrtcvad)
webrtcvad               # Lightweight VAD alternative
numpy                   # Audio processing
soundfile               # Audio file I/O

# System
ffmpeg                  # Audio format conversion
```

### Telegram API Credentials (Userbot용)
- `API_ID`: my.telegram.org에서 발급
- `API_HASH`: my.telegram.org에서 발급
- **Phone number**: 별도 Telegram 계정의 전화번호
- **Session string**: Pyrogram 로그인 후 생성

---

## B.9 Risks & Mitigations (Userbot)

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Userbot 계정 밴 | 서비스 중단 | 별도 번호 사용, rate limit 준수, ToS 확인 |
| GPU VRAM 부족 | STT/TTS 동시 실행 불가 | Time-division (Phase 1), dedicated GPU (Phase 2) |
| Latency > 3s | 부자연스러운 대화 | 문장 단위 스트리밍, 경량 모델 옵션 |
| Echo/Feedback | 오디오 루프 | Echo cancellation, half-duplex mode |
| pytgcalls 불안정 | 통화 끊김 | 자동 재연결, heartbeat 모니터링 |
| Telegram API 변경 | 호환성 깨짐 | 버전 고정, 업데이트 모니터링 |

---

---

# PART C: 공통 사항

## C.1 Open Questions

1. **접근법 선택**: Mini App (A) vs Userbot (B) vs 둘 다?
2. **Userbot 계정** (B 선택 시): 기존 계정 사용 vs 새 번호 구매?
3. **HTTPS 도메인** (A 선택 시): Mini App 서빙용 도메인 + SSL 인증서?
4. **GPU 전략**: RTX 4090 Laptop 단독 vs 데스크탑/클라우드 추가?
5. **Half-duplex vs Full-duplex**: AI가 말하는 동안 사용자 음성도 들을 것인가?
6. **다중 통화**: 동시에 여러 사용자와 통화 지원?
7. **세션 연속성**: 통화 내용이 텍스트 대화 히스토리에도 반영?

## C.2 Recommendation

**Phase 1: Mini App (Approach A) 권장**

이유:
- 별도 Telegram 계정 불필요
- 밴 리스크 없음 (공식 Bot API + WebApp)
- soma 코드베이스(TypeScript)와 자연스럽게 통합
- WebSocket 서버를 soma에 내장 가능
- getUserMedia가 대부분의 환경에서 동작 (특히 Desktop/Web)
- 모바일에서 안 되면 "브라우저에서 열기" fallback

**Phase 2+ (선택): Userbot (Approach B) 추가**

이유:
- 네이티브 통화 UX (모바일 최적)
- getUserMedia 제약 없음
- 그룹 음성채팅 참여 가능

## C.3 References

- [Telegram Mini Apps Documentation](https://core.telegram.org/bots/webapps)
- [Telegram Mini Apps Community Docs](https://docs.telegram-mini-apps.com/)
- [getUserMedia Guide 2026 (AddPipe)](https://blog.addpipe.com/getusermedia-getting-started/)
- [ZEGOCLOUD WebRTC in Mini Apps](https://www.zegocloud.com/blog/telegram-mini-app)
- [MarshalX/telegram-webrtc-example](https://github.com/MarshalX/telegram-webrtc-example)
- [pytgcalls Documentation](https://pytgcalls.github.io/)
- [Pyrogram Documentation](https://docs.pyrogram.org/)
- [MarshalX/tgcalls](https://github.com/MarshalX/tgcalls) - Telegram VoIP C++ library
- [Telegram MTProto API](https://core.telegram.org/api)
- [Telegram E2E Encrypted Calls](https://core.telegram.org/api/end-to-end/video-calls)
- [Silero VAD](https://github.com/snakers4/silero-vad)
- [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)
- [fish-speech](https://github.com/fishaudio/fish-speech)
