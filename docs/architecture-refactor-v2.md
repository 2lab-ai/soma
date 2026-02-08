# SOMA Architecture Refactor v2.0 — Hexagonal Architecture

## Legend
| Symbol | Meaning |
|--------|---------|
| → | leads to / transforms into |
| ↔ | bidirectional |
| ← | depends on |
| ⊕ | new (doesn't exist yet) |

---

## 1. Executive Summary

**목적**: Soma (Claude Telegram Bot)를 Hexagonal Architecture (Ports & Adapters)로 전면 리팩토링
**핵심 원칙**: 디렉토리 구조 = 아키텍처, App/Lib 철저 분리, 테스트 전면 재작성

### AS-IS 문제점

| 문제 | 심각도 | 파일 | Lines |
|------|--------|------|-------|
| God Class | CRITICAL | session.ts | 1,527 |
| Handler 비대화 | HIGH | text.ts | 927 |
| 관심사 미분리 | HIGH | Telegram ↔ Claude SDK 결합 | 전체 |
| DI 부재 | HIGH | 직접 import, singleton 버그 | scheduler.ts |
| Type 덤프 | MEDIUM | types.ts | 25+ interfaces |
| Config 메가파일 | MEDIUM | config.ts | 모든 설정 혼합 |
| 이벤트 시스템 없음 | MEDIUM | 직접 콜백만 | 전체 |
| 테스트 갭 | HIGH | text, commands, callback, document | 0% |

### TO-BE 아키텍처

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Layer                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │   Telegram    │  │   Discord    │  │   CLI / Web      │  │
│  │   Adapter     │  │   (Future)   │  │   (Future)       │  │
│  │  (Grammy)     │  │              │  │                  │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬─────────┘  │
│         │                  │                    │            │
│  ═══════╪══════════════════╪════════════════════╪═══════════ │
│         │          Inbound Ports                │            │
│  ┌──────▼──────────────────▼────────────────────▼─────────┐ │
│  │              Core (Library Layer)                        │ │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐   │ │
│  │  │ Domain  │  │ Services │  │   Event Bus         │   │ │
│  │  │ Session │←─│ Query    │──│ query.started       │   │ │
│  │  │ Query   │  │ Session  │  │ query.tool_used     │   │ │
│  │  │ Message │  │ Command  │  │ query.text          │   │ │
│  │  │ Events  │  │ Cron     │  │ query.completed     │   │ │
│  │  └─────────┘  └────┬─────┘  │ session.created     │   │ │
│  │                     │        └─────────────────────┘   │ │
│  │  ═══════════════════╪═════════════════════════════════ │ │
│  │                     │   Outbound Ports                  │ │
│  └─────────────────────┼──────────────────────────────────┘ │
│         ┌──────────────┼──────────────┐                     │
│  ┌──────▼──────┐ ┌─────▼──────┐ ┌────▼──────┐             │
│  │  Claude     │ │  File      │ │  Croner   │             │
│  │  Adapter    │ │  Storage   │ │  Adapter  │             │
│  │  (SDK)      │ │  Adapter   │ │           │             │
│  └─────────────┘ └────────────┘ └───────────┘             │
│  ┌─────────────┐ ┌────────────┐                            │
│  │  OpenAI     │ │  Memory    │                            │
│  │  Adapter    │ │  Storage   │                            │
│  │  (Whisper)  │ │  Adapter   │                            │
│  └─────────────┘ └────────────┘                            │
└─────────────────────────────────────────────────────────────┘
```

---

## 2. Architecture Decision: Why Hexagonal

| 패턴 | 장점 | 단점 | 판정 |
|------|------|------|------|
| **Hexagonal** | Port/Adapter 경계 명확, provider-agnostic core, testable | 약간의 보일러플레이트 | ✅ **채택** |
| Clean Architecture | 레이어 분리 | 이 규모에 레이어가 너무 많음 | ❌ 과도 |
| Vertical Slices | 기능 응집도 | multi-platform 요건에 부적합 | ❌ 불충분 |

**핵심 근거:**
- Multi-provider (Claude/OpenAI/Gemini) → AI provider = Outbound Adapter
- Multi-platform (Telegram/Discord) → Messaging platform = Inbound Adapter
- Core Domain = Session/Query 오케스트레이션 → platform & provider 무관

**레퍼런스:**
- [Sairyss/domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon) — DDD + Hexagonal TS
- [bot-base/telegram-bot-template](https://github.com/bot-base/telegram-bot-template) — Grammy 공식 추천 구조
- [grammyjs/examples/scaling](https://github.com/grammyjs/examples/tree/main/scaling) — Composer 기반 스케일링

---

## 3. Target Directory Structure

```
src/
├── index.ts                      # ⊕ Bootstrap only (~30 lines)
├── container.ts                  # ⊕ Manual DI wiring (no framework)
│
├── core/                         # ⊕ LIBRARY LAYER (pure, no I/O, no framework deps)
│   ├── domain/                   # Pure domain models & value objects
│   │   ├── session.ts            #   SessionState (pure state machine)
│   │   ├── query.ts              #   QueryState (idle→running→done)
│   │   ├── message.ts            #   IncomingMessage, OutgoingMessage value objects
│   │   ├── steering.ts           #   SteeringBuffer (pure FIFO logic)
│   │   └── events.ts             #   Domain event type definitions
│   │
│   ├── ports/                    # Interfaces (contracts)
│   │   ├── inbound/
│   │   │   ├── messaging.ts      #   MessagingPort (receive messages, send replies)
│   │   │   └── commands.ts       #   CommandPort (bot commands)
│   │   └── outbound/
│   │       ├── ai-provider.ts    #   AIProviderPort (query, abort, stream)
│   │       ├── transcriber.ts    #   TranscriberPort (voice→text)
│   │       ├── storage.ts        #   StoragePort (session persist/load)
│   │       ├── chat-log.ts       #   ChatLogPort (conversation logging)
│   │       └── scheduler.ts      #   SchedulerPort (cron jobs)
│   │
│   └── services/                 # Application services (orchestration)
│       ├── query-service.ts      #   Query lifecycle: prepare→execute→stream→complete
│       ├── session-service.ts    #   Session lifecycle: create/resume/clear/persist
│       ├── steering-service.ts   #   Steering: buffer/inject/consume
│       ├── command-service.ts    #   Command routing & execution
│       └── cron-service.ts       #   Scheduled job orchestration
│
├── adapters/                     # APPLICATION LAYER (framework-specific)
│   ├── inbound/                  # Driving adapters (user-facing)
│   │   └── telegram/
│   │       ├── bot.ts            #   Grammy bot init + middleware chain
│   │       ├── context.ts        #   Custom Grammy Context type
│   │       ├── middleware/
│   │       │   ├── auth.ts       #   Authorization middleware
│   │       │   ├── rate-limit.ts #   Rate limiting middleware
│   │       │   └── sequentialize.ts # Per-chat serialization
│   │       ├── handlers/
│   │       │   ├── text.ts       #   Thin dispatcher → queryService
│   │       │   ├── voice.ts      #   Whisper + queryService
│   │       │   ├── photo.ts      #   Vision + queryService
│   │       │   ├── document.ts   #   File extraction + queryService
│   │       │   ├── callback.ts   #   Inline keyboard callbacks
│   │       │   └── commands.ts   #   /new /stop /status etc → commandService
│   │       ├── streaming/
│   │       │   ├── state.ts      #   StreamingState (message tracking)
│   │       │   ├── renderer.ts   #   Telegram message edit/create
│   │       │   └── formatting.ts #   Markdown→HTML conversion
│   │       └── ui/
│   │           ├── choice-builder.ts    # Inline keyboard builder
│   │           ├── choice-extractor.ts  # JSON choice parser
│   │           └── reactions.ts         # Reaction constants
│   │
│   └── outbound/                 # Driven adapters (external services)
│       ├── ai/
│       │   ├── claude-adapter.ts #   Claude Agent SDK → AIProviderPort
│       │   ├── usage-tracker.ts  #   Claude/Codex/Gemini usage APIs
│       │   └── model-config.ts   #   Model selection logic
│       ├── transcription/
│       │   └── whisper-adapter.ts #  OpenAI Whisper → TranscriberPort
│       ├── storage/
│       │   ├── file-storage.ts   #   File-based → StoragePort
│       │   ├── chat-storage.ts   #   NDJSON chat logs → ChatLogPort
│       │   └── summary-storage.ts #  Summary persistence
│       ├── scheduler/
│       │   └── croner-adapter.ts #   croner lib → SchedulerPort
│       └── memory/               #   Memory system adapters
│           ├── analyzer.ts
│           ├── updater.ts
│           └── retention.ts
│
├── config/                       # ⊕ Configuration modules
│   ├── index.ts                  #   Config aggregator
│   ├── env.ts                    #   Environment variables
│   ├── paths.ts                  #   Path allowlists
│   ├── security.ts               #   Blocked patterns, rate limits
│   ├── mcp.ts                    #   MCP server configuration
│   ├── prompts.ts                #   System/safety prompts
│   └── constants.ts              #   Timeouts, limits, defaults
│
├── types/                        # ⊕ Shared type definitions (split by domain)
│   ├── index.ts                  #   Re-exports
│   ├── session.ts                #   SessionData, TokenUsage, ActivityState
│   ├── query.ts                  #   QueryState, StatusCallback, QueryMetadata
│   ├── messaging.ts              #   IncomingMessage, OutgoingMessage (platform-agnostic)
│   ├── ai.ts                     #   AIEvent, AIProviderCapabilities
│   ├── cron.ts                   #   CronSchedule, CronConfig
│   └── usage.ts                  #   ClaudeUsage, CodexUsage, GeminiUsage
│
└── shared/                       # ⊕ Cross-cutting concerns
    ├── events/
    │   └── event-bus.ts          #   Typed EventEmitter
    ├── security/
    │   ├── auth.ts               #   User/group authorization
    │   ├── rate-limiter.ts       #   Token bucket rate limiting
    │   └── path-validator.ts     #   Path allowlist validation
    └── utils/
        ├── logging.ts            #   Audit logging
        └── time.ts               #   Time formatting
```

### 디렉토리 규칙

| 디렉토리 | Import 규칙 | 의존성 방향 |
|----------|------------|------------|
| `core/domain/` | 자체 타입만. 외부 import 금지 | → types/ |
| `core/ports/` | 자체 타입만. 인터페이스만 정의 | → types/ |
| `core/services/` | ports/ + domain/ + shared/ | → core/ports/, core/domain/, types/ |
| `adapters/inbound/` | core/services/ + shared/ | → core/, shared/, types/ |
| `adapters/outbound/` | core/ports/ + 외부 라이브러리 | → core/ports/, types/, 외부 lib |
| `config/` | 외부 import 없음 | 독립 |
| `shared/` | types/만 | → types/ |

**핵심**: core/ 안에서는 grammy, claude-agent-sdk, croner 등 외부 라이브러리 import 절대 불가.

---

## 4. Design Patterns

### 4.1 Ports & Adapters (Hexagonal) — Concrete Interfaces

#### 4.1.1 AIProviderPort (Outbound — Model Abstraction)

```typescript
// core/ports/outbound/ai-provider.ts — THE CONTRACT

// ── AIEvent: discriminated union for all model stream events ──
export type AIEvent =
  | { type: 'text'; content: string; segmentId: number }
  | { type: 'thinking'; content: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens: number; outputTokens: number;
      cacheRead?: number; cacheCreation?: number }
  | { type: 'session_created'; sessionId: string }
  | { type: 'complete'; stopReason: StopReason }
  | { type: 'error'; error: Error; recoverable: boolean }

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | 'abort'

// ── Provider capabilities (adapter self-declares) ──
export interface ProviderCapabilities {
  streaming: boolean
  tools: boolean
  vision: boolean
  thinking: boolean
  maxContextTokens: number
  supportedModels: string[]
}

// ── Query params (platform-agnostic) ──
export interface QueryParams {
  message: string
  sessionId: string | null
  model: string
  systemPrompt: string
  mcpServers?: MCPServerConfig[]
  tools?: ToolDefinition[]
  maxTokens?: number
  abortSignal?: AbortSignal
}

// ── Tool safety hook (registered on port, ANDed together) ──
export type ToolSafetyHook = (
  tool: { name: string; input: Record<string, unknown> }
) => { allowed: boolean; reason?: string }

// ── THE PORT ──
export interface AIProviderPort {
  query(params: QueryParams): AsyncIterable<AIEvent>
  abort(): void
  registerToolSafetyHook(hook: ToolSafetyHook): void
  readonly capabilities: ProviderCapabilities
}
```

#### 4.1.2 MessagingChannelPort (Inbound — Channel I/O Abstraction)

```typescript
// core/ports/inbound/messaging.ts — Split Input/Output

// ── Platform-agnostic message ──
export interface IncomingMessage {
  id: string
  chatId: string
  userId: string
  text?: string
  attachments: Attachment[]
  replyToMessageId?: string
  timestamp: Date
}

export type Attachment =
  | { type: 'photo'; fileId: string; mimeType: string }
  | { type: 'voice'; fileId: string; duration: number }
  | { type: 'document'; fileId: string; fileName: string; mimeType: string }
  | { type: 'video'; fileId: string; duration: number }

// ── Streaming context for progressive updates ──
export interface StreamingContext {
  sendText(text: string): Promise<string>        // returns messageId
  updateText(messageId: string, text: string): Promise<void>
  sendTypingIndicator(): Promise<void>
  setReaction(messageId: string, emoji: string): Promise<void>
  removeReaction(messageId: string, emoji: string): Promise<void>
  sendChoiceKeyboard(text: string, choices: Choice[]): Promise<string>
  downloadFile(fileId: string): Promise<Buffer>
}

export interface Choice {
  id: string
  label: string
  description?: string
}

// ── Input port: receive messages ──
export interface MessagingInputPort {
  onMessage(handler: (msg: IncomingMessage, ctx: StreamingContext) => Promise<void>): void
  onCallback(handler: (callbackId: string, data: string, ctx: StreamingContext) => Promise<void>): void
  onCommand(handler: (command: string, args: string, ctx: StreamingContext) => Promise<void>): void
}

// ── Output port: send messages (used by services) ──
export interface MessagingOutputPort {
  sendText(chatId: string, text: string): Promise<string>
  sendTextStream(chatId: string): StreamingContext
  sendFile(chatId: string, file: Buffer, filename: string): Promise<void>
}
```

#### 4.1.3 AIProviderService (Domain Service — Rate-limit Fallback)

```typescript
// core/services/ai-provider-service.ts — Domain-level orchestration

export class AIProviderService {
  private providers: Map<string, AIProviderPort>      // 'claude' | 'openai' | 'gemini'
  private primaryProvider: string
  private fallbackChain: string[]

  constructor(
    providers: Record<string, AIProviderPort>,
    private eventBus: EventBus,
    private config: { primary: string; fallbackChain: string[] }
  ) {
    this.providers = new Map(Object.entries(providers))
    this.primaryProvider = config.primary
    this.fallbackChain = config.fallbackChain
  }

  async *query(params: QueryParams): AsyncIterable<AIEvent> {
    const chain = [this.primaryProvider, ...this.fallbackChain]
    let lastError: Error | null = null

    for (const providerId of chain) {
      const provider = this.providers.get(providerId)
      if (!provider) continue

      try {
        yield* provider.query(params)
        return // success
      } catch (err) {
        lastError = err as Error
        this.eventBus.emit({
          type: 'provider.fallback',
          from: providerId,
          to: chain[chain.indexOf(providerId) + 1] ?? 'none',
          error: lastError.message
        })
        // rate limit → try next provider
        if (!this.isRetryable(err)) throw err
      }
    }

    throw lastError ?? new Error('All providers exhausted')
  }

  abort(): void {
    for (const provider of this.providers.values()) {
      provider.abort()
    }
  }

  private isRetryable(err: unknown): boolean {
    const msg = String(err)
    return /429|rate.limit|overloaded|quota/i.test(msg)
  }
}
```

#### 4.1.4 Adapter Skeletons

```typescript
// adapters/outbound/ai/claude-adapter.ts
import { Claude } from '@anthropic-ai/claude-agent-sdk'

export class ClaudeProviderAdapter implements AIProviderPort {
  private session: Claude | null = null
  private abortController = new AbortController()
  private safetyHooks: ToolSafetyHook[] = []

  constructor(private config: ClaudeConfig) {}

  get capabilities(): ProviderCapabilities {
    return {
      streaming: true, tools: true, vision: true,
      thinking: true, maxContextTokens: 200_000,
      supportedModels: ['opus', 'sonnet', 'haiku']
    }
  }

  registerToolSafetyHook(hook: ToolSafetyHook): void {
    this.safetyHooks.push(hook)
  }

  async *query(params: QueryParams): AsyncIterable<AIEvent> {
    this.abortController = new AbortController()

    const options: Options = {
      model: params.model,
      systemPrompt: params.systemPrompt,
      mcpServers: params.mcpServers,
      maxTurns: Infinity,
      abortController: this.abortController,
      hooks: {
        preToolUse: (tool) => this.checkToolSafety(tool),
        postToolUse: (tool) => this.emitToolResult(tool),
      }
    }

    const result = this.session
      ? await this.session.query(params.message, options)
      : await Claude.query(params.message, options)

    // Map Claude SDK events → AIEvent union
    for await (const event of result) {
      yield this.mapSdkEvent(event)
    }
  }

  abort(): void {
    this.abortController.abort()
  }

  private checkToolSafety(tool: ToolUse): void {
    for (const hook of this.safetyHooks) {
      const result = hook({ name: tool.name, input: tool.input })
      if (!result.allowed) {
        throw new Error(`Tool blocked: ${tool.name} — ${result.reason}`)
      }
    }
  }

  private mapSdkEvent(event: SdkEvent): AIEvent {
    // Maps Claude Agent SDK events to our AIEvent discriminated union
    // Each event type has a direct mapping
    switch (event.type) {
      case 'assistant': return { type: 'text', content: event.content, segmentId: event.segmentId }
      case 'tool_use': return { type: 'tool_use', id: event.id, name: event.name, input: event.input }
      case 'result': return { type: 'complete', stopReason: event.stopReason }
      default: return { type: 'error', error: new Error(`Unknown: ${event.type}`), recoverable: false }
    }
  }
}
```

```typescript
// adapters/inbound/telegram/telegram-adapter.ts
import { Bot, Composer, Context } from 'grammy'

export class TelegramMessagingAdapter implements MessagingInputPort, MessagingOutputPort {
  private bot: Bot
  private messageHandler?: (msg: IncomingMessage, ctx: StreamingContext) => Promise<void>

  constructor(config: TelegramConfig) {
    this.bot = new Bot(config.token)
    this.setupMiddleware()
  }

  // ── MessagingInputPort ──
  onMessage(handler: (msg: IncomingMessage, ctx: StreamingContext) => Promise<void>): void {
    this.messageHandler = handler
    this.bot.on('message:text', async (grammyCtx) => {
      const msg = this.extractMessage(grammyCtx)
      const streamCtx = this.createStreamingContext(grammyCtx)
      await handler(msg, streamCtx)
    })
  }

  onCallback(handler: (id: string, data: string, ctx: StreamingContext) => Promise<void>): void {
    this.bot.on('callback_query:data', async (grammyCtx) => {
      const streamCtx = this.createStreamingContext(grammyCtx)
      await handler(grammyCtx.callbackQuery.id, grammyCtx.callbackQuery.data, streamCtx)
    })
  }

  onCommand(handler: (cmd: string, args: string, ctx: StreamingContext) => Promise<void>): void {
    // Register known commands
    for (const cmd of ['new', 'stop', 'status', 'steer', 'cron']) {
      this.bot.command(cmd, async (grammyCtx) => {
        const streamCtx = this.createStreamingContext(grammyCtx)
        await handler(cmd, grammyCtx.match ?? '', streamCtx)
      })
    }
  }

  // ── MessagingOutputPort ──
  async sendText(chatId: string, text: string): Promise<string> {
    const msg = await this.bot.api.sendMessage(chatId, text, { parse_mode: 'HTML' })
    return String(msg.message_id)
  }

  sendTextStream(chatId: string): StreamingContext {
    return new TelegramStreamingContext(this.bot.api, chatId)
  }

  async sendFile(chatId: string, file: Buffer, filename: string): Promise<void> {
    await this.bot.api.sendDocument(chatId, new InputFile(file, filename))
  }

  // ── Internal ──
  private extractMessage(ctx: Context): IncomingMessage {
    return {
      id: String(ctx.message!.message_id),
      chatId: String(ctx.chat!.id),
      userId: String(ctx.from!.id),
      text: ctx.message!.text,
      attachments: [],
      timestamp: new Date(ctx.message!.date * 1000),
    }
  }

  private createStreamingContext(ctx: Context): StreamingContext {
    return new TelegramStreamingContext(this.bot.api, String(ctx.chat!.id))
  }

  async start(): Promise<void> { await this.bot.start() }
  async stop(): Promise<void> { this.bot.stop() }
}
```

### 4.2 Event Bus (Observer Pattern)

```typescript
// shared/events/event-bus.ts
export type DomainEvent =
  | { type: 'query.started'; sessionId: string; message: string }
  | { type: 'query.tool_used'; tool: string; duration: number }
  | { type: 'query.tool_blocked'; tool: string; reason: string }
  | { type: 'query.text'; content: string; segmentId: number }
  | { type: 'query.thinking'; content: string }
  | { type: 'query.completed'; usage: TokenUsage }
  | { type: 'query.failed'; error: Error }
  | { type: 'query.steering_injected'; count: number }
  | { type: 'provider.fallback'; from: string; to: string; error: string }
  | { type: 'session.created'; id: string }
  | { type: 'session.cleared' }
  | { type: 'session.context_warning'; percent: number }

export class EventBus {
  private emitter = new EventEmitter()
  emit(event: DomainEvent): void
  on<T extends DomainEvent['type']>(type: T, handler: Handler<T>): void
  off<T extends DomainEvent['type']>(type: T, handler: Handler<T>): void
}
```

### 4.3 Manual DI Container (Multi-Provider + Multi-Channel)

```typescript
// container.ts — Composition Root
export function createContainer(config: AppConfig) {
  const eventBus = new EventBus()

  // ── Outbound adapters: AI providers (multi-provider) ──
  const claudeProvider = new ClaudeProviderAdapter(config.claude)
  const openaiProvider = new OpenAIProviderAdapter(config.openai)  // future
  // Register tool safety hooks on each provider
  const pathHook: ToolSafetyHook = (tool) => ({
    allowed: validateToolPath(tool), reason: 'Path outside allowlist'
  })
  claudeProvider.registerToolSafetyHook(pathHook)

  // Domain service: rate-limit fallback chain
  const aiService = new AIProviderService(
    { claude: claudeProvider, openai: openaiProvider },
    eventBus,
    { primary: 'claude', fallbackChain: ['openai'] }
  )

  // ── Outbound adapters: storage/scheduler ──
  const storage = new FileStorageAdapter(config.paths)
  const chatLog = new ChatStorageAdapter(config.paths)
  const scheduler = new CronerAdapter(config.cron)
  const transcriber = new WhisperAdapter(config.openai)

  // ── Core services ──
  const sessionService = new SessionService(storage, eventBus)
  const queryService = new QueryService(aiService, sessionService, eventBus)
  const steeringService = new SteeringService(queryService, eventBus)
  const commandService = new CommandService(sessionService, queryService)
  const cronService = new CronService(scheduler, queryService, sessionService)

  // ── Inbound adapters: messaging channels (multi-channel) ──
  const channels: MessagingChannel[] = []

  if (config.telegram?.token) {
    const telegram = new TelegramMessagingAdapter(config.telegram)
    wireChannel(telegram, { queryService, sessionService, steeringService,
      commandService, cronService, eventBus, chatLog, transcriber })
    channels.push({ name: 'telegram', adapter: telegram })
  }

  // Future channels:
  // if (config.discord?.token) { channels.push(new DiscordAdapter(config.discord)) }
  // if (config.slack?.token)   { channels.push(new SlackAdapter(config.slack)) }

  return {
    start: () => Promise.all(channels.map(c => c.adapter.start())),
    stop: () => Promise.all(channels.map(c => c.adapter.stop())),
  }
}

function wireChannel(channel: MessagingInputPort, deps: ServiceDeps): void {
  channel.onMessage(async (msg, ctx) => {
    await deps.queryService.execute(msg, ctx)
  })
  channel.onCommand(async (cmd, args, ctx) => {
    await deps.commandService.handle(cmd, args, ctx)
  })
  channel.onCallback(async (id, data, ctx) => {
    await deps.commandService.handleCallback(id, data, ctx)
  })
}
```

### 4.4 State Machine (Session & Query)

```typescript
// core/domain/session.ts
export type SessionPhase = 'idle' | 'active' | 'restoring' | 'compacting'

export class SessionState {
  readonly id: string | null
  readonly phase: SessionPhase
  readonly tokenUsage: TokenUsage
  readonly queryCount: number

  static create(): SessionState
  resume(id: string): SessionState
  accumulate(usage: TokenUsage): SessionState
  clear(): SessionState
}
```

### 4.5 Strategy Pattern (Model Selection)

```typescript
// adapters/outbound/ai/model-config.ts
export interface ModelSelectionStrategy {
  select(context: ModelSelectionContext): ModelId
}

export class DefaultModelStrategy implements ModelSelectionStrategy {
  select(ctx: ModelSelectionContext): ModelId {
    if (ctx.contextUsagePercent > 85) return 'haiku'
    if (ctx.isRateLimited) return 'sonnet'
    return ctx.preferredModel
  }
}
```

### 4.6 Grammy Composer Pattern (Handler Organization)

```typescript
// adapters/inbound/telegram/handlers/text.ts
export function createTextFeature(deps: TextDeps): Composer<BotContext> {
  const composer = new Composer<BotContext>()
  composer.on('message:text', async (ctx) => {
    const msg = extractMessage(ctx)
    await deps.queryService.execute(msg)
  })
  return composer
}
```

---

## 5. Decomposition Maps

### 5.1 session.ts (1527 lines) → 12 targets

| 현재 책임 | Lines | Target | 디자인 패턴 |
|----------|-------|--------|------------|
| Session state machine | ~100 | `core/domain/session.ts` | State Machine |
| Query execution loop | ~300 | `core/services/query-service.ts` | Service |
| Claude SDK integration | ~200 | `adapters/outbound/ai/claude-adapter.ts` | Adapter |
| Steering buffer | ~80 | `core/domain/steering.ts` + `core/services/steering-service.ts` | Value Object + Service |
| Token usage tracking | ~100 | `core/domain/session.ts` (accumulate) | Value Object |
| Context window calc | ~100 | `core/services/session-service.ts` | Service |
| Tool safety hooks | ~80 | `shared/security/path-validator.ts` → ToolSafetyHook | Hook on Port |
| Abort/Kill logic | ~60 | `core/domain/query.ts` | State Machine |
| Auto-continue | ~100 | `core/services/query-service.ts` | Strategy |
| Model selection | ~80 | `adapters/outbound/ai/model-config.ts` | Strategy |
| Cron queue | ~50 | `core/services/cron-service.ts` | Service |
| Session persistence | ~50 | `adapters/outbound/storage/file-storage.ts` | Adapter |

### 5.2 sendMessageStreaming (565 lines, L729-1294) → AIProviderPort decomposition

이 God method가 모델 추상화의 핵심 대상.

```
현재 흐름 (monolithic):
L810-835:  Claude SDK Options 구성         → ClaudeProviderAdapter.query() 내부
L919-925:  Claude.query() / session.query() → ClaudeProviderAdapter.query() 호출
L927-1179: AsyncGenerator 이터레이션       → AIEvent union으로 표준화
  L964-1038: Tool execution + safety check → ToolSafetyHook + AIEvent.tool_use/tool_result
  L1046-1110: Context window 추출          → AIEvent.usage + SessionService
L271-285:  PreToolUseHook (abort 체크)     → AbortSignal on QueryParams
L287-317:  PostToolUseHook (steering 주입) → SteeringService.consumeOnToolComplete()
```

**매핑 상세:**

| 현재 코드 위치 | AIEvent 타입 | Target |
|---------------|-------------|--------|
| `stream_event` → text content | `AIEvent.text` | QueryService iterates |
| `stream_event` → thinking | `AIEvent.thinking` | QueryService → EventBus |
| Tool execution result | `AIEvent.tool_use` + `AIEvent.tool_result` | Adapter emits, Service reacts |
| `result` event → token counts | `AIEvent.usage` | SessionService.accumulate |
| `result` event → session id | `AIEvent.session_created` | SessionService.resume |
| End of stream | `AIEvent.complete` | QueryService finishes |
| Error in stream | `AIEvent.error` + recoverable flag | AIProviderService fallback |

### 5.3 Telegram coupling points → MessagingChannelPort abstraction

| 현재 결합 | 위치 | 추상화 |
|----------|------|--------|
| `ctx.reply()` / `ctx.api.editMessageText()` | text.ts, streaming.ts | `StreamingContext.sendText/updateText` |
| `ctx.replyWithChatAction('typing')` | text.ts:63 | `StreamingContext.sendTypingIndicator` |
| `ctx.react()` | text.ts:115, callback.ts | `StreamingContext.setReaction/removeReaction` |
| `ctx.api.sendDocument()` | document.ts | `MessagingOutputPort.sendFile` |
| `ctx.message.voice` / photo / document | voice.ts, photo.ts | `IncomingMessage.attachments` |
| `InlineKeyboard` builder | utils/choice-builder.ts | `StreamingContext.sendChoiceKeyboard` |
| StatusCallback (tool status text) | streaming.ts | `EventBus` → channel adapter listens |
| `env.TELEGRAM_*` config | config.ts | `ChannelConfig` per adapter |

---

## 6. Testing Strategy

### Layer별 테스트 전략

| Layer | 테스트 유형 | Mock 대상 | 테스트 위치 |
|-------|-----------|----------|------------|
| `core/domain/` | **Unit** (pure) | 없음 | `core/domain/__tests__/` |
| `core/services/` | **Integration** | Ports | `core/services/__tests__/` |
| `adapters/inbound/` | **Integration** | Services | `adapters/inbound/__tests__/` |
| `adapters/outbound/` | **Integration** | External APIs | `adapters/outbound/__tests__/` |
| Full system | **E2E** | 없음 (실제 TG bot) | `tests/e2e/` |

### 테스트 파일 규칙

```
__tests__/            # 각 디렉토리 안에 위치
  ├── session.test.ts
  ├── query.test.ts
  └── fixtures/       # 테스트 데이터
      └── mock-events.ts
```

### 테스트 예시

```typescript
// core/domain/__tests__/session.test.ts — Pure unit test, no mocks
describe('SessionState', () => {
  it('accumulates token usage correctly', () => {
    const s = SessionState.create()
      .accumulate({ input_tokens: 100, output_tokens: 50 })
      .accumulate({ input_tokens: 200, output_tokens: 100 })
    expect(s.tokenUsage.input_tokens).toBe(300)
    expect(s.queryCount).toBe(2)
  })
})

// core/services/__tests__/query-service.test.ts — Mock ports
describe('QueryService', () => {
  it('emits events during query execution', async () => {
    const mockProvider: AIProviderPort = {
      async *query() {
        yield { type: 'text', content: 'Hello', segmentId: 0 }
        yield { type: 'done', usage: { input_tokens: 10, output_tokens: 5 } }
      },
      abort: () => {},
      capabilities: { streaming: true, tools: true }
    }
    const events: DomainEvent[] = []
    const bus = new EventBus()
    bus.on('query.text', e => events.push(e))

    const service = new QueryService(mockProvider, mockSessionService, bus)
    await service.execute({ message: 'Hi', sessionId: null })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'query.text', content: 'Hello' })
  })
})
```

---

## 7. Migration Strategy: Incremental Strangler Fig

### Phase 순서 (의존성 기반)

```
Phase 0: Skeleton        → 디렉토리 + 타입 + 포트 인터페이스
Phase 1: Config Split    → config.ts 분리
Phase 2: Shared Extract  → security, events, utils 추출
Phase 3: Domain Extract  → core/domain/ 순수 로직 추출
Phase 4: Services Create → core/services/ 오케스트레이션
Phase 5: AI Adapter      → Claude SDK 분리 → AIProviderPort
Phase 6: Storage Adapter → persistence 분리
Phase 7: Telegram Handlers → 새 handler로 마이그레이션
Phase 8: Test Rewrite    → 전체 테스트 재작성
Phase 9: Cleanup         → 구 코드 삭제, final verification
```

### Phase별 상세

| Phase | 작업 | 예상 시간 | 선행 조건 |
|-------|------|----------|----------|
| 0 | 디렉토리 생성 + types/ 분리 + port 인터페이스 정의 (AIProviderPort, MessagingChannelPort) | 4h | 없음 |
| 1 | config.ts → config/*.ts 분리 | 3h | Phase 0 |
| 2 | security, events, utils 추출 → shared/ (EventBus, ToolSafetyHook) | 4h | Phase 0 |
| 3 | SessionState, QueryState, SteeringBuffer 순수 도메인 추출 | 6h | Phase 0 |
| 4 | QueryService, SessionService, SteeringService 생성 | 8h | Phase 2, 3 |
| 5a | ClaudeProviderAdapter 생성 (sendMessageStreaming 분해) | 6h | Phase 4 |
| 5b | AIProviderService 생성 (rate-limit fallback chain) | 3h | Phase 5a |
| 6 | FileStorage, ChatStorage, Scheduler 어댑터 마이그레이션 | 4h | Phase 4 |
| 7a | TelegramMessagingAdapter 생성 (MessagingInputPort + OutputPort) | 6h | Phase 4 |
| 7b | Grammy handlers → Adapter 위에 Composer 재조립 | 5h | Phase 7a |
| 8 | 전체 테스트 재작성 (domain unit + service integration + adapter) | 12h | Phase 3-7 |
| 9 | container.ts 완성 + 구 코드 삭제 + 최종 검증 | 4h | Phase 8 |
| **Total** | | **~65h** | |

---

## 8. Architectural Decisions Required

### Decision 1: Event Bus Implementation
**Options:**
- A) Node.js EventEmitter (동기, 단순) ← **추천**
- B) RxJS Observable (비동기 스트림, 복잡)
- C) 직접 Pub/Sub 구현

**추천 근거:** Single-process bot, UI 업데이트는 동기로 충분. RxJS는 이 규모에 과도.

### Decision 2: DI Container
**Options:**
- A) Manual factory function ← **추천**
- B) tsyringe (decorator 기반)
- C) inversify (reflection 기반)

**추천 근거:** Zero deps, explicit wiring, Bun 호환, 디버깅 용이.

### Decision 3: Test Runner
**Options:**
- A) Bun test (현재) ← **유지 추천**
- B) Vitest (더 많은 기능)

**추천 근거:** 이미 Bun 런타임, 의존성 추가 불필요.

### Decision 4: Migration 방식
**Options:**
- A) Incremental Strangler Fig ← **추천**
- B) Big Bang Rewrite

**추천 근거:** Bot은 production에서 실행 중. Big bang은 위험. Strangler fig는 phase마다 deploy 가능.

### Decision 5: AI Provider Abstraction
**Options:**
- A) `AsyncIterable<AIEvent>` discriminated union ← **추천**
- B) Callback-based (onText, onTool, onComplete)
- C) RxJS Observable stream

**추천 근거:** AsyncIterable은 for-await-of로 자연스럽게 소비, backpressure 내장, generator로 구현 용이. Discriminated union으로 타입 안전한 event dispatch.

### Decision 6: Messaging Channel Split
**Options:**
- A) Input/Output split (MessagingInputPort + MessagingOutputPort) ← **추천**
- B) Single MessagingPort (모든 I/O 하나로)
- C) Event-driven only (channel이 EventBus로만 통신)

**추천 근거:** Input은 event-driven (onMessage), Output은 imperative (sendText). 서로 다른 패턴이므로 분리가 자연스러움. StreamingContext로 progressive update 추상화.

### Decision 7: Rate-limit Fallback 위치
**Options:**
- A) Domain service layer (AIProviderService) ← **추천**
- B) Adapter 내부
- C) Middleware/Decorator

**추천 근거:** Fallback 정책은 비즈니스 규칙 (어떤 provider를 언제 사용할지). Port는 단일 provider만 알아야 함. Service가 여러 port를 조합.

---

## 9. File Migration Mapping

### 현재 → 새 위치

| 현재 파일 | → 새 위치 | 비고 |
|----------|----------|------|
| `session.ts` | 7개로 분해 (§5 참조) | God class 해체 |
| `handlers/text.ts` | `adapters/inbound/telegram/handlers/text.ts` | Thin dispatcher |
| `handlers/commands.ts` | `adapters/inbound/telegram/handlers/commands.ts` | |
| `handlers/streaming.ts` | `adapters/inbound/telegram/streaming/*.ts` | 3파일로 분리 |
| `handlers/callback.ts` | `adapters/inbound/telegram/handlers/callback.ts` | |
| `handlers/voice.ts` | `adapters/inbound/telegram/handlers/voice.ts` | |
| `handlers/photo.ts` | `adapters/inbound/telegram/handlers/photo.ts` | |
| `handlers/document.ts` | `adapters/inbound/telegram/handlers/document.ts` | |
| `config.ts` | `config/*.ts` (7파일) | |
| `types.ts` | `types/*.ts` (6파일) | |
| `security.ts` | `shared/security/auth.ts` + `rate-limiter.ts` | |
| `formatting.ts` | `adapters/inbound/telegram/streaming/formatting.ts` | |
| `usage.ts` | `adapters/outbound/ai/usage-tracker.ts` | |
| `model-config.ts` | `adapters/outbound/ai/model-config.ts` | |
| `scheduler.ts` | `adapters/outbound/scheduler/croner-adapter.ts` + `core/services/cron-service.ts` | |
| `session-manager.ts` | `core/services/session-service.ts` | |
| `services/*.ts` | `adapters/outbound/memory/*.ts` + `adapters/outbound/storage/*.ts` | |
| `storage/*.ts` | `adapters/outbound/storage/*.ts` | |
| `utils/*.ts` | `adapters/inbound/telegram/ui/*.ts` + `shared/utils/*.ts` | |

---

## 10. Success Criteria

- [ ] `core/` 안에 외부 라이브러리 import 없음 (`grammy`, `claude-agent-sdk`, `croner`, `openai` 등)
- [ ] `core/domain/` 모든 파일 pure function/class (no I/O, no async in domain objects)
- [ ] Port 인터페이스 기반으로 adapter 교체 가능 (mock adapter로 전체 core 테스트 가능)
- [ ] 단일 파일 300줄 미만 (예외: 테스트 파일)
- [ ] 테스트 커버리지: domain 95%+, services 85%+, adapters 70%+
- [ ] Bot 무중단 마이그레이션 (phase별 deploy)
- [ ] 모든 기존 기능 유지 (regression 없음)

---

## References

### Architecture
- [Hexagonal Architecture — Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)
- [domain-driven-hexagon (TypeScript)](https://github.com/Sairyss/domain-driven-hexagon)
- [Clean Architecture with TypeScript](https://github.com/pvarentsov/typescript-clean-architecture)

### Grammy
- [Grammy Scaling Guide](https://grammy.dev/advanced/structuring)
- [Grammy Middleware Guide](https://grammy.dev/guide/middleware)
- [bot-base/telegram-bot-template](https://github.com/bot-base/telegram-bot-template)

### Claude Agent SDK
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Building Agents with Claude](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk)
- [claude-agent-sdk-typescript](https://github.com/anthropics/claude-agent-sdk-typescript)
