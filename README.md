# pi-ask-channel-reminder

`ask_user_question` 长时间没人回答时，通过 [pi-channels](https://www.npmjs.com/package/@amaster.ai/pi-channels) 的路由（飞书 / 钉钉 / 企微 / webhook）给自己发一条提醒。

**只提醒，不代答**：回答仍然在终端完成。远端作答需要 pi-channels 打开入站事件并处理与 chat bridge 的消息竞争，本包刻意不做。

## 依赖的事件契约

运行期不 import 任何第三方包，只按名字使用同一 session 事件总线上的通道：

| 通道 | 来源 | 用途 |
|---|---|---|
| `rpiv:ask-user:prompt` | `@juicesharp/rpiv-ask-user-question`（`@ssk_dev/rpiv-ask-user-question-lean` 原样透传） | 拿到 `toolCallId` 与问题、选项 |
| `rpiv:ask-user:blocked` | 同上，`finally` 保证成对 | 问题在终端被解决/取消后立刻停表 |
| `channel:send` | `@amaster.ai/pi-channels` | 出站发送，路由别名由它解析 |
| `tool_execution_end` | pi 本体 | ask 以任何方式结束时的兜底收口 |

事件名按 `rpiv:*` 稳定性政策（名称永不改、payload 只增不减）硬编码，因此不需要跟着上游版本升级。

## 安装

```bash
pi install git:github.com/Echokovo/pi-ask-channel-reminder
```

开发时跑本地副本（本地路径不拷贝、改了即时生效）：

```bash
pi install ./pi-ask-channel-reminder
```

需要同时装了 pi-channels 并已配好 `pi-channels.routes`；否则提醒会失败，可用 `/ask-reminder status` 看到失败原因。

## 配置

`~/.pi/agent/settings.json`（也可放在已信任项目的 `.pi/settings.json`，优先级更高；本段不做 `${ENV}` 展开，别放密钥）：

```json
{
  "pi-ask-reminder": {
    "enabled": true,
    "route": "ops",
    "afterMs": 180000,
    "repeatMs": 0,
    "maxReminders": 1,
    "includeDescriptions": false,
    "maxChars": 1500,
    "notifyResolved": true
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不再登记新问题 |
| `route` | `"ops"` | pi-channels 的 adapter 名或 route 别名 |
| `afterMs` | `180000` | 等待多久发第一条提醒（1s ~ 24h） |
| `repeatMs` | `0` | 重复间隔；`0` = 只发一条（此时 `maxReminders` 无意义） |
| `maxReminders` | `1` | 单个问题的提醒上限，仅 `repeatMs > 0` 时生效 |
| `includeDescriptions` | `false` | 提醒里是否带选项 `description`（更啰嗦，也可能带出更多内部信息） |
| `maxChars` | `1500` | 单条提醒长度上限，超出截断 |
| `notifyResolved` | `true` | 已经提醒过、之后在终端作答时补一条「已处理」，免得手机上挂着疑问 |

设置只在 `session_start` 和 `/ask-reminder reload` 时读取。

## 提醒长这样

```
⏰ pi 在等你回答 · 已等 3m01s
发布演练 · deploy · workstation

1) [发布环境] 这次要发布到哪个环境？
   A. 预发
   B. 生产
2) [冒烟] 要不要一起跑冒烟？（多选）
   A. 要
   B. 不要

→ 回终端选择即可
```

多题时带题号，选项用字母避免和题号混淆；问题与选项都会被压成一行并截断。

## 命令

```
/ask-reminder status   # 当前配置、等待中的问题、最近一次发送成功/失败
/ask-reminder test     # 按真实排版发一条测试提醒，验证通道通不通
/ask-reminder reload   # 重读设置
```

等待期间页脚状态栏显示 `⏳ 待回答 N`。排查接线问题时用 `PI_ASK_REMINDER_DEBUG=1 pi …`，会在 stderr 打印读到的配置和登记的 `toolCallId`。

## 已知边界

- **总线是 per-session 的**：subagent / lanes 子运行里的 ask 跑在自己的总线上，本扩展看不见也提醒不了。
- **RPC/ACP 主机**（Codex、Zed 等）下 ask 走宿主自己的对话框，`rpiv:ask-user:*` 仍会发，提醒可用；但那条路径不支持外部作答。
- **信息外泄**：问题与选项会整条推送到通道。若路由指向群聊，等于把仓库名、分支、决策项发给全组——建议路由到私聊（飞书用 `open_id:ou_xxx`）并按需关掉 `includeDescriptions`。
- 发送失败最多再重试 2 次（间隔 30s）后放弃，不无限轰炸；结果只体现在 `/ask-reminder status`。

## 开发

typecheck 需要 pi 的类型，本地用软链接指向已安装的 release（`node_modules` 已 gitignore）：

```bash
mkdir -p node_modules/@earendil-works
ln -sfn ~/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent \
        node_modules/@earendil-works/pi-coding-agent
npm i -D typescript @types/node

npm run typecheck
npm test        # node:test + 假 EventBus，覆盖排版、设置分层、超时/重复/收口/失败路径
```
