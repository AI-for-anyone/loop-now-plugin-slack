// 假的 PluginAPI：状态、配置、密钥在内存里；channels.* / identities.* / platform.fetch 记下调用，按一个很小的平台模型回答。

import type { ChannelHandlers, EventContext, InboxMessage, PluginAPI, PluginEvent, QuestionAnswer } from '@loop-now/plugin-sdk'

export interface Call {
  fn: string
  args: unknown[]
}

export interface ProjectRow {
  id: string
  name: string
  managerAgentId: string | null
  /** 项目级配置（x-scope: project）。 */
  config?: Record<string, unknown>
}

/** 平台返回的错误（与宿主一样带 status 与 code）。 */
export function platformError(status: number, code: string, message = code): Error {
  return Object.assign(new Error(`平台返回 ${status}：${message}`), { status, code, details: null })
}

type Lifecycle = () => unknown

export class FakeApi {
  readonly calls: Call[] = []
  readonly logs: { level: string; text: string }[] = []
  readonly state = new Map<string, unknown>()
  readonly projects = new Map<string, ProjectRow>()
  /** 启用了插件的项目（api.config.projects()）。 */
  readonly enabled = new Set<string>()
  readonly config: Record<string, unknown> = {}
  readonly secrets: Record<string, string> = {}
  /** 消息全文：channels.read / identities.read 的回答。 */
  readonly texts = new Map<string, string>()
  /** 回答时返回 409 的提问 id 与错误码。 */
  readonly closed = new Map<string, string>()
  /** 下一次调用这些函数时抛出的错误。 */
  readonly failNext = new Map<string, Error>()
  handlers: ChannelHandlers = {}
  private readonly starts: Lifecycle[] = []
  private readonly stops: Lifecycle[] = []
  private readonly configListeners: Lifecycle[] = []
  private readonly threads = new Map<string, string>()
  private seq = 0

  private message(threadId: string, extra: Partial<InboxMessage> = {}): InboxMessage {
    const id = `m${++this.seq}`
    this.threads.set(id, threadId)
    return { id, threadId, inReplyTo: null, text: '', preview: '', createdAt: new Date().toISOString(), readAt: null, from: {}, to: {}, ...extra }
  }

  private record(fn: string, ...args: unknown[]): void {
    this.calls.push({ fn, args })
    const err = this.failNext.get(fn)
    if (err) {
      this.failNext.delete(fn)
      throw err
    }
  }

  callsOf(fn: string): unknown[][] {
    return this.calls.filter((c) => c.fn === fn).map((c) => c.args)
  }

  private answered(questionId: string, input: QuestionAnswer, extra: Partial<InboxMessage> = {}): InboxMessage {
    const code = this.closed.get(questionId)
    if (code) throw platformError(409, code)
    const threadId = this.threads.get(questionId) ?? `t-${questionId}`
    return this.message(threadId, { answerTo: { messageId: questionId, optionId: input.optionId ?? null, optionLabel: input.optionId ? `选项${input.optionId}` : null }, ...extra })
  }

  /** 平台那边的一条消息（Agent 的回复、发给身份的消息）：记下它属于哪条线索与正文。 */
  seed(messageId: string, threadId: string, text: string): void {
    this.threads.set(messageId, threadId)
    this.texts.set(messageId, text)
  }

  async start(): Promise<void> {
    for (const fn of this.starts) await fn()
  }

  async stop(): Promise<void> {
    for (const fn of this.stops) await fn()
  }

  async changeConfig(): Promise<void> {
    for (const fn of this.configListeners) await fn()
  }

  ctx(event: { id: string }): EventContext {
    return { eventId: event.id, type: 'channel.outbound', projectId: null, agentId: null, taskId: null, runId: null, attempt: 1, signal: new AbortController().signal }
  }

  async outbound(event: Omit<PluginEvent<'channel.outbound'>, 'id' | 'type' | 'at' | 'agentId' | 'taskId' | 'runId' | 'projectId'> & { projectId?: string | null }): Promise<void> {
    const e = { id: `ev-${event.messageId}`, type: 'channel.outbound', at: new Date().toISOString(), projectId: null, agentId: null, taskId: null, runId: null, ...event } as PluginEvent<'channel.outbound'>
    await this.handlers.outbound!(e, this.ctx(e))
  }

