// Slack 插件的平台半边。两个方向：
// - 人 → Manager：在绑定了项目的频道里 @bot，或给 bot 发私信，消息以插件发件方转给该项目的 Manager；
//   Agent 的回复经 channel.outbound 贴回同一个 Slack 线程，Agent 的提问做成按钮，按钮与线程里的文字经 api.channels.answer 作答。
// - Agent → 人：外部身份交给本插件代管后，identity.inbound 贴到 identityTarget，每条平台线索一个 Slack 线程；
//   线程里的回复与按钮以该身份的名义送回（api.identities.reply / answer）。
// Slack 线程（channel + thread_ts）与平台线索的对应存在插件状态里；不在对应线程里的频道消息一律忽略、不存储。

import type { EventQuestion, InboxMessage, PluginAPI, PluginEvent, QuestionAnswer } from '@loop-now/plugin-sdk'
import type { WebClient } from '@slack/web-api'

import { ANSWER_ACTION, type Block, closedBlocks, chunks, escapeMrkdwn, fallbackText, fromSlack, messageBlocks, questionBlocks } from './format.ts'
import { createWeb, describe, type Envelope, slackErrorCode, SocketLink } from './slack.ts'

export const CHANNEL = 'slack'

/** 保留最近多少个线程的对应关系与已贴出的消息；更早的线程里再回复不会转回平台。 */
export const KEEP = 500

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NAME_TTL_MS = 60 * 60_000
const PROJECT_TTL_MS = 60_000
const SEEN_MAX = 5_000

interface Config {
  dmProject?: string
  identityTarget?: string
  /** 项目级：逗号或空白分隔的 Slack 频道 ID。 */
  channels?: string | string[]
}

/** 线程里正在等回答的提问（只记最近一个；更早的提问的按钮仍然有效）。 */
interface OpenQuestion {
  id: string
  options: { id: string; label: string }[]
  allowText: boolean
  deadline: string | null
  /** 提问那条 Slack 消息。 */
  ts: string
  /** 提问正文，回答后改写那条消息时用。 */
  text: string
  note: string | null
}

/** 一个 Slack 线程对应的平台线索。状态键 threads/<channel>/<threadTs>。 */
export interface ThreadLink {
  kind: 'manager' | 'identity'
  channel: string
  threadTs: string
  threadId: string
  projectId: string | null
  /** kind 为 identity 时：代管的外部身份。 */
  identityId: string | null
  /** 线索里最近的一条消息：线程里的回复以它为回复对象。 */
  lastMessageId: string
  /** kind 为 manager 时：发起这个线程的 Slack 用户。 */
  startedBy: string | null
  question: OpenQuestion | null
  at: string
}

interface ThreadRef {
  channel: string
  threadTs: string
}

interface Project {
  id: string
  name: string
  managerAgentId: string | null
}

/** Slack events_api 里用到的消息字段（app_mention、message）。 */
interface SlackMessage {
  type: string
  channel: string
  channel_type?: string
  user: string
  text?: string
  ts: string
  thread_ts?: string
  subtype?: string
  bot_id?: string
}

/** 发提示用：频道、用户、线程。 */
interface Where {
  channel: string
  user: string
  threadTs: string
}

export interface PluginOptions {
  /** Slack Web API 地址，默认 https://slack.com/api/（测试指向假的 Slack）。 */
  slackApiUrl?: string
  /** Socket Mode 重连的退避间隔。 */
  backoffMs?: number[]
  /** 每次 Web API 调用的重试次数。 */
  webRetries?: number
}

const threadKey = (channel: string, threadTs: string) => `threads/${channel}/${threadTs}`
const refKey = (threadId: string) => `platform-threads/${threadId}`
const postedKey = (messageId: string) => `posted/${messageId}`

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status
  return typeof s === 'number' ? s : null
}

function codeOf(err: unknown): string | null {
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' ? c : null
}

function closedNote(code: string | null): string {
  switch (code) {
    case 'already_answered':
      return '这道提问已经回答过了'
    case 'question_expired':
      return '这道提问已过期'
    case 'question_closed':
      return '这道提问已关闭'
    default:
      return '这道提问不再接受回答'
  }
}

