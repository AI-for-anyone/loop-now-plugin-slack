// 插件的两个方向、提问、身份代管与重连：真的 Slack 客户端库连假的 Slack（fake-slack.ts），平台用假的 PluginAPI（fake-api.ts）。

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import { createPlugin } from '../platform/plugin.ts'
import { FakeApi } from './fake-api.ts'
import { APP_TOKEN, BOT_TOKEN, FakeSlack, type Posted } from './fake-slack.ts'

const P1 = '11111111-1111-4111-8111-111111111111'
const P2 = '22222222-2222-4222-8222-222222222222'
const P3 = '33333333-3333-4333-8333-333333333333'
const MANAGER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const IDENTITY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AGENT = { kind: 'agent' as const, id: MANAGER, address: 'demo/manager' }

async function until(pred: () => boolean, what = '条件', timeoutMs = 5_000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > end) throw new Error(`等待${what}超时`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

/** 给“不该发生”的断言留出处理时间。 */
const settle = () => new Promise((r) => setTimeout(r, 150))

interface Setup {
  slack: FakeSlack
  fake: FakeApi
}

let current: Setup | null = null

async function setup(o: { before?: (slack: FakeSlack, fake: FakeApi) => void; connected?: boolean } = {}): Promise<Setup> {
  const slack = await FakeSlack.start()
  const fake = new FakeApi()
  fake.secrets.appToken = APP_TOKEN
  fake.secrets.botToken = BOT_TOKEN
  fake.projects.set(P1, { id: P1, name: 'demo', managerAgentId: MANAGER, config: { channels: 'C1, C2' } })
  fake.projects.set(P2, { id: P2, name: 'off', managerAgentId: MANAGER, config: { channels: 'C3' } })
  fake.projects.set(P3, { id: P3, name: 'nomgr', managerAgentId: null, config: {} })
  fake.enabled.add(P1)
  fake.enabled.add(P3)
  o.before?.(slack, fake)
  createPlugin({ slackApiUrl: slack.apiUrl, backoffMs: [20, 40, 80], webRetries: 0 })(fake.build())
  await fake.start()
  current = { slack, fake }
  if (o.connected !== false) await until(() => slack.open === 1, 'Socket Mode 连接')
  return current
}

afterEach(async () => {
  if (!current) return
  await current.fake.stop()
  await current.slack.close()
  current = null
})

const lastMessage = (slack: FakeSlack): Posted => slack.messages.at(-1)!

/** 在 C1 里 @bot 开一个对话，返回平台线索与第一条消息。 */
async function startThread(s: Setup, ts = '100.1', text = '<@UBOT> 你好'): Promise<{ threadId: string; messageId: string }> {
  const before = s.fake.callsOf('channels.send').length
  await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'U1', text, ts })
  await until(() => s.fake.state.has(`threads/C1/${ts}`) && s.fake.callsOf('channels.send').length > before, '转给 Manager')
  const link = s.fake.state.get(`threads/C1/${ts}`) as { threadId: string; lastMessageId: string }
  return { threadId: link.threadId, messageId: link.lastMessageId }
}