  async identityInbound(event: Omit<PluginEvent<'identity.inbound'>, 'id' | 'type' | 'at' | 'agentId' | 'taskId' | 'runId' | 'projectId'> & { projectId?: string | null }): Promise<void> {
    const e = { id: `ev-${event.messageId}`, type: 'identity.inbound', at: new Date().toISOString(), projectId: null, agentId: null, taskId: null, runId: null, ...event } as PluginEvent<'identity.inbound'>
    await this.handlers.identityInbound!(e, this.ctx(e))
  }

  hasLog(level: string, pattern: RegExp): boolean {
    return this.logs.some((l) => l.level === level && pattern.test(l.text))
  }

  build(): PluginAPI {
    const self = this
    const log = (level: string) => (...args: unknown[]) => self.logs.push({ level, text: args.map(String).join(' ') })
    const no = (name: string) => () => {
      throw new Error(`测试里没有 ${name}`)
    }
    return {
      id: 'slack',
      version: '0.1.0',
      root: '/plugin',
      dataDir: '/data',
      on: no('on'),
      lifecycle: {
        on(phase, handler) {
          ;(phase === 'start' ? self.starts : self.stops).push(() => handler({ signal: new AbortController().signal }))
          return () => {}
        },
      },
      state: {
        async get<T>(key: string) {
          return (self.state.has(key) ? structuredClone(self.state.get(key)) : null) as T | null
        },
        async set(key, value) {
          self.state.set(key, structuredClone(value))
        },
        async delete(key) {
          self.state.delete(key)
        },
        async list<T>(prefix: string) {
          return [...self.state.entries()]
            .filter(([k]) => k.startsWith(prefix))
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .slice(0, 1000)
            .map(([key, value]) => ({ key, value: structuredClone(value) as T }))
        },
      },
      config: {
        get<T extends object>(projectId?: string | null) {
          return { ...self.config, ...(projectId ? self.projects.get(projectId)?.config : {}) } as T
        },
        projects: () => [...self.enabled].sort(),
        onChange(listener) {
          self.configListeners.push(listener)
          return () => {}
        },
      },
      secrets: { get: (name) => self.secrets[name] },
      accounts: { list: no('accounts.list') },
      platform: {
        apiUrl: 'http://platform/api/v1',
        async fetch(path) {
          self.record('fetch', path)
          const m = /^\/projects\/([^/]+)$/.exec(path)
          const p = m ? self.projects.get(decodeURIComponent(m[1]!)) : undefined
          if (!p || !self.enabled.has(p.id)) return Response.json({ error: { code: 'forbidden', message: '插件没有在这个项目里启用' } }, { status: 403 })
          return Response.json({ id: p.id, name: p.name, managerAgentId: p.managerAgentId })
        },
      },
      log: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
      actions: { register: no('actions.register') },
      http: { handle: no('http.handle') },
      schedule: { on: no('schedule.on') },
      channels: {
        register(id, handlers) {
          if (id !== 'slack') throw new Error(`没有声明渠道 ${id}`)
          self.handlers = handlers
          return () => {}
        },
        async send(channelId, input) {
          self.record('channels.send', channelId, input)
          return self.message(`t${self.seq + 1}`, { text: input.text })
        },
        async reply(messageId, input) {
          self.record('channels.reply', messageId, input)
          return self.message(self.threads.get(messageId) ?? '?', { text: input.text, inReplyTo: messageId })
        },
        async read(messageId) {
          self.record('channels.read', messageId)
          return { ...self.message(self.threads.get(messageId) ?? '?'), id: messageId, text: self.texts.get(messageId) ?? '' }
        },
        async answer(channelId, questionId, input) {
          self.record('channels.answer', channelId, questionId, input)
          return self.answered(questionId, input)
        },
      },
      identities: {
        async read(identityId, messageId) {
          self.record('identities.read', identityId, messageId)
          return { ...self.message(self.threads.get(messageId) ?? '?'), id: messageId, text: self.texts.get(messageId) ?? '', to: { kind: 'external', name: 'ops' } }
        },
        async reply(identityId, messageId, input) {
          self.record('identities.reply', identityId, messageId, input)
          return self.message(self.threads.get(messageId) ?? '?', { text: input.text, inReplyTo: messageId })
        },
        async answer(identityId, questionId, input) {
          self.record('identities.answer', identityId, questionId, input)
          return self.answered(questionId, input)
        },
      },
    }
  }
}