/** 项目配置里的频道列表：接受逗号或空白分隔的字符串，也接受数组。 */
export function channelList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，]+/) : []
  return items.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean)
}

export function createPlugin(options: PluginOptions = {}) {
  return function register(api: PluginAPI): void {
    if (typeof api.channels.answer !== 'function' || typeof api.config.projects !== 'function') {
      throw new Error('这个插件需要更新的 Loop Now（宿主须提供 api.channels.answer 与 api.config.projects）')
    }
    new SlackBridge(api, options).register()
  }
}

class SlackBridge {
  private readonly api: PluginAPI
  private readonly options: PluginOptions
  private web: WebClient | null = null
  private link: SocketLink | null = null
  private tokens = ''
  private botUserId: string | null = null
  private identifying: Promise<void> | null = null
  /** auth.test 失败后，一分钟内不再试（令牌错了时不必每条消息都报一次）。 */
  private identifyAfter = 0
  /** 处理过的 Slack 消息（channel:ts）：Slack 重发与 app_mention / message 双份送达时只处理一次。 */
  private readonly seen = new Set<string>()
  /** 在 Slack 里点按钮答过的提问：重复点击得到的 409 不再改写消息。 */
  private readonly answeredHere = new Set<string>()
  private readonly locks = new Map<string, Promise<void>>()
  private readonly names = new Map<string, { name: string; at: number }>()
  private readonly projects = new Map<string, { project: Project; at: number }>()
  private created = 0

  constructor(api: PluginAPI, options: PluginOptions) {
    this.api = api
    this.options = options
  }

  register(): void {
    const { api } = this
    api.channels.register(CHANNEL, {
      outbound: (event) => this.outbound(event),
      identityInbound: (event) => this.identityInbound(event),
    })
    api.lifecycle.on('start', () => this.connect())
    api.lifecycle.on('stop', () => this.disconnect())
    api.config.onChange(() => this.reconfigure())
  }

  // ---- 连接 ----

  private connect(): void {
    const { api } = this
    const appToken = api.secrets.get('appToken')
    const botToken = api.secrets.get('botToken')
    this.tokens = `${appToken ?? ''}\u0000${botToken ?? ''}`
    if (!botToken) {
      api.log.warn('没有设置 botToken，不连接 Slack')
      return
    }
    const web = createWeb(botToken, api.log, { slackApiUrl: this.options.slackApiUrl, retries: this.options.webRetries, alive: () => this.web === web })
    this.web = web
    void this.identify()
    if (!appToken) {
      api.log.warn('没有设置 appToken：收不到 Slack 里的消息，只能把代管身份的消息贴到 Slack')
      return
    }
    this.link = new SocketLink({
      appToken,
      log: api.log,
      slackApiUrl: this.options.slackApiUrl,
      backoffMs: this.options.backoffMs,
      onEnvelope: (envelope) => this.onEnvelope(envelope),
    })
    this.link.start()
  }

  private async disconnect(): Promise<void> {
    const link = this.link
    this.link = null
    this.web = null
    this.botUserId = null
    this.identifying = null
    this.identifyAfter = 0
    if (link) await link.stop()
  }

  private async reconfigure(): Promise<void> {
    const { api } = this
    if (`${api.secrets.get('appToken') ?? ''}\u0000${api.secrets.get('botToken') ?? ''}` === this.tokens) return
    await this.disconnect()
    this.connect()
  }

  /** bot 自己的用户 id（auth.test）：用来去掉 @bot 的提及、忽略自己发的消息。 */
  private identify(): Promise<void> {
    const web = this.web
    if (!web) return Promise.resolve()
    if (this.botUserId || Date.now() < this.identifyAfter) return Promise.resolve()
    this.identifying ??= web.auth.test().then(
      (r) => {
        if (this.web === web) this.botUserId = typeof r.user_id === 'string' ? r.user_id : null
      },
      (err: unknown) => {
        this.api.log.error(`botToken 不可用（auth.test：${slackErrorCode(err) ?? describe(err)}）`)
        if (this.web !== web) return
        this.identifying = null
        this.identifyAfter = Date.now() + 60_000
      },
    )
    return this.identifying
  }