describe('人 → Manager', () => {
  it('频道里 @bot 转给绑定项目的 Manager；Agent 的回复贴回同一个 Slack 线程；线程里的后续消息回到同一条线索', async () => {
    const s = await setup()
    await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> 帮我看看 <https://x.example|这个链接> &amp; <@U2>', ts: '100.1' })
    await until(() => s.fake.callsOf('channels.send').length === 1, '转给 Manager')
    assert.deepEqual(s.fake.callsOf('channels.send')[0], ['slack', { to: MANAGER, text: '帮我看看 [这个链接](https://x.example) & @Bob', senderName: 'Slack @Alice' }])
    await until(() => s.fake.state.has('threads/C1/100.1'), '记下线程')
    const link = s.fake.state.get('threads/C1/100.1') as { threadId: string; kind: string; projectId: string }
    assert.equal(link.kind, 'manager')
    assert.equal(link.projectId, P1)
    assert.deepEqual(s.fake.state.get(`platform-threads/${link.threadId}`), { channel: 'C1', threadTs: '100.1' })

    // Agent 回复：读全文，贴到线程里。
    s.fake.seed('r1', link.threadId, '**好的**，我来看 <!channel>')
    await s.fake.outbound({ messageId: 'r1', threadId: link.threadId, channelId: 'slack', from: AGENT, isQuestion: false, question: null, excerpt: '好的' })
    const reply = lastMessage(s.slack)
    assert.equal(reply.channel, 'C1')
    assert.equal(reply.thread_ts, '100.1')
    assert.deepEqual(reply.blocks, [{ type: 'markdown', text: '**好的**，我来看 <​!channel>' }], '正文放进 markdown 块，提及不生效')
    assert.equal(reply.text, '**好的**，我来看 &lt;!channel&gt;', '通知用的文字转义')
    assert.deepEqual(s.fake.callsOf('channels.read'), [['r1']])
    // 同一条回复重复送达：不再贴。
    await s.fake.outbound({ messageId: 'r1', threadId: link.threadId, channelId: 'slack', from: AGENT, isQuestion: false, question: null, excerpt: '好的' })
    assert.equal(s.slack.callsTo('chat.postMessage').length, 1)

    // 线程里的后续消息（没有 @bot）：回复线索里最近的消息。
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '谢谢', ts: '100.2', thread_ts: '100.1' })
    await until(() => s.fake.callsOf('channels.reply').length === 1, '线程里的回复')
    assert.deepEqual(s.fake.callsOf('channels.reply')[0], ['r1', { text: '谢谢' }])
    // 换了人说话时注明是谁。
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: '再补充一句', ts: '100.3', thread_ts: '100.1' })
    await until(() => s.fake.callsOf('channels.reply').length === 2, '第二条回复')
    const second = s.fake.callsOf('channels.reply')[1]!
    assert.deepEqual(second[1], { text: '@Bob：再补充一句' })
    assert.notEqual(second[0], 'r1', '回复对象是线索里最新的消息')

    // Slack 重发同一条消息、或在线程里 @bot 时以 message 和 app_mention 各送一次：只处理一次。
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '谢谢', ts: '100.2', thread_ts: '100.1' })
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@UBOT> 还有', ts: '100.4', thread_ts: '100.1' })
    await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> 还有', ts: '100.4', thread_ts: '100.1' })
    await until(() => s.fake.callsOf('channels.reply').length === 3, '@bot 的线程回复')
    await settle()
    assert.equal(s.fake.callsOf('channels.reply').length, 3)
    assert.deepEqual(s.fake.callsOf('channels.reply')[2]![1], { text: '还有' })
    assert.equal(s.fake.callsOf('channels.send').length, 1)
  })

  it('没绑定的频道、线程外的普通消息（人或机器人）、自己的消息、没启用插件的项目一律忽略，也不记状态', async () => {
    const s = await setup()
    await s.slack.event({ type: 'app_mention', channel: 'C9', user: 'U1', text: '<@UBOT> 有人吗', ts: '1.1' })
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '随便聊聊', ts: '1.2' })
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '别的线程', ts: '1.3', thread_ts: '0.9' })
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', bot_id: 'B2', user: 'U5', text: '另一个 bot', ts: '1.4' })
    await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'UBOT', text: '自己', ts: '1.5' })
    await s.slack.event({ type: 'message', subtype: 'message_changed', channel: 'C1', channel_type: 'channel', user: 'U1', text: 'x', ts: '1.6' })
    await s.slack.event({ type: 'app_mention', channel: 'C3', user: 'U1', text: '<@UBOT> 项目没启用', ts: '1.7' })
    await settle()
    assert.deepEqual(s.fake.callsOf('channels.send'), [])
    assert.deepEqual([...s.fake.state.keys()], [])
    assert.deepEqual(s.slack.callsTo('chat.postEphemeral'), [])
    assert.equal(s.slack.acks.length, 7, '每个事件都确认了')
  })

  it('私信转给 dmProject（项目名或 ID）；没设置、找不到或项目没有 Manager 时告诉发消息的人', async () => {
    const s = await setup()
    const dm = (text: string, ts: string) => s.slack.event({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text, ts })
    await dm('你好', '200.1')
    await until(() => s.slack.callsTo('chat.postEphemeral').length === 1, '提示')
    assert.match(String(s.slack.callsTo('chat.postEphemeral')[0]!.params.text), /dmProject/)

    s.fake.config.dmProject = 'demo'
    await dm('按名字', '200.2')
    await until(() => s.fake.callsOf('channels.send').length === 1, '私信转出')
    assert.deepEqual(s.fake.callsOf('channels.send')[0], ['slack', { to: MANAGER, text: '按名字', senderName: 'Slack @Alice' }])
    assert.ok(s.fake.state.has('threads/D1/200.2'))

    s.fake.config.dmProject = P1
    await dm('按 ID', '200.3')
    await until(() => s.fake.callsOf('channels.send').length === 2, '按 ID 转出')

    s.fake.config.dmProject = 'off'
    await dm('项目没启用', '200.4')
    await until(() => s.slack.callsTo('chat.postEphemeral').length === 2, '找不到项目的提示')
    assert.match(String(s.slack.callsTo('chat.postEphemeral')[1]!.params.text), /没有找到名为“off”/)

    s.fake.config.dmProject = 'nomgr'
    await dm('没有 Manager', '200.5')
    await until(() => s.slack.callsTo('chat.postEphemeral').length === 3, '没有 Manager 的提示')
    assert.match(String(s.slack.callsTo('chat.postEphemeral')[2]!.params.text), /还没有指定 Manager/)
    assert.equal(s.fake.callsOf('channels.send').length, 2)
  })

  it('转给 Manager 失败时提示发消息的人', async () => {
    const s = await setup()
    s.fake.failNext.set('channels.send', new Error('平台返回 403：forbidden'))
    await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> 你好', ts: '5.1' })
    await until(() => s.slack.callsTo('chat.postEphemeral').length === 1, '失败提示')
    const notice = s.slack.callsTo('chat.postEphemeral')[0]!.params
    assert.equal(notice.user, 'U1')
    assert.equal(notice.thread_ts, '5.1')
    assert.match(String(notice.text), /没能转给 Manager：平台返回 403/)
    assert.equal(s.fake.state.has('threads/C1/5.1'), false)
  })
})

