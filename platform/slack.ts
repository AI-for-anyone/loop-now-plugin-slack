// Slack 连接：Socket Mode（App-Level Token）收事件与按钮回调，Web API（Bot Token）发消息。
// Socket Mode 客户端自带的重连在取连接地址遇到网络错误时会放弃、并留下没人处理的 Promise 拒绝，
// 所以关掉它，由 SocketLink 按退避重连：断线或连不上时 1、2、5、10、30、60 秒（之后保持 60 秒），连上后从头算。

import type { PluginLog } from '@loop-now/plugin-sdk'
import { SocketModeClient } from '@slack/socket-mode'
import { type Logger, LogLevel, WebClient } from '@slack/web-api'

export const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000]

/** 重试也不会好的错误（令牌无效、被吊销、应用或工作区停用）：停下来，等改了配置再连。 */
const FATAL = new Set([
  'not_authed',
  'invalid_auth',
  'account_inactive',
  'token_revoked',
  'token_expired',
  'not_allowed_token_type',
  'user_removed_from_team',
  'team_disabled',
])

/** Slack 平台返回的错误码（ok: false 时的 error），其他错误为 null。 */
export function slackErrorCode(err: unknown): string | null {
  const data = (err as { data?: { error?: unknown } } | null)?.data
  return typeof data?.error === 'string' ? data.error : null
}

export function describe(err: unknown): string {
  if (err === undefined || err === null) return '连接被关闭'
  return err instanceof Error ? err.message : String(err)
}

/**
 * 给 Slack 库用的日志：只转出 warn 与 error，并且降为插件的 debug，免得和下面自己的连接日志重复；debug 里有原始事件，丢掉。
 * alive 为 false（这个客户端已被替换或停用）后不再记。
 */
function libraryLogger(log: PluginLog, alive: () => boolean = () => true): Logger {
  const forward = (...msg: unknown[]) => {
    if (alive()) log.debug('[slack]', ...msg)
  }
  return {
    debug: () => {},
    info: () => {},
    warn: forward,
    error: forward,
    setLevel: () => {},
    getLevel: () => LogLevel.WARN,
    setName: () => {},
  }
}

export interface WebOptions {
  slackApiUrl?: string
  /** 每次调用的重试次数（网络错误、5xx、限流），默认 2。 */
  retries?: number
  alive?: () => boolean
}

export function createWeb(botToken: string, log: PluginLog, o: WebOptions = {}): WebClient {
  return new WebClient(botToken, {
    slackApiUrl: o.slackApiUrl,
    logger: libraryLogger(log, o.alive),
    retryConfig: { retries: o.retries ?? 2, factor: 2, minTimeout: 500, maxTimeout: 5_000 },
    timeout: 15_000,
  })
}

/** Socket Mode 的一个信封：events_api 的 body 是事件回调（含 event），interactive 的 body 是交互载荷。 */
export interface Envelope {
  type: string
  body: unknown
}

export interface SocketLinkOptions {
  appToken: string
  log: PluginLog
  onEnvelope: (envelope: Envelope) => void
  slackApiUrl?: string
  backoffMs?: number[]
}

export type LinkState = 'connecting' | 'connected' | 'waiting' | 'failed' | 'stopped'

export class SocketLink {
  state: LinkState = 'stopped'
  private readonly o: SocketLinkOptions
  private readonly backoff: number[]
  private client: SocketModeClient | null = null
  private timer: NodeJS.Timeout | undefined
  private failures = 0
  /** 每次 start / stop 加一；旧连接的回调看到代数变了就什么都不做。 */
  private generation = 0

  constructor(o: SocketLinkOptions) {
    this.o = o
    this.backoff = o.backoffMs?.length ? o.backoffMs : DEFAULT_BACKOFF_MS
  }

  start(): void {
    const g = ++this.generation
    this.failures = 0
    void this.connect(g)
  }

  async stop(): Promise<void> {
    this.generation++
    this.state = 'stopped'
    clearTimeout(this.timer)
    const c = this.client
    this.client = null
    if (c) await close(c)
  }

  private async connect(g: number): Promise<void> {
    if (g !== this.generation) return
    this.state = 'connecting'
    const { log } = this.o
    const client: SocketModeClient = new SocketModeClient({
      appToken: this.o.appToken,
      autoReconnectEnabled: false,
      logger: libraryLogger(log, (): boolean => g === this.generation && this.client === client),
      // 取连接地址失败时不在库里重试，交给这里的退避；也不能一直挂着。
      clientOptions: { slackApiUrl: this.o.slackApiUrl, retryConfig: { retries: 0 }, timeout: 15_000 },
    })
    this.client = client
    client.on('slack_event', ({ ack, type, body }: { ack: () => Promise<void>; type: string; body: unknown }) => {
      // Slack 要求 3 秒内确认，否则重发；先确认再处理，重复的消息由上层按 channel + ts 去重。
      ack().catch((err: unknown) => log.warn(`确认 Slack 事件失败：${describe(err)}`))
      if (g !== this.generation) return
      try {
        this.o.onEnvelope({ type, body })
      } catch (err) {
        log.error(`处理 Slack 事件失败：${describe(err)}`)
      }
    })
    try {
      await client.start()
    } catch (err) {
      if (this.client === client) this.client = null
      await close(client)
      if (g !== this.generation) return
      const code = slackErrorCode(err)
      if (code && FATAL.has(code)) {
        this.state = 'failed'
        log.error(`Slack 拒绝了 App-Level Token（${code}）：检查 appToken 与它的 connections:write 权限；改好配置后会重新连接`)
        return
      }
      this.retry(g, `连不上 Slack（${code ?? describe(err)}）`)
      return
    }
    if (g !== this.generation) {
      await close(client)
      return
    }
    this.state = 'connected'
    if (this.failures > 0) log.info(`已重新连上 Slack（之前失败 ${this.failures} 次）`)
    else log.info('已连上 Slack（Socket Mode）')
    this.failures = 0
    client.once('disconnected', () => {
      if (g !== this.generation || this.client !== client) return
      this.client = null
      // Slack 会定期回收连接（disconnect 消息），这是正常的，第一次立刻按最短间隔重连。
      this.retry(g, 'Slack 连接断开')
    })
  }

  private retry(g: number, reason: string): void {
    const delay = this.backoff[Math.min(this.failures, this.backoff.length - 1)]!
    this.failures++
    this.state = 'waiting'
    const text = `${reason}，${delay >= 1000 ? `${Math.round(delay / 1000)} 秒` : `${delay} 毫秒`}后重连`
    if (this.failures === 1) this.o.log.info(text)
    else this.o.log.warn(`${text}（第 ${this.failures} 次）`)
    this.timer = setTimeout(() => void this.connect(g), delay)
  }
}

/** 关闭一个客户端：最多等 3 秒，出错也不管。 */
async function close(client: SocketModeClient): Promise<void> {
  client.removeAllListeners('slack_event')
  let timer: NodeJS.Timeout | undefined
  await Promise.race([
    client.disconnect().catch(() => {}),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, 3_000)
    }),
  ])
  clearTimeout(timer)
}