  private requireWeb(): WebClient {
    if (!this.web) throw new Error('没有设置 botToken，不能往 Slack 发消息')
    return this.web
  }

  // ---- 状态 ----

  /** 同一个 Slack 线程的读改写依次进行。 */
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = prev.then(() => mine)
    this.locks.set(key, tail)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private getLink(ref: ThreadRef): Promise<ThreadLink | null> {
    return this.api.state.get<ThreadLink>(threadKey(ref.channel, ref.threadTs))
  }

  private async saveLink(link: ThreadLink, isNew = false): Promise<void> {
    await this.api.state.set(threadKey(link.channel, link.threadTs), link)
    if (!isNew) return
    await this.api.state.set(refKey(link.threadId), { channel: link.channel, threadTs: link.threadTs } satisfies ThreadRef)
    if (++this.created % 25 === 0) await this.prune()
  }

  private async markPosted(messageId: string, channel: string, ts: string): Promise<void> {
    await this.api.state.set(postedKey(messageId), { channel, ts, at: new Date().toISOString() })
  }

  /** 只留最近 KEEP 个线程与 KEEP 条已贴出的消息。 */
  private async prune(): Promise<void> {
    const { state } = this.api
    const threads = await state.list<ThreadLink>('threads/')
    if (threads.length > KEEP) {
      for (const { key, value } of threads.sort((a, b) => a.value.at.localeCompare(b.value.at)).slice(0, threads.length - KEEP)) {
        await state.delete(key)
        await state.delete(refKey(value.threadId))
      }
    }
    const posted = await state.list<{ at: string }>('posted/')
    if (posted.length > KEEP) {
      for (const { key } of posted.sort((a, b) => a.value.at.localeCompare(b.value.at)).slice(0, posted.length - KEEP)) await state.delete(key)
    }
  }

  /** 记下一条处理过的 Slack 消息；已经记过时返回 false。 */
  private remember(key: string): boolean {
    if (this.seen.has(key)) return false
    bounded(this.seen, key)
    return true
  }

  // ---- 平台接口 ----

  private async project(id: string): Promise<Project> {
    const cached = this.projects.get(id)
    if (cached && Date.now() - cached.at < PROJECT_TTL_MS) return cached.project
    const res = await this.api.platform.fetch(`/projects/${encodeURIComponent(id)}`)
    const body = (await res.json().catch(() => null)) as (Project & { error?: { message?: string } }) | null
    if (!res.ok || !body) throw new Error(`读项目 ${id} 失败（${res.status}${body?.error?.message ? `：${body.error.message}` : ''}）`)
    const project = { id: body.id, name: body.name, managerAgentId: body.managerAgentId ?? null }
    this.projects.set(id, { project, at: Date.now() })
    return project
  }

  /** 绑定了这个频道的项目（只看启用了本插件的项目）。 */
  private projectForChannel(channel: string): string | null {
    const { api } = this
    const hits = api.config.projects().filter((pid) => channelList(api.config.get<Config>(pid).channels).includes(channel))
    if (hits.length > 1) api.log.warn(`Slack 频道 ${channel} 绑定在多个项目里（${hits.join('、')}），按 ${hits[0]} 处理`)
    return hits[0] ?? null
  }

  /** 私信对应的项目：全局配置 dmProject，填项目名或项目 ID。 */
  private async dmProject(): Promise<{ id: string } | { problem: string }> {
    const { api } = this
    const ref = api.config.get<Config>().dmProject?.trim()
    if (!ref) return { problem: '这个 Slack 应用还没有设置私信对应的项目（dmProject），私信不会转给 Manager。' }
    const enabled = api.config.projects()
    if (UUID.test(ref)) return enabled.includes(ref) ? { id: ref } : { problem: `私信对应的项目 ${ref} 没有启用 Slack 插件。` }
    for (const pid of enabled) {
      try {
        if ((await this.project(pid)).name === ref) return { id: pid }
      } catch (err) {
        api.log.warn(describe(err))
      }
    }
    return { problem: `没有找到名为“${ref}”且启用了 Slack 插件的项目。` }
  }