describe('Agent 的提问', () => {
  const ask = (s: Setup, threadId: string, id: string, q: { allowText: boolean; deadline?: string | null }) => {
    s.fake.seed(id, threadId, `要不要发布 ${id}？`)
    return s.fake.outbound({
      messageId: id,
      threadId,
      channelId: 'slack',
      from: AGENT,
      isQuestion: true,
      question: { id, options: [{ id: '1', label: '发布' }, { id: '2', label: '不发' }], allowText: q.allowText, deadline: q.deadline ?? null },
      excerpt: '要不要发布？',
    })
  }

  it('提问贴成按钮；点按钮用 api.channels.answer 作答，消息改成谁选了什么；只能选项作答时文字不转出', async () => {
    const s = await setup()
    const { threadId } = await startThread(s)
    await ask(s, threadId, 'q1', { allowText: false, deadline: '2026-11-01T00:00:00Z' })
    const question = lastMessage(s.slack)
    assert.equal(question.thread_ts, '100.1')
    const actions = question.blocks!.find((b) => b.type === 'actions')!
    assert.deepEqual(
      (actions.elements as { text: { text: string }; value: string }[]).map((e) => [e.text.text, JSON.parse(e.value)]),
      [['发布', { q: 'q1', o: '1' }], ['不发', { q: 'q1', o: '2' }]],
    )
    const hint = question.blocks!.at(-1) as { elements: { text: string }[] }
    assert.match(hint.elements[0]!.text, /^截止 <!date\^1793491200\^/)
    assert.match(String(question.text), /选项：发布 \/ 不发/)

    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '我想想', ts: '100.2', thread_ts: '100.1' })
    await until(() => s.slack.callsTo('chat.postEphemeral').length === 1, '要点按钮的提示')
    assert.match(String(s.slack.callsTo('chat.postEphemeral')[0]!.params.text), /点上面的按钮/)
    assert.deepEqual(s.fake.callsOf('channels.reply'), [])

    await s.slack.click({ user: 'U2', channel: 'C1', message: question, actionIndex: 1 })
    await until(() => s.slack.callsTo('chat.update').length === 1, '改写提问')
    assert.deepEqual(s.fake.callsOf('channels.answer'), [['slack', 'q1', { optionId: '2' }]])
    const update = s.slack.callsTo('chat.update')[0]!.params as { ts: string; blocks: { type: string; text?: string; elements?: { text: string }[] }[] }
    assert.equal(update.ts, question.ts)
    assert.equal(update.blocks.some((b) => b.type === 'actions'), false, '按钮去掉了')
    assert.equal(update.blocks[0]!.text, '要不要发布 q1？')
    assert.equal(update.blocks.at(-1)!.elements![0]!.text, '<@U2> 选择了「选项2」')

    // 重复点击：平台回 409 already_answered，保留“谁选了什么”。
    s.fake.closed.set('q1', 'already_answered')
    await s.slack.click({ user: 'U1', channel: 'C1', message: question, actionIndex: 0 })
    await until(() => s.fake.callsOf('channels.answer').length === 2, '第二次点击')
    await settle()
    assert.equal(s.slack.callsTo('chat.update').length, 1)

    // 答完以后线程里的文字是普通回复。
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '好了', ts: '100.3', thread_ts: '100.1' })
    await until(() => s.fake.callsOf('channels.reply').length === 1, '普通回复')
  })

  it('允许文字作答时线程里的下一条回复就是答案；提问已关闭时改写消息并告诉人没有送达', async () => {
    const s = await setup()
    const { threadId } = await startThread(s)
    await ask(s, threadId, 'q2', { allowText: true })
    const q2 = lastMessage(s.slack)
    assert.match((q2.blocks!.at(-1) as { elements: { text: string }[] }).elements[0]!.text, /直接回复文字作答/)
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '下周再发', ts: '100.2', thread_ts: '100.1' })
    await until(() => s.slack.callsTo('chat.update').length === 1, '文字作答')
    assert.deepEqual(s.fake.callsOf('channels.answer'), [['slack', 'q2', { text: '下周再发' }]])
    assert.equal((s.slack.callsTo('chat.update')[0]!.params.blocks as { elements?: { text: string }[] }[]).at(-1)!.elements![0]!.text, '已用文字回答（<@U1>）')

    await ask(s, threadId, 'q3', { allowText: true })
    s.fake.closed.set('q3', 'question_expired')
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '发吧', ts: '100.3', thread_ts: '100.1' })
    await until(() => s.slack.callsTo('chat.update').length === 2 && s.slack.callsTo('chat.postEphemeral').length === 1, '关闭的提问')
    assert.equal((s.slack.callsTo('chat.update')[1]!.params.blocks as { elements?: { text: string }[] }[]).at(-1)!.elements![0]!.text, '这道提问已过期')
    assert.match(String(s.slack.callsTo('chat.postEphemeral')[0]!.params.text), /已过期，这条回复没有送达/)
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '那就发吧', ts: '100.4', thread_ts: '100.1' })
    await until(() => s.fake.callsOf('channels.reply').length === 1, '之后作为普通回复')
    assert.deepEqual(s.fake.callsOf('channels.reply')[0], ['q3', { text: '那就发吧' }])
  })

  it('过了截止时间的提问不再拦文字：作为普通回复送出', async () => {
    const s = await setup()
    const { threadId } = await startThread(s)
    await ask(s, threadId, 'q4', { allowText: false, deadline: '2020-01-01T00:00:00Z' })
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '晚了', ts: '100.2', thread_ts: '100.1' })
    await until(() => s.fake.callsOf('channels.reply').length === 1, '普通回复')
    assert.deepEqual(s.slack.callsTo('chat.postEphemeral'), [])
  })
})

