# Loop Now for Slack

[中文](https://github.com/AI-for-anyone/loop-now-plugin-slack/blob/main/README.zh-CN.md)

A [Loop Now](https://github.com/AI-for-anyone/loop-now) plugin that connects a Slack workspace in both directions:

- **People → Manager.** Mention the bot in a Slack channel bound to a project, or send the bot a direct message. The message goes to that project's Manager. The Manager's replies come back in the same Slack thread, and so do any questions it asks, rendered as buttons.
- **Agents → people.** Hand an external identity over to this plugin. Messages and questions that Agents send to that identity are posted to Slack, one Slack thread per conversation. Replies and button clicks in those threads go back to Loop Now as that identity, so a waiting task resumes exactly as if the person had answered in the console.

The plugin connects with [Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode), so Loop Now does not need a public URL. It is a platform-only plugin: it has no Agent half, and it is loaded by Loop Now's plugin host straight from `platform/index.ts`, with no build step.

## Requirements

- A Loop Now build whose plugin host provides `api.channels.answer` and `api.config.projects()`. Older hosts refuse to load the plugin and say why.
- A Slack workspace where you can create apps.

## 1. Create the Slack app

1. Open <https://api.slack.com/apps>, choose **Create New App › From a manifest**, and pick your workspace.
2. Paste the contents of [`slack-app-manifest.json`](https://github.com/AI-for-anyone/loop-now-plugin-slack/blob/main/slack-app-manifest.json) (JSON tab), then **Create**.
3. **Install to Workspace** and allow the requested scopes.

The manifest turns on Socket Mode, interactivity (for the answer buttons), the App Home messages tab (so people can DM the bot), the bot events `app_mention`, `message.im`, `message.channels` and `message.groups`, and these bot scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`, `im:write`, `channels:history`, `groups:history`, `channels:read`, `users:read`.

## 2. Get the two tokens

- **App-Level Token** (`xapp-…`): **Basic Information › App-Level Tokens › Generate Token and Scopes**, add the `connections:write` scope, and generate. Socket Mode uses it to receive events.
- **Bot Token** (`xoxb-…`): **OAuth & Permissions › Bot User OAuth Token**. Used to post and update messages.

## 3. Install the plugin in Loop Now

In the console: **Plugin market** › **Install plugin**, source **git repository**, **Repository URL** `https://github.com/AI-for-anyone/loop-now-plugin-slack.git`, and optionally a branch, tag or commit. Or with the CLI:

```sh
loopctl plugin install https://github.com/AI-for-anyone/loop-now-plugin-slack.git@main --force
```

`--force` confirms a source that is not an official plugin. Loop Now runs `npm ci --ignore-scripts --omit=dev` in the installed copy; the dependencies (`@slack/socket-mode`, `@slack/web-api`, `undici`) are pinned in `package-lock.json`.

Before installing, the console shows what the plugin asks for: permissions `inbox.send`, `inbox.read`, `agents.read`, `identities.manage` and `state`, and one channel, **Slack**, that can manage external identities.

## 4. Configure

On the plugin's **Config** tab (**Plugin market** › **Slack** › **Details** › **Config**):

| Field | Meaning |
|---|---|
| `appToken` | The App-Level Token (`xapp-…`). Secret: write-only, never shown or logged. |
| `botToken` | The Bot Token (`xoxb-…`). Secret. |
| `dmProject` | Which project direct messages to the bot go to: a project name (or its ID). Empty means DMs are not accepted and the sender is told so. The project must have the plugin enabled. |
| `identityTarget` | Where messages for managed external identities are posted: a Slack channel ID (`C…`/`G…`, shown at the bottom of the channel's details) or a user ID (`U…`, **Copy member ID** in the profile; posts go to that person's DM with the bot). |
| `allowedBots` | Forward messages only from these bots: bot user IDs (`U…`, **Copy member ID** in the bot's profile) or app IDs (`A…`), separated by commas. Empty (the default) forwards messages from any bot. See **Other bots** below. |
| `botMessageLimit` | How many bot messages are forwarded per Slack thread; the default is 20. Past the limit, bot messages in that thread are no longer forwarded and the thread gets one notice. Messages from people do not count. |

The plugin reconnects by itself when the tokens change.

## 5. Enable it in a project and bind channels

**Project settings** › **Plugins** › **Manage project plugins**: enable **Slack**, and under **This project's config** fill in `channels` with the Slack channel IDs for this project, separated by commas (for example `C0123ABCD, C0456EFGH`). Then invite the bot to each of those channels in Slack (`/invite @Loop Now`).

Which projects the plugin serves is simply which projects have it enabled. A channel that is not bound to an enabled project is ignored. If a channel is bound in two projects, the first one is used and a warning is logged.

## 6. Let the plugin manage an external identity (optional)

1. Create an external identity in the console (**External identities**) if you do not have one, for example `ops`.
2. On its page, under **Managed by**, choose **Slack · Slack** as the **Managing plugin channel**, and save.
3. Make sure `identityTarget` is set.

From then on, messages and questions that Agents send to `@ops` appear in Slack instead of that identity's inbox.

## Using it in Slack

- **Ask the Manager**: `@Loop Now can you check last night's failed run?` in a bound channel. The bot forwards it to the project's Manager as **Slack @your-name**, and the Manager's reply appears in the thread under your message.
- **Keep talking in the thread**: later messages in the same Slack thread, with or without mentioning the bot, continue the same conversation. If someone else joins the thread, their messages are prefixed with their name so the Agent can tell people apart.
- **Direct messages**: DM the bot; each top-level DM starts a new conversation with the `dmProject` Manager, and the replies arrive in a thread under it.
- **Questions**: when an Agent asks a question, the message carries one button per option. Clicking one answers the question, and the message is updated to show who chose what. If the question allows free text, your next message in the thread is the answer. If it does not, the bot reminds you to use the buttons. Answers to closed or expired questions are refused with a note on the message.
- **Other bots**: when another bot (an alerting or CI bot, say) mentions the bot in a bound channel, or posts in one of the plugin's threads, its message is forwarded like a person's, with the sender shown as **机器人 Slack @bot-name** (机器人 means "bot"); when it joins a thread it is prefixed with `机器人 @bot-name：`. To keep bots from talking to each other in a loop, the plugin's own messages are never forwarded, and once `botMessageLimit` bot messages (20 by default) have been forwarded in a thread, further bot messages there are not, and the thread gets one notice. Set `allowedBots` to accept only certain bots. Bots cannot see the notices that are shown only to the sender (for example, that a project has no Manager); for bots those go to the plugin log instead.
- **Managed identity**: each conversation an Agent starts with the identity becomes a Slack thread in `identityTarget`, headed by who sent it (`manager → ops`). Reply in the thread to answer as that identity, or click a button. (A new top-level message, outside these threads, is a new conversation with the Manager instead, as above.)

## What the plugin sees and stores

- The bot only receives messages from conversations it is in: channels it has been invited to, and its own DMs.
- Channel messages outside a thread the plugin started are ignored and not stored. Only mentions of the bot in bound channels, DMs, and messages in mapped threads are processed.
- Plugin state keeps the mapping between Slack threads and Loop Now threads (including how many bot messages each thread has forwarded), plus which Loop Now messages were already posted (for de-duplication): the most recent 500 of each. Replies in older threads are not forwarded.
- Anyone who can see a managed-identity thread can reply or click as that identity, so pick an `identityTarget` that only the right people can read.
- Message edits, deletions and file attachments are not forwarded; only the text is.

## Development

The repository expects a checkout of [loop-now](https://github.com/AI-for-anyone/loop-now) next to it: types come from `../loop-now/plugins/sdk/src` through `tsconfig.json` paths (the SDK is provided by the host at runtime and is not published to npm), and validation uses the built host.

```sh
npm ci
npm run typecheck
npm test            # real Slack client libraries against a fake Slack (Web API + Socket Mode) and a fake PluginAPI
(cd ../loop-now/plugins && npm ci && npm run build)
npm run validate    # node ../loop-now/plugins/host/dist/main.js validate --load .
```

```
loop-now-plugin-slack/
├── package.json            manifest: the loopNow section (permissions, channel, config schema)
├── package-lock.json
├── slack-app-manifest.json Slack app manifest
├── platform/
│   ├── index.ts            entry loaded by the host: export default register
│   ├── plugin.ts           both directions, questions, thread mapping
│   ├── slack.ts            Socket Mode connection with reconnect backoff; Web API client
│   └── format.ts           Slack ↔ Loop Now text, Block Kit
└── test/
```

## License

Apache-2.0