  private answer(link: ThreadLink, questionId: string, input: QuestionAnswer): Promise<InboxMessage> {
    return link.kind === 'identity' ? this.api.identities.answer(link.identityId!, questionId, input) : this.api.channels.answer(CHANNEL, questionId, input)
  }

  // ---- Slack 接口 ----

  private async userName(id: string): Promise<string> {
    const cached = this.names.get(id)
    if (cached && Date.now() - cached.at < NAME_TTL_MS) return cached.name
    let name = id
    try {
      const r = await this.requireWeb().users.info({ user: id })
      const u = r.user
      name = u?.profile?.display_name || u?.profile?.real_name || u?.real_name || u?.name || id
    } catch (err) {
      this.api.log.warn(`读 Slack 用户 ${id} 失败（${slackErrorCode(err) ?? describe(err)}）`)
    }
    this.names.set(id, { name, at: Date.now() })
    return name
  }

  private slackText(text: string): Promise<string> {
    return fromSlack(text, { botUserId: this.botUserId, userName: (id) => this.userName(id) })
  }

  /** 只给这个人看的提示；发不出去时记日志。 */
  private async notice(where: Where, text: string): Promise<void> {
    try {
      await this.requireWeb().chat.postEphemeral({ channel: where.channel, user: where.user, thread_ts: where.threadTs, text })
    } catch (err) {
      this.api.log.warn(`给 Slack 用户 ${where.user} 发提示失败（${slackErrorCode(err) ?? describe(err)}）：${text}`)
    }
  }

  /**
   * 把一段正文贴到 Slack：threadTs 为 null 时开一个新的顶层消息（它就是线程的开头）。很长的正文分几条，提问的按钮在最后一条。
   * 返回线程开头与最后一条的 ts。
   */
  private async post(channel: string, threadTs: string | null, text: string, question: EventQuestion | null, note: string | null) {
    const web = this.requireWeb()
    const parts = chunks(text)
    let root = threadTs
    let last = ''
    let at = channel
    for (const [i, part] of parts.entries()) {
      const isLast = i === parts.length - 1
      const n = i === 0 ? (note ?? undefined) : undefined
      const blocks = isLast && question ? questionBlocks(part, question, n) : messageBlocks(part, n)
      const fallback = isLast && question ? `${fallbackText(part, 200)}（选项：${question.options.map((o) => escapeMrkdwn(o.label)).join(' / ')}）` : fallbackText(part)
      const r = await web.chat.postMessage({ channel: at, text: fallback, blocks, unfurl_links: false, unfurl_media: false, ...(root ? { thread_ts: root } : {}) })
      if (typeof r.ts !== 'string') throw new Error('Slack 没有返回消息的 ts')
      // 发给用户 ID 时 Slack 返回的是私信频道（D…），之后都用它。
      if (typeof r.channel === 'string') at = r.channel
      root ??= r.ts
      last = r.ts
    }
    return { channel: at, rootTs: root!, lastTs: last }
  }

  /** 提问回答后或已关闭：去掉按钮，写上结果。base 为原消息的块（没有时按记下的正文重建）。 */
  private async closeQuestion(channel: string, q: { ts: string; text?: string; note?: string | null }, result: string, base?: Block[]) {
    const blocks = closedBlocks(base ?? messageBlocks(q.text ?? '', q.note ?? undefined), result)
    try {
      await this.requireWeb().chat.update({ channel, ts: q.ts, text: fallbackText(`${q.text ?? ''} ${result}`), blocks })
    } catch (err) {
      this.api.log.warn(`改写 Slack 里的提问失败（${slackErrorCode(err) ?? describe(err)}）`)
    }
  }

  // ---- Slack → 平台 ----