describe('别的机器人', () => {
  /** B2：有 bot 用户 U5、app A2 的机器人，在 C1 里说话。 */
  const bot = (o: Record<string, unknown>) => ({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U5', bot_id: 'B2', app_id: 'A2', ...o })
  /** B3：旧式集成（subtype bot_message，没有 bot 用户），bots.info 里是 app A3。 */
  const legacy = (o: Record<string, unknown>) => ({ type: 'message', subtype: 'bot_message', channel: 'C1', channel_type: 'channel', bot_id: 'B3', username: 'hook', ...o })
  const replies = (s: Setup) => s.fake.callsOf('channels.reply').map((c) => (c[1] as { text: string }).text)

  it('别的机器人 @bot 按人转给 Manager，发件人注明是机器人；已对应线程里机器人的消息照常转发', async () => {
    const s = await setup()
    await s.slack.event(bot({ type: 'app_mention', channel_type: undefined, text: '<@UBOT> 部署失败了', ts: '600.1' }))
    await until(() => s.fake.state.has('threads/C1/600.1'), '转给 Manager')
    assert.deepEqual(s.fake.callsOf('channels.send'), [['slack', { to: MANAGER, text: '部署失败了', senderName: '机器人 Slack @Deploy Bot' }]])
    assert.equal((s.fake.state.get('threads/C1/600.1') as { botMessages: number }).botMessages, 1)
    assert.deepEqual(s.slack.callsTo('bots.info').map((c) => c.params.bot), ['B2'])

    // 同一个机器人在线程里接着说不加前缀；人插话时注明是谁。
    await s.slack.event(bot({ text: '日志在这里', ts: '600.2', thread_ts: '600.1' }))
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '我来看', ts: '600.3', thread_ts: '600.1' })
    await until(() => replies(s).length === 2, '线程里的回复')
    assert.deepEqual(replies(s), ['日志在这里', '@Alice：我来看'])

    // 人开的线程里：旧式集成说话，名字取 bots.info；bots.info 和 users.info 都读不到的机器人用 bot_id。
    const { messageId } = await startThread(s, '601.1')
    await s.slack.event(legacy({ text: '构建 #42 通过', ts: '601.2', thread_ts: '601.1' }))
    await s.slack.event(bot({ user: 'U9', bot_id: 'B9', app_id: 'A9', text: '我是谁', ts: '601.3', thread_ts: '601.1' }))
    await until(() => replies(s).length === 4, '机器人在人开的线程里')
    assert.deepEqual(s.fake.callsOf('channels.reply')[2], [messageId, { text: '机器人 @Webhook：构建 #42 通过' }])
    assert.equal(replies(s)[3], '机器人 @B9：我是谁')

    // 线程外不 @bot 的机器人消息照旧忽略。
    await s.slack.event(bot({ text: '例行播报', ts: '602.1' }))
    await settle()
    assert.equal(s.fake.callsOf('channels.send').length, 2)
    assert.equal(s.fake.state.has('threads/C1/602.1'), false)
  })

  it('自己 bot 的消息永远不处理', async () => {
    const s = await setup()
    await startThread(s, '610.1')
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'UBOT', bot_id: 'BBOT', app_id: 'ABOT', text: 'Agent 的回复', ts: '610.2', thread_ts: '610.1' })
    await s.slack.event(legacy({ bot_id: 'BBOT', text: '旧式', ts: '610.3', thread_ts: '610.1' }))
    await s.slack.event(bot({ user: undefined, bot_id: 'BX', app_id: 'ABOT', text: '同一个 app', ts: '610.4', thread_ts: '610.1' }))
    await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'UBOT', bot_id: 'BBOT', app_id: 'ABOT', text: '<@UBOT> 自己', ts: '610.5' })
    await s.slack.event({ type: 'message', channel: 'D1', channel_type: 'im', user: 'UBOT', bot_id: 'BBOT', app_id: 'ABOT', text: '私信里的自己', ts: '610.6' })
    await settle()
    assert.deepEqual(s.fake.callsOf('channels.reply'), [])
    assert.equal(s.fake.callsOf('channels.send').length, 1)
    assert.deepEqual(s.slack.callsTo('bots.info'), [])
  })

  it('auth.test 失败、分不出自己的消息时机器人的消息一律不处理，人的照常', async () => {
    const s = await setup({ before: (slack) => (slack.authFails = true) })
    await s.slack.event(bot({ type: 'app_mention', channel_type: undefined, text: '<@UBOT> 你好', ts: '620.1' }))
    await s.slack.event({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@UBOT> 你好', ts: '620.2' })
    await until(() => s.fake.callsOf('channels.send').length === 1, '人的消息')
    await settle()
    assert.equal(s.fake.callsOf('channels.send').length, 1)
    assert.equal((s.fake.callsOf('channels.send')[0]![1] as { senderName: string }).senderName, 'Slack @Alice')
    assert.equal(s.fake.state.has('threads/C1/620.1'), false)
  })

  it('同一条线索里机器人的消息到上限后不再转发，在线程里提示一次；人的消息不受限', async () => {
    const s = await setup()
    s.fake.config.botMessageLimit = 3
    await s.slack.event(bot({ type: 'app_mention', channel_type: undefined, text: '<@UBOT> 1', ts: '630.1' }))
    await until(() => s.fake.state.has('threads/C1/630.1'), '机器人开的线程')
    for (const n of [2, 3, 4, 5]) await s.slack.event(bot({ text: `${n}`, ts: `630.${n}`, thread_ts: '630.1' }))
    await until(() => s.slack.callsTo('chat.postMessage').length === 1, '到上限的提示')
    await settle()
    assert.deepEqual(replies(s), ['2', '3'])
    const notice = s.slack.callsTo('chat.postMessage')
    assert.equal(notice.length, 1, '只提示一次')
    assert.equal(notice[0]!.params.channel, 'C1')
    assert.equal(notice[0]!.params.thread_ts, '630.1')
    assert.match(String(notice[0]!.params.text), /机器人消息到了上限（3 条）/)
    assert.ok(s.fake.hasLog('info', /到了上限（3 条），之后不再转发/))

    // 人的消息照常转发；别的机器人也算在这条线索的上限里。
    await s.slack.event({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '人', ts: '630.6', thread_ts: '630.1' })
    await s.slack.event(legacy({ text: '另一个机器人', ts: '630.7', thread_ts: '630.1' }))
    await until(() => replies(s).length === 3, '人的消息')
    await settle()
    assert.deepEqual(replies(s), ['2', '3', '@Alice：人'])
    assert.equal(s.slack.callsTo('chat.postMessage').length, 1)
    assert.deepEqual(
      [(s.fake.state.get('threads/C1/630.1') as { botMessages: number }).botMessages, (s.fake.state.get('threads/C1/630.1') as { botLimitNoticed: boolean }).botLimitNoticed],
      [3, true],
    )
  })

  it('allowedBots 非空时只转发列表里的机器人（bot 用户 ID 或 app ID），不在列表里的不提示', async () => {
    const s = await setup()
    s.fake.config.allowedBots = 'A2'
    await s.slack.event(bot({ type: 'app_mention', channel_type: undefined, text: '<@UBOT> 列表里的', ts: '640.1' }))
    await s.slack.event({ type: 'app_mention', channel: 'C1', bot_id: 'B3', text: '<@UBOT> 不在列表里', ts: '640.2' })
    await until(() => s.fake.state.has('threads/C1/640.1'), '列表里的机器人')
    await s.slack.event(legacy({ text: '插话', ts: '640.3', thread_ts: '640.1' }))
    await settle()
    assert.equal(s.fake.callsOf('channels.send').length, 1)
    assert.equal(s.fake.state.has('threads/C1/640.2'), false)
    assert.deepEqual(s.fake.callsOf('channels.reply'), [])

    // 按 bot 用户 ID（事件里有）与 app ID（事件里没有时取 bots.info）都认。
    s.fake.config.allowedBots = 'U5, A3'
    await s.slack.event(legacy({ text: '再插话', ts: '640.4', thread_ts: '640.1' }))
    await s.slack.event(bot({ text: '接着说', ts: '640.5', thread_ts: '640.1' }))
    await until(() => replies(s).length === 2, '列表里的机器人')
    assert.deepEqual(replies(s), ['机器人 @Webhook：再插话', '接着说'])
    assert.deepEqual(s.slack.callsTo('chat.postEphemeral'), [])
  })
})

