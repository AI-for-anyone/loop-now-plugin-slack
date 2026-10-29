import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import register from '../platform/index.ts'
import { chunks, closedBlocks, escapeMrkdwn, fallbackText, fromSlack, messageBlocks, questionBlocks, slackDate } from '../platform/format.ts'
import { DEFAULT_BOT_LIMIT, idList } from '../platform/plugin.ts'

describe('Slack → 平台的文字', () => {
  const o = { botUserId: 'UBOT', userName: async (id: string) => ({ U1: 'Alice', U2: 'Bob' })[id] ?? id }

  it('去掉 @bot，提及、频道、链接、特殊提及与转义还原成普通文字', async () => {
    assert.equal(await fromSlack('<@UBOT> 你好', o), '你好')
    assert.equal(await fromSlack('<@UBOT|loop> 你好 <@U1> 和 <@U2|bobby>', o), '你好 @Alice 和 @bobby')
    assert.equal(await fromSlack('看 <#C123|general> 与 <#C456>', o), '看 #general 与 #C456')
    assert.equal(await fromSlack('<https://a.example/x?y=1&amp;z=2|文档> 和 <https://b.example>', o), '[文档](https://a.example/x?y=1&z=2) 和 https://b.example')
    assert.equal(await fromSlack('<mailto:a@b.example|a@b.example>', o), 'a@b.example')
    assert.equal(await fromSlack('<!here> <!channel> <!subteam^S1|@devs> <!date^1700000000^{date}|2023-11-14>', o), '@here @channel @devs 2023-11-14')
    assert.equal(await fromSlack('a &lt; b &amp;&amp; c &gt; d', o), 'a < b && c > d')
    assert.equal(await fromSlack('<@U9>', o), '@U9', '查不到名字时用 id')
    assert.equal(await fromSlack('  <@UBOT>  ', o), '')
  })
})

describe('平台 → Slack 的消息', () => {
  it('正文放进 markdown 块，Slack 的提及写法不生效；通知文字转义并截短', () => {
    assert.deepEqual(messageBlocks('# 标题\n<!channel> <@U1>'), [{ type: 'markdown', text: '# 标题\n<​!channel> <​@U1>' }])
    assert.deepEqual(messageBlocks('x', '*a* → b')[0], { type: 'context', elements: [{ type: 'mrkdwn', text: '*a* → b' }] })
    assert.equal(escapeMrkdwn('<!channel> & <@U1>'), '&lt;!channel&gt; &amp; &lt;@U1&gt;')
    assert.equal(fallbackText(`${'很长'.repeat(200)}`, 10), '很长很长很长很长很…')
    assert.equal(fallbackText('  多个\n\n空白  '), '多个 空白')
  })

  it('长正文在空行处切成几段，每段不超过上限', () => {
    const para = 'a'.repeat(60)
    const text = Array.from({ length: 5 }, () => para).join('\n\n')
    const parts = chunks(text, 130)
    assert.deepEqual(parts.map((p) => p.length), [122, 122, 60])
    assert.equal(parts.join('\n\n'), text)
    assert.deepEqual(chunks('短'), ['短'])
    assert.deepEqual(chunks(''), [''])
    assert.deepEqual(chunks('x'.repeat(25), 10), ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)], '没有换行时硬切')
  })

  it('提问：每个选项一个按钮，提示能否文字作答与截止时间；回答后去掉按钮', () => {
    const blocks = questionBlocks('发吗？', { id: 'q1', options: [{ id: '1', label: '发布' }, { id: '2', label: 'x'.repeat(100) }], allowText: true, deadline: '2026-11-01T08:00:00Z' })
    assert.equal(blocks.length, 3)
    const actions = blocks[1] as unknown as { block_id: string; elements: { action_id: string; value: string; text: { text: string } }[] }
    assert.deepEqual(actions.elements.map((e) => e.action_id), ['loopnow_answer_0', 'loopnow_answer_1'])
    assert.deepEqual(JSON.parse(actions.elements[1]!.value), { q: 'q1', o: '2' })
    assert.equal(actions.elements[1]!.text.text.length, 75)
    const hint = blocks[2] as unknown as { elements: { text: string }[] }
    assert.equal(hint.elements[0]!.text, `也可以在这个线程里直接回复文字作答 · 截止 ${slackDate('2026-11-01T08:00:00Z')}`)
    assert.equal(slackDate('2026-11-01T08:00:00Z'), '<!date^1793520000^{date_short_pretty} {time}|2026-11-01T08:00:00Z>')
    const closed = closedBlocks(blocks, '已回答')
    assert.deepEqual(closed, [blocks[0], { type: 'context', elements: [{ type: 'mrkdwn', text: '已回答' }] }])
    assert.equal(questionBlocks('?', { id: 'q', options: [{ id: '1', label: 'a' }], allowText: false, deadline: null }).length, 2, '没有提示时不加提示行')
  })
})

describe('配置', () => {
  it('频道与机器人的 ID 列表接受逗号、空白分隔的字符串或数组', () => {
    assert.deepEqual(idList('C1, C2，C3\nG4  '), ['C1', 'C2', 'C3', 'G4'])
    assert.deepEqual(idList(['C1', ' C2 ', 3]), ['C1', 'C2'])
    assert.deepEqual(idList(undefined), [])
    assert.deepEqual(idList(''), [])
  })

  it('入口默认导出 register', () => {
    assert.equal(typeof register, 'function')
  })
})

describe('清单', () => {
  it('Slack 应用清单打开 Socket Mode 与交互，订阅插件处理的事件；插件清单声明用到的权限与可代管的渠道', async () => {
    const { readFile } = await import('node:fs/promises')
    const slack = JSON.parse(await readFile(new URL('../slack-app-manifest.json', import.meta.url), 'utf8'))
    assert.equal(slack.settings.socket_mode_enabled, true)
    assert.equal(slack.settings.interactivity.is_enabled, true)
    assert.equal(slack.features.app_home.messages_tab_enabled, true)
    assert.deepEqual(slack.settings.event_subscriptions.bot_events, ['app_mention', 'message.im', 'message.channels', 'message.groups'])
    assert.deepEqual(slack.oauth_config.scopes.bot, ['app_mentions:read', 'chat:write', 'im:history', 'im:read', 'im:write', 'channels:history', 'groups:history', 'channels:read', 'users:read'])
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    assert.equal(pkg.loopNow.id, 'slack')
    assert.deepEqual(pkg.loopNow.permissions, ['inbox.send', 'inbox.read', 'agents.read', 'identities.manage', 'state'])
    assert.deepEqual(pkg.loopNow.channels, [{ id: 'slack', label: 'Slack', manageIdentities: true }])
    const props = pkg.loopNow.configSchema.properties
    assert.deepEqual(Object.keys(props), ['appToken', 'botToken', 'dmProject', 'identityTarget', 'allowedBots', 'botMessageLimit', 'channels'])
    assert.equal(props.botMessageLimit.default, DEFAULT_BOT_LIMIT)
    assert.equal(props.appToken['x-secret'], true)
    assert.equal(props.botToken['x-secret'], true)
    assert.equal(props.channels['x-scope'], 'project')
    assert.equal(pkg.peerDependencies['@loop-now/plugin-sdk'], '*')
  })
})