  private onEnvelope(envelope: Envelope): void {
    const run = async () => {
      const body = envelope.body as { event?: unknown; type?: unknown } | null
      if (envelope.type === 'events_api') await this.onMessage(body?.event as SlackMessage | undefined)
      else if (envelope.type === 'interactive') await this.onInteraction(body)
    }
    run().catch((err: unknown) => this.api.log.error(`处理 Slack 消息失败：${describe(err)}`))
  }

  private async onMessage(e: SlackMessage | undefined): Promise<void> {
    if (!e || (e.type !== 'app_mention' && e.type !== 'message')) return
    if (typeof e.channel !== 'string' || typeof e.ts !== 'string' || typeof e.user !== 'string') return
    if (e.bot_id || (e.subtype && e.subtype !== 'file_share' && e.subtype !== 'thread_broadcast')) return
    await this.identify()
    if (e.user === this.botUserId) return
    const isIm = e.channel_type === 'im' || e.channel.startsWith('D')
    // 频道里 @bot 的消息 Slack 会以 app_mention 和 message 各送一次，只按 app_mention 处理。
    if (e.type === 'message' && !isIm && this.botUserId && e.text?.includes(`<@${this.botUserId}`)) return
    const threadTs = e.thread_ts ?? e.ts
    await this.locked(threadKey(e.channel, threadTs), async () => {
      const link = await this.getLink({ channel: e.channel, threadTs })
      // 频道里没有 @bot 的消息只在已对应的线程里才处理；其余忽略，也不记。
      if (!link && e.type === 'message' && !isIm) return
      if (!this.remember(`${e.channel}:${e.ts}`)) return
      const where = { channel: e.channel, user: e.user, threadTs }
      if (link) await this.followUp(link, e, where)
      else await this.startConversation(e, where, isIm)
    })
  }

  /** 新对话：转给项目的 Manager，记下线程与线索的对应。 */
  private async startConversation(e: SlackMessage, where: Where, isIm: boolean): Promise<void> {
    const { api } = this
    let projectId: string
    if (isIm) {
      const dm = await this.dmProject()
      if ('problem' in dm) return this.notice(where, dm.problem)
      projectId = dm.id
    } else {
      const bound = this.projectForChannel(e.channel)
      if (!bound) return // 没绑定项目的频道：忽略
      projectId = bound
    }
    const text = await this.slackText(e.text ?? '')
    if (!text) return
    try {
      const project = await this.project(projectId)
      if (!project.managerAgentId) return this.notice(where, `项目“${project.name}”还没有指定 Manager，消息没有转出。`)
      const name = await this.userName(e.user)
      const msg = await api.channels.send(CHANNEL, { to: project.managerAgentId, text, senderName: `Slack @${name}`.slice(0, 100) })
      await this.saveLink(
        { kind: 'manager', channel: e.channel, threadTs: where.threadTs, threadId: msg.threadId, projectId, identityId: null, lastMessageId: msg.id, startedBy: e.user, question: null, at: new Date().toISOString() },
        true,
      )
    } catch (err) {
      api.log.warn(`转给 Manager 失败：${describe(err)}`)
      await this.notice(where, `没能转给 Manager：${describe(err)}`)
    }
  }

