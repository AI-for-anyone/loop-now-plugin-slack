// 两个方向的文字处理与 Block Kit 渲染。
// Slack → 平台：把 Slack 的标记（<@U…>、<#C…|名称>、<链接|文字>、&amp; 等）还原成普通文字与 Markdown。
// 平台 → Slack：Agent 的正文是 Markdown，放进 Slack 的 markdown 块原样显示；提问加按钮。

import type { EventQuestion } from '@loop-now/plugin-sdk'

/** Slack 规定一条消息里 markdown 块合计不超过 12000 字符，留些余量。 */
export const MARKDOWN_LIMIT = 11_000

/** 按钮的 action_id 前缀；value 为 {"q": 提问 id, "o": 选项 id}。 */
export const ANSWER_ACTION = 'loopnow_answer_'
const ACTIONS_BLOCK = 'loopnow_actions'
const HINT_BLOCK = 'loopnow_hint'

export type Block = { type: string; block_id?: string; [key: string]: unknown }

/** mrkdwn 文本里的 &、<、> 须转义，否则可能被当成提及（例如 <!channel>）。 */
export function escapeMrkdwn(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** markdown 块里不解析 Slack 的提及，这里再保险一次：在 <! <@ <# 之间插入零宽空格，显示不变、不会通知人。 */
function defuse(text: string): string {
  return text.replace(/<([!@#])/g, '<​$1')
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

/** 通知与搜索用的纯文字摘要（chat.postMessage 的 text）。 */
export function fallbackText(text: string, max = 300): string {
  return escapeMrkdwn(truncate(text.replace(/\s+/g, ' ').trim(), max)) || ' '
}

/** 把很长的正文切成几段，每段一条消息；尽量在空行、其次在换行处切。 */
export function chunks(text: string, limit = MARKDOWN_LIMIT): string[] {
  const out: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < limit / 2) cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut))
    rest = rest.slice(cut).replace(/^\n+/, '')
  }
  if (rest !== '' || out.length === 0) out.push(rest)
  return out
}

function context(text: string, blockId?: string): Block {
  return { type: 'context', ...(blockId ? { block_id: blockId } : {}), elements: [{ type: 'mrkdwn', text }] }
}

/** Slack 的日期标记：按看的人的时区显示，客户端不支持时显示原文。 */
export function slackDate(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return escapeMrkdwn(iso)
  return `<!date^${Math.floor(t / 1000)}^{date_short_pretty} {time}|${escapeMrkdwn(iso)}>`
}

/** 一段正文：可选的一行说明（mrkdwn，调用方负责转义）加 markdown 块。 */
export function messageBlocks(text: string, note?: string): Block[] {
  const blocks: Block[] = []
  if (note) blocks.push(context(note))
  blocks.push({ type: 'markdown', text: defuse(text) || ' ' })
  return blocks
}

/** 提问：正文、每个选项一个按钮，再加一行提示（能否用文字回答、截止时间）。 */
export function questionBlocks(text: string, question: Pick<EventQuestion, 'id' | 'options' | 'allowText' | 'deadline'>, note?: string): Block[] {
  const blocks = messageBlocks(text, note)
  blocks.push({
    type: 'actions',
    block_id: ACTIONS_BLOCK,
    elements: question.options.slice(0, 25).map((o, i) => ({
      type: 'button',
      action_id: `${ANSWER_ACTION}${i}`,
      text: { type: 'plain_text', text: truncate(o.label, 75) || o.id, emoji: true },
      value: JSON.stringify({ q: question.id, o: o.id }),
    })),
  })
  const hints: string[] = []
  if (question.allowText) hints.push('也可以在这个线程里直接回复文字作答')
  if (question.deadline) hints.push(`截止 ${slackDate(question.deadline)}`)
  if (hints.length > 0) blocks.push(context(hints.join(' · '), HINT_BLOCK))
  return blocks
}

/** 提问回答后（或已关闭）：去掉按钮与提示，换成一行结果。base 为原消息的块。 */
export function closedBlocks(base: Block[], result: string): Block[] {
  return [...base.filter((b) => b.block_id !== ACTIONS_BLOCK && b.block_id !== HINT_BLOCK), context(result)]
}

export interface SlackTextOptions {
  /** bot 自己的用户 id：@bot 的提及从正文里去掉。 */
  botUserId: string | null
  /** 把用户 id 换成显示名称。 */
  userName: (id: string) => Promise<string>
}

/** Slack 消息文字 → 发给 Agent 的文字。 */
export async function fromSlack(text: string, o: SlackTextOptions): Promise<string> {
  let s = text
  if (o.botUserId) s = s.replace(new RegExp(`<@${o.botUserId}(\\|[^>]*)?>`, 'g'), '')
  const ids = new Set<string>()
  for (const m of s.matchAll(/<@([A-Z0-9]+)>/g)) ids.add(m[1]!)
  const names = new Map<string, string>()
  for (const id of ids) names.set(id, await o.userName(id))
  s = s.replace(/<([^<>]+)>/g, (_all, inner: string) => {
    const bar = inner.indexOf('|')
    const head = bar < 0 ? inner : inner.slice(0, bar)
    const label = bar < 0 ? '' : inner.slice(bar + 1)
    if (head.startsWith('@')) return `@${label || names.get(head.slice(1)) || head.slice(1)}`
    if (head.startsWith('#')) return `#${label || head.slice(1)}`
    if (head.startsWith('!')) {
      if (label) return label
      const cmd = head.slice(1)
      return cmd.startsWith('subteam^') ? `@${cmd.slice('subteam^'.length)}` : `@${cmd}`
    }
    if (head.startsWith('mailto:')) return label || head.slice('mailto:'.length)
    return label && label !== head ? `[${label}](${head})` : head
  })
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim()
}
