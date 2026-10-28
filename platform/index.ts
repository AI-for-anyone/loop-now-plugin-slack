// 平台半边的入口：宿主用 jiti 加载，默认导出 register。逻辑在 plugin.ts，测试用 createPlugin 指向假的 Slack。

import { createPlugin } from './plugin.ts'

export default createPlugin()