  /** 已对应的线程里的后续消息：有可文字作答的提问时作答，否则作为回复。 */
  private async followUp(link: ThreadLink, e: SlackMessage, where: Where): Promise<void> {
    const text = await this.slackText(e.text ?? '')
    if (!text) return
    const q = link.question && !(link.question.deadline && Date.parse(link.question.deadline) <= Date.now()) ? link.question : null
    if (q && !q.allowText) return this.notice(where, '这道提问需要点上面的按钮选一个选项。')
    try {
      let msg: InboxMessage
      if (q) {
        msg = await this.answer(link, q.id, { text })
      } else if (link.kind === 'identity') {
        msg = await this.api.identities.reply(link.identityId!, link.lastMessageId, { text })
      } else {
        // 线程里换了人说话时注明是谁，Agent 才分得清。
        const who = link.startedBy && e.user !== link.startedBy ? `@${await this.userName(e.user)}：` : ''
        msg = await this.api.channels.reply(link.lastMessageId, { text: who + text })
      }
      link.lastMessageId = msg.id
      if (q) link.question = null
      await this.saveLink(link)
      if (q) await this.closeQuestion(link.channel, q, msg.answerTo ? `已用文字回答（<@${e.user}>）` : '提问已关闭，这条回复作为普通消息送达')
    } catch (err) {
      if (q && statusOf(err) === 409) {
        link.question = null
        await this.saveLink(link)
        const note = closedNote(codeOf(err))
        await this.closeQuestion(link.channel, q, note)
        return this.notice(where, `${note}，这条回复没有送达；再发一次会作为普通回复送出。`)
      }
      this.api.log.warn(`Slack 线程里的回复没有送达：${describe(err)}`)
      await this.notice(where, `没有送达 Loop Now：${describe(err)}`)
    }
  }

  private async onInteraction(p: unknown): Promise<void> {
    const payload = p as {
      type?: string
      user?: { id?: string }
      channel?: { id?: string }
      container?: { channel_id?: string; message_ts?: string; thread_ts?: string }
      message?: { ts?: string; thread_ts?: string; blocks?: Block[] }
      actions?: { action_id?: string; value?: string; text?: { text?: string } }[]
    } | null
    if (payload?.type !== 'block_actions') return
    const user = payload.user?.id
    const channel = payload.channel?.id ?? payload.container?.channel_id
    const ts = payload.message?.ts ?? payload.container?.message_ts
    if (!user || !channel || !ts) return
    const threadTs = payload.message?.thread_ts ?? payload.container?.thread_ts ?? ts
    for (const action of payload.actions ?? []) {
      if (typeof action.action_id !== 'string' || !action.action_id.startsWith(ANSWER_ACTION)) continue
      let v: { q?: unknown; o?: unknown }
      try {
        v = JSON.parse(action.value ?? '')
      } catch {
        continue
      }
      if (typeof v.q !== 'string' || typeof v.o !== 'string') continue
      const choice = { questionId: v.q, optionId: v.o, label: action.text?.text ?? v.o }
      await this.locked(threadKey(channel, threadTs), () => this.choose({ channel, user, threadTs }, ts, payload.message?.blocks, choice))
    }
  }

  /** 点了提问的按钮。 */
  private async choose(where: Where, ts: string, blocks: Block[] | undefined, c: { questionId: string; optionId: string; label: string }): Promise<void> {
    const link = await this.getLink(where)
    if (!link) return this.notice(where, '这道提问已不在 Loop Now 插件的记录里（超过保留的线程数），没有送达。')
    const current = link.question?.id === c.questionId ? link.question : null
    const q = { ts, text: current?.text, note: current?.note }
    const base = current ? undefined : blocks
    try {
      const msg = await this.answer(link, c.questionId, { optionId: c.optionId })
      bounded(this.answeredHere, c.questionId)
      link.lastMessageId = msg.id
      if (current) link.question = null
      await this.saveLink(link)
      await this.closeQuestion(where.channel, q, `<@${where.user}> 选择了「${escapeMrkdwn(msg.answerTo?.optionLabel ?? c.label)}」`, base)
    } catch (err) {
      if (statusOf(err) === 409) {
        if (current) {
          link.question = null
          await this.saveLink(link)
        }
        // 自己刚在这里答过（重复点击）时保留“谁选了什么”。
        if (codeOf(err) === 'already_answered' && this.answeredHere.has(c.questionId)) return
        await this.closeQuestion(where.channel, q, closedNote(codeOf(err)), base)
        return
      }
      this.api.log.warn(`Slack 里的选择没有送达：${describe(err)}`)
      await this.notice(where, `没有送达 Loop Now：${describe(err)}`)
    }
  }

  // ---- 平台 → Slack ----