describe('代管外部身份', () => {
  const inbound = (s: Setup, messageId: string, threadId: string, question: { id: string; allowText: boolean } | null = null) => {
    s.fake.seed(messageId, threadId, `消息 ${messageId}`)
    return s.fake.identityInbound({
      identityId: IDENTITY,
      channelId: 'slack',
      messageId,
      threadId,
      from: { kind: 'agent', agentId: MANAGER, name: 'manager' },
      nodeRunId: null,
      isQuestion: question !== null,
      question: question ? { id: question.id, options: [{ id: '1', label: '同意' }, { id: '2', label: '拒绝' }], allowText: question.allowText, deadline: null } : null,
      excerpt: '',
      projectId: P1,
    })
  }

  it('贴到 identityTarget，一条线索一个 Slack 线程；线程里的回复与按钮以该身份送回', async () => {
    const s = await setup()
    s.fake.config.identityTarget = 'U7'
    await inbound(s, 'i1', 'T-ID')
    const root = lastMessage(s.slack)
    assert.equal(root.channel, 'D7', '发给用户 ID 时落在与 bot 的私信里')
    assert.equal(root.thread_ts, undefined)
    assert.deepEqual(root.blocks![0], { type: 'context', elements: [{ type: 'mrkdwn', text: '*manager* → ops' }] })
    assert.deepEqual(root.blocks![1], { type: 'markdown', text: '消息 i1' })
    assert.deepEqual(s.fake.callsOf('identities.read'), [[IDENTITY, 'i1']])
    assert.deepEqual(s.fake.state.get('platform-threads/T-ID'), { channel: 'D7', threadTs: root.ts })

    // 同一条线索的下一条：同一个线程；重复送达不再贴。
    await inbound(s, 'i2', 'T-ID')
    assert.equal(lastMessage(s.slack).thread_ts, root.ts)
    await inbound(s, 'i2', 'T-ID')
    assert.equal(s.slack.callsTo('chat.postMessage').length, 2)

    // 线程里的回复：以身份回复线索里最近的一条。
    await s.slack.event({ type: 'message', channel: 'D7', channel_type: 'im', user: 'U7', text: '收到', ts: '300.1', thread_ts: root.ts })
    await until(() => s.fake.callsOf('identities.reply').length === 1, '身份回复')
    assert.deepEqual(s.fake.callsOf('identities.reply')[0], [IDENTITY, 'i2', { text: '收到' }])

    // 提问：按钮以身份作答。
    await inbound(s, 'i3', 'T-ID', { id: 'i3', allowText: true })
    const question = lastMessage(s.slack)
    await s.slack.click({ user: 'U7', channel: 'D7', message: question, actionIndex: 0 })
    await until(() => s.slack.callsTo('chat.update').length === 1, '身份作答')
    assert.deepEqual(s.fake.callsOf('identities.answer'), [[IDENTITY, 'i3', { optionId: '1' }]])
    const blocks = s.slack.callsTo('chat.update')[0]!.params.blocks as { type: string; elements?: { text: string }[] }[]
    assert.equal(blocks[0]!.elements![0]!.text, '*manager* → ops', '保留原来的说明行')
    assert.equal(blocks.at(-1)!.elements![0]!.text, '<@U7> 选择了「选项1」')

    // 另一条线索：新的 Slack 线程。
    await inbound(s, 'i4', 'T-OTHER')
    assert.equal(lastMessage(s.slack).thread_ts, undefined)
    assert.deepEqual(s.fake.callsOf('channels.send'), [], '代管方向不经插件发件方')
  })

  it('文字作答走 api.identities.answer；没设置 identityTarget 时抛错让平台重投', async () => {
    const s = await setup()
    await assert.rejects(inbound(s, 'i1', 'T-ID'), /identityTarget/)
    s.fake.config.identityTarget = 'C5'
    await inbound(s, 'i1', 'T-ID', { id: 'i1', allowText: true })
    const root = lastMessage(s.slack)
    assert.equal(root.channel, 'C5')
    await s.slack.event({ type: 'message', channel: 'C5', channel_type: 'channel', user: 'U1', text: '同意，但要先测试', ts: '400.1', thread_ts: root.ts })
    await until(() => s.fake.callsOf('identities.answer').length === 1, '文字作答')
    assert.deepEqual(s.fake.callsOf('identities.answer')[0], [IDENTITY, 'i1', { text: '同意，但要先测试' }])
  })

  it('没有 botToken 时代管消息抛错', async () => {
    const s = await setup({ connected: false, before: (_slack, fake) => delete fake.secrets.botToken })
    s.fake.config.identityTarget = 'C5'
    await assert.rejects(inbound(s, 'i1', 'T-ID'), /botToken/)
    assert.ok(s.fake.hasLog('warn', /没有设置 botToken/))
  })
})

