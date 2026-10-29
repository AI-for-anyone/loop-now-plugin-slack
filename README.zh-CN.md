# Loop Now Slack 插件

[English](README.md)

一个 [Loop Now](https://github.com/AI-for-anyone/loop-now) 插件，把 Slack 工作区双向接进来：

- **人 → Manager**：在绑定了项目的 Slack 频道里 @bot，或给 bot 发私信，消息转给该项目的 Manager；Manager 的回复贴回同一个 Slack 线程，它的提问做成按钮。
- **Agent → 人**：把一个外部身份交给本插件代管后，Agent 发给这个身份的消息和提问贴到 Slack，每条线索一个 Slack 线程；线程里的回复和按钮以该身份的名义送回 Loop Now，效果与这个人在控制台里回复相同，等待中的任务随之继续。

插件用 [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode) 连接 Slack，Loop Now 不需要公网地址。它只有平台半边（没有 Agent 半边），由 Loop Now 的插件宿主直接加载 `platform/index.ts`，不需要构建。

## 需要

- 插件宿主提供 `api.channels.answer` 与 `api.config.projects()` 的 Loop Now；更旧的宿主会拒绝加载并说明原因。
- 一个你能创建应用的 Slack 工作区。

## 1. 建 Slack 应用

1. 打开 <https://api.slack.com/apps>，选 **Create New App › From a manifest**，选工作区。
2. 在 JSON 页签里粘贴 [`slack-app-manifest.json`](slack-app-manifest.json) 的内容，**Create**。
3. **Install to Workspace**，同意申请的权限。

这份清单打开了 Socket Mode、交互（回答按钮要用）、App Home 的消息页签（人才能给 bot 发私信），订阅 bot 事件 `app_mention`、`message.im`、`message.channels`、`message.groups`，申请 bot 权限 `app_mentions:read`、`chat:write`、`im:history`、`im:read`、`im:write`、`channels:history`、`groups:history`、`channels:read`、`users:read`。

## 2. 拿两个令牌

- **App-Level Token**（`xapp-…`）：**Basic Information › App-Level Tokens › Generate Token and Scopes**，加上 `connections:write` 范围后生成。Socket Mode 用它接收事件。
- **Bot Token**（`xoxb-…`）：**OAuth & Permissions › Bot User OAuth Token**。用来发消息、改消息。

## 3. 在 Loop Now 里安装

控制台：**插件 › 安装插件 › 来源选 git 仓库**，仓库地址填 `https://github.com/AI-for-anyone/loop-now-plugin-slack.git`，可选填分支、标签或提交。或者用命令行：

```sh
loopctl plugin install https://github.com/AI-for-anyone/loop-now-plugin-slack.git@main --force
```

`--force` 确认安装非官方来源。Loop Now 在安装目录里执行 `npm ci --ignore-scripts --omit=dev`；依赖（`@slack/socket-mode`、`@slack/web-api`、`undici`）在 `package-lock.json` 里固定了版本。

安装前控制台会列出插件要的东西：权限 `inbox.send`、`inbox.read`、`agents.read`、`identities.manage`、`state`，以及一个可代管外部身份的渠道 **Slack**。

## 4. 配置

在插件详情页的 **配置**：

| 字段 | 说明 |
|---|---|
| `appToken` | App-Level Token（`xapp-…`）。只写不回显，不进日志。 |
| `botToken` | Bot Token（`xoxb-…`）。同上。 |
| `dmProject` | 给 bot 发的私信转给哪个项目：填项目名（或项目 ID）。留空则不接受私信，并告诉发消息的人。该项目须启用了本插件。 |
| `identityTarget` | 代管的外部身份收到的消息贴到哪里：Slack 频道 ID（`C…`／`G…`，在频道详情最下方），或用户 ID（`U…`，个人资料里“复制成员 ID”，消息发到此人与 bot 的私信里）。 |
| `allowedBots` | 只转发这些机器人的消息：bot 用户 ID（`U…`，机器人资料里“复制成员 ID”）或 app ID（`A…`），多个用逗号分隔。留空（默认）则所有机器人的消息都转发。见下面的“别的机器人”。 |
| `botMessageLimit` | 同一个 Slack 线程里最多转发多少条机器人的消息，默认 20。到上限后机器人的消息不再转发，线程里提示一次；人的消息不计入。 |

改了令牌后插件会自己重新连接。

## 5. 在项目里启用并绑定频道

项目的 **插件** 页：启用 **Slack**，在 `channels` 里填这个项目对应的 Slack 频道 ID，多个用逗号分隔（例如 `C0123ABCD, C0456EFGH`）。然后在 Slack 里把 bot 邀请进这些频道（`/invite @Loop Now`）。

插件服务哪些项目，就看哪些项目启用了它。没有绑定到已启用项目的频道一律忽略；同一个频道绑在两个项目里时按第一个处理，并记一条警告。

## 6. 让插件代管外部身份（可选）

1. 在控制台的 **外部身份** 里建一个身份（如果还没有），例如 `ops`。
2. 在它的页面上，**代管** › **代管的插件渠道** 选 **Slack › Slack**。
3. 确认已经填了 `identityTarget`。

之后 Agent 发给 `@ops` 的消息和提问出现在 Slack 里，而不在这个身份的收件箱里等着。

## 在 Slack 里怎么用

- **找 Manager**：在绑定的频道里发 `@Loop Now 帮我看看昨晚失败的那次运行`。bot 以 **Slack @你的名字** 转给项目的 Manager，回复出现在你这条消息下面的线程里。
- **在线程里接着说**：同一个 Slack 线程里的后续消息（@ 不 @ bot 都行）回到同一个对话。别人加入线程时，消息前面会注明是谁，Agent 才分得清。
- **私信**：直接给 bot 发私信；每条顶层私信开一个与 `dmProject` 的 Manager 的新对话，回复在它下面的线程里。
- **提问**：Agent 提问时，消息下面每个选项一个按钮，点一下就是回答，消息随后改成谁选了什么。允许文字作答时，线程里你的下一条消息就是答案；不允许时 bot 会提醒你点按钮。提问已关闭或过期时不再接受回答，消息上会注明。
- **别的机器人**：别的机器人（例如告警、CI 机器人）在绑定的频道里 @bot，或在插件的线程里说话，和人一样转给 Loop Now，发件人显示为 **机器人 Slack @机器人的名字**，在线程里插话时前面注明 `机器人 @名字：`。为防止机器人之间来回对话，本插件自己的消息永远不转发；同一个线程里机器人的消息转发满 `botMessageLimit` 条（默认 20）后不再转发，并在线程里提示一次。只想接某些机器人时填 `allowedBots`。只给本人看的提示（例如项目还没有 Manager）机器人看不到，改记在插件日志里。
- **代管身份**：Agent 与这个身份的每条线索在 `identityTarget` 里是一个 Slack 线程，开头注明谁发给谁（`manager → ops`）。在线程里回复就是以该身份回复，也可以点按钮作答。（在这些线程之外发新的顶层消息，按上面的规则是找 Manager 的新对话。）

## 插件看到什么、存什么

- bot 只收得到它所在的对话里的消息：被邀请进的频道，以及它自己的私信。
- 不在插件开启的线程里的频道消息一律忽略，也不存储。只处理已绑定频道里 @bot 的消息、私信，以及已对应线程里的消息。
- 插件状态里存 Slack 线程与 Loop Now 线索的对应（含线程里已转发的机器人消息条数），以及哪些 Loop Now 消息已经贴出（去重用），各保留最近 500 个；更早的线程里再回复不会转回 Loop Now。
- 能看到代管身份线程的人都能以该身份回复或点按钮，所以 `identityTarget` 要选只有该看的人才看得到的频道或个人。
- 消息的编辑、删除和附件不转发，只转文字。

## 开发

仓库假定旁边有一份 [loop-now](https://github.com/AI-for-anyone/loop-now)：类型经 `tsconfig.json` 的 paths 取自 `../loop-now/plugins/sdk/src`（SDK 在运行时由宿主提供，不发布到 npm），校验用编好的宿主。

```sh
npm ci
npm run typecheck
npm test            # 真的 Slack 客户端库连假的 Slack（Web API 与 Socket Mode），平台用假的 PluginAPI
(cd ../loop-now/plugins && npm ci && npm run build)
npm run validate    # node ../loop-now/plugins/host/dist/main.js validate --load .
```

```
loop-now-plugin-slack/
├── package.json            清单：loopNow 段（权限、渠道、配置表单）
├── package-lock.json
├── slack-app-manifest.json Slack 应用清单
├── platform/
│   ├── index.ts            宿主加载的入口：默认导出 register
│   ├── plugin.ts           两个方向、提问、线程对应
│   ├── slack.ts            Socket Mode 连接与退避重连；Web API 客户端
│   └── format.ts           Slack 与 Loop Now 之间的文字转换、Block Kit
└── test/
```

## 许可

Apache-2.0