  /** Agent 在插件发起的线索里回复（可能是提问）：贴回对应的 Slack 线程。 */
  private async outbound(event: PluginEvent<'channel.outbound'>): Promise<void> {
    const ref = await this.api.state.get<ThreadRef>(refKey(event.threadId))
    if (!ref) {
      this.api.log.warn(`Agent 回复了线索 ${event.threadId}，但找不到对应的 Slack 线程（超过保留的 ${KEEP} 个线程，或状态被清除），没有贴出`)
      return
    }
    await this.locked(threadKey(ref.channel, ref.threadTs), async () => {
      if (await this.api.state.get(postedKey(event.messageId))) return // 重复送达
      const link = await this.getLink(ref)
      if (!link) {
        this.api.log.warn(`线索 ${event.threadId} 对应的 Slack 线程记录已删除，回复没有贴出`)
        return
      }
      const full = await this.api.channels.read(event.messageId)
      const posted = await this.post(link.channel, link.threadTs, full.text, event.question, null)
      link.lastMessageId = event.messageId
      if (event.question) link.question = { ...pickQuestion(event.question), ts: posted.lastTs, text: lastChunk(full.text), note: null }
      await this.saveLink(link)
      await this.markPosted(event.messageId, link.channel, posted.lastTs)
    })
  }

  /** 代管的外部身份收到消息或提问：贴到 identityTarget，同一条线索在同一个 Slack 线程里。 */
  private async identityInbound(event: PluginEvent<'identity.inbound'>): Promise<void> {
    const { api } = this
    this.requireWeb()
    const target = api.config.get<Config>().identityTarget?.trim()
    if (!target) throw new Error('没有设置 identityTarget（代管身份的消息贴到哪个 Slack 频道或用户），消息没有贴出')
    if (await api.state.get(postedKey(event.messageId))) return // 重复送达
    const full = await api.identities.read(event.identityId, event.messageId)
    const to = typeof full.to?.name === 'string' ? full.to.name : '外部身份'
    const note = `*${escapeMrkdwn(event.from.name)}* → ${escapeMrkdwn(to)}`
    const ref = await api.state.get<ThreadRef>(refKey(event.threadId))
    if (ref) {
      const done = await this.locked(threadKey(ref.channel, ref.threadTs), async () => {
        const link = await this.getLink(ref)
        if (!link) return false
        const posted = await this.post(link.channel, link.threadTs, full.text, event.question, note)
        link.lastMessageId = event.messageId
        if (event.question) link.question = { ...pickQuestion(event.question), ts: posted.lastTs, text: lastChunk(full.text), note: chunks(full.text).length === 1 ? note : null }
        await this.saveLink(link)
        await this.markPosted(event.messageId, link.channel, posted.lastTs)
        return true
      })
      if (done) return
    }
    const posted = await this.post(target, null, full.text, event.question, note)
    const link: ThreadLink = {
      kind: 'identity',
      channel: posted.channel,
      threadTs: posted.rootTs,
      threadId: event.threadId,
      projectId: event.projectId,
      identityId: event.identityId,
      lastMessageId: event.messageId,
      startedBy: null,
      question: event.question ? { ...pickQuestion(event.question), ts: posted.lastTs, text: lastChunk(full.text), note: chunks(full.text).length === 1 ? note : null } : null,
      at: new Date().toISOString(),
    }
    await this.locked(threadKey(link.channel, link.threadTs), () => this.saveLink(link, true))
    await this.markPosted(event.messageId, link.channel, posted.lastTs)
  }
}

/** 加入集合，超过上限时去掉最早加入的。 */
function bounded(set: Set<string>, value: string): void {
  set.add(value)
  if (set.size > SEEN_MAX) set.delete(set.values().next().value!)
}

function pickQuestion(q: EventQuestion): Pick<OpenQuestion, 'id' | 'options' | 'allowText' | 'deadline'> {
  return { id: q.id, options: q.options.map((o) => ({ id: o.id, label: o.label })), allowText: q.allowText, deadline: q.deadline }
}

/** 提问那条 Slack 消息的正文（长正文分几条时是最后一条）。 */
function lastChunk(text: string): string {
  return chunks(text).at(-1) ?? text
}