describe('连接', () => {
  it('Slack 回收连接或网络断开后按退避重连，之后的消息照常处理', async () => {
    const s = await setup()
    s.slack.recycle()
    await until(() => s.slack.connections === 2 && s.slack.open === 1, '回收后重连')
    s.slack.drop()
    await until(() => s.slack.connections === 3 && s.slack.open === 1, '断线后重连')
    await startThread(s, '7.1')
    assert.ok(s.fake.hasLog('info', /Slack 连接断开，20 毫秒后重连/))
  })

  it('取连接地址失败时按退避重试；令牌无效时停下，改了配置再连', async () => {
    const s = await setup({ before: (slack) => slack.openReplies.push({ status: 500, body: 'oops' }, { ok: false, error: 'internal_error' }) })
    assert.equal(s.slack.callsTo('apps.connections.open').length, 3)
    assert.ok(s.fake.hasLog('warn', /连不上 Slack（internal_error），40 毫秒后重连（第 2 次）/))
    // 服务端看到连接时客户端还没收到 hello，“已重新连上”稍后才记。
    await until(() => s.fake.hasLog('info', /已重新连上 Slack（之前失败 2 次）/), '重新连上的日志')

    s.fake.secrets.appToken = 'xapp-wrong'
    await s.fake.changeConfig()
    await until(() => s.fake.hasLog('error', /Slack 拒绝了 App-Level Token（invalid_auth）/), '令牌无效的错误')
    const tries = s.slack.callsTo('apps.connections.open').length
    await settle()
    assert.equal(s.slack.callsTo('apps.connections.open').length, tries, '不再重试')
    assert.equal(s.slack.open, 0)

    s.fake.secrets.appToken = APP_TOKEN
    await s.fake.changeConfig()
    await until(() => s.slack.open === 1, '改好令牌后连上')
    // 配置变了但令牌没变：不重连。
    const connections = s.slack.connections
    s.fake.config.dmProject = 'demo'
    await s.fake.changeConfig()
    await settle()
    assert.equal(s.slack.connections, connections)
  })

  it('停用时断开且不再重连', async () => {
    const s = await setup()
    await s.fake.stop()
    await until(() => s.slack.open === 0, '断开')
    await settle()
    assert.equal(s.slack.connections, 1)
    assert.ok(!s.fake.logs.some((l) => /重连/.test(l.text)))
  })
})
