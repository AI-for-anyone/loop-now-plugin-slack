// 假的 Slack：同一个端口上提供 Web API（POST /api/<方法>，表单编码）与 Socket Mode 的 WebSocket。
// 插件里用的是真的 @slack/web-api 与 @slack/socket-mode，只把 slackApiUrl 指到这里。

import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { type WebSocket, WebSocketServer } from 'ws'

export const APP_TOKEN = 'xapp-1-test-app-token'
export const BOT_TOKEN = 'xoxb-test-bot-token'
export const BOT_USER = 'UBOT'

export interface ApiCall {
  method: string
  token: string | null
  params: Record<string, unknown>
}

export interface Posted {
  channel: string
  ts: string
  thread_ts?: string
  text?: string
  blocks?: { type: string; block_id?: string; text?: string; elements?: unknown[] }[]
}

type Reply = Record<string, unknown> | { status: number; body: string }

async function readForm(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const out: Record<string, unknown> = {}
  for (const [k, v] of new URLSearchParams(raw)) {
    // @slack/web-api 把对象与数组参数（这里只有 blocks）序列化成 JSON 字符串。
    out[k] = k === 'blocks' ? JSON.parse(v) : v
  }
  return out
}

export class FakeSlack {
  readonly calls: ApiCall[] = []
  readonly messages: Posted[] = []
  readonly acks: string[] = []
  readonly users = new Map<string, string>([['U1', 'Alice'], ['U2', 'Bob']])
  /** apps.connections.open 接下来的回答（用完后正常回答）。 */
  readonly openReplies: Reply[] = []
  connections = 0
  private readonly server: Server
  private readonly wss: WebSocketServer
  private readonly sockets = new Set<WebSocket>()
  private readonly ackWaiters = new Map<string, () => void>()
  private seq = 0
  private envelope = 0

  private constructor() {
    this.server = createServer((req, res) => {
      void this.handle(req).then((reply) => {
        if ('status' in reply && typeof reply.status === 'number' && typeof reply.body === 'string') {
          res.writeHead(reply.status, { 'content-type': 'text/plain' }).end(reply.body)
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply))
      })
    })
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws) => {
      this.connections++
      this.sockets.add(ws)
      ws.on('close', () => this.sockets.delete(ws))
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as { envelope_id?: string }
        if (!m.envelope_id) return
        this.acks.push(m.envelope_id)
        this.ackWaiters.get(m.envelope_id)?.()
      })
      ws.send(JSON.stringify({ type: 'hello', num_connections: 1, connection_info: { app_id: 'A1' } }))
    })
  }

  static async start(): Promise<FakeSlack> {
    const s = new FakeSlack()
    await new Promise<void>((resolve) => s.server.listen(0, '127.0.0.1', resolve))
    return s
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port
  }

  get apiUrl(): string {
    return `http://127.0.0.1:${this.port}/api/`
  }

  get open(): number {
    return this.sockets.size
  }

  async close(): Promise<void> {
    for (const ws of this.sockets) ws.terminate()
    this.wss.close()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  callsTo(method: string): ApiCall[] {
    return this.calls.filter((c) => c.method === method)
  }

  private async handle(req: IncomingMessage): Promise<Reply> {
    const method = (req.url ?? '').replace(/^\/api\//, '').replace(/\?.*$/, '')
    const auth = req.headers.authorization
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    const params = await readForm(req)
    this.calls.push({ method, token, params })
    const expected = method === 'apps.connections.open' ? APP_TOKEN : BOT_TOKEN
    if (method === 'apps.connections.open') {
      const next = this.openReplies.shift()
      if (next) return next
    }
    if (token !== expected) return { ok: false, error: 'invalid_auth' }
    switch (method) {
      case 'apps.connections.open':
        return { ok: true, url: `ws://127.0.0.1:${this.port}/link` }
      case 'auth.test':
        return { ok: true, user_id: BOT_USER, bot_id: 'BBOT', team_id: 'T1' }
      case 'users.info': {
        const name = this.users.get(String(params.user))
        return name ? { ok: true, user: { id: params.user, name: name.toLowerCase(), profile: { display_name: name } } } : { ok: false, error: 'user_not_found' }
      }
      case 'chat.postMessage': {
        const requested = String(params.channel)
        const channel = requested.startsWith('U') ? `D${requested.slice(1)}` : requested
        const ts = `1700000000.${String(++this.seq).padStart(6, '0')}`
        const m: Posted = { channel, ts, text: params.text as string, blocks: params.blocks as Posted['blocks'] }
        if (typeof params.thread_ts === 'string') m.thread_ts = params.thread_ts
        this.messages.push(m)
        return { ok: true, channel, ts, message: m }
      }
      case 'chat.update':
        return { ok: true, channel: params.channel, ts: params.ts }
      case 'chat.postEphemeral':
        return { ok: true, message_ts: `1700000000.${String(++this.seq).padStart(6, '0')}` }
      default:
        return { ok: false, error: 'unknown_method' }
    }
  }

  private push(type: string, payload: unknown): Promise<string> {
    const id = `env-${++this.envelope}`
    const acked = new Promise<string>((resolve) => this.ackWaiters.set(id, () => resolve(id)))
    const ws = [...this.sockets][0]
    if (!ws) throw new Error('插件没有连着 Socket Mode')
    ws.send(JSON.stringify({ envelope_id: id, type, payload, accepts_response_payload: false, retry_attempt: 0, retry_reason: '' }))
    return acked
  }

  /** 推一个 events_api 事件，等插件确认。 */
  event(event: Record<string, unknown>): Promise<string> {
    return this.push('events_api', { type: 'event_callback', team_id: 'T1', event_id: `Ev${this.envelope + 1}`, event })
  }

  /** 推一个按钮点击（block_actions），等插件确认。 */
  click(o: { user: string; channel: string; message: Posted; actionIndex?: number }): Promise<string> {
    const actions = o.message.blocks?.find((b) => b.type === 'actions')?.elements as { action_id: string; value: string; text: { text: string } }[] | undefined
    const action = actions?.[o.actionIndex ?? 0]
    if (!action) throw new Error('这条消息没有按钮')
    return this.push('interactive', {
      type: 'block_actions',
      user: { id: o.user },
      channel: { id: o.channel },
      container: { type: 'message', channel_id: o.channel, message_ts: o.message.ts, thread_ts: o.message.thread_ts },
      message: { ts: o.message.ts, thread_ts: o.message.thread_ts, blocks: o.message.blocks },
      actions: [{ ...action, type: 'button', block_id: 'loopnow_actions', action_ts: `${Date.now() / 1000}` }],
    })
  }

  /** Slack 回收连接：发 disconnect 消息。 */
  recycle(): void {
    for (const ws of this.sockets) ws.send(JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }))
  }

  /** 网络断开：直接掐断。 */
  drop(): void {
    for (const ws of this.sockets) ws.terminate()
  }
}
