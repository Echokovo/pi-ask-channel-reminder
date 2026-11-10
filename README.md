# pi-ask-channel-reminder

`ask_user_question` 长时间没人回答时，通过 [pi-channels](https://www.npmjs.com/package/@amaster.ai/pi-channels) 的路由（飞书 / 钉钉 / 企微 / webhook）给自己发一条提醒。

**只提醒，不代答**：回答仍然在终端完成；问题结束后也不再推送“已处理/已取消”之类的收尾消息，避免手机上多一条无用的确认。远端作答需要 pi-channels 打开入站事件并处理与 chat bridge 的消息竞争，本包刻意不做。

## 依赖的事件契约

运行期不 import 任何第三方包：事件按名字使用同一 session 总线，按键走 `ctx.ui` 接口。

| 通道 | 来源 | 用途 |
|---|---|---|
| `rpiv:ask-user:prompt` | `@juicesharp/rpiv-ask-user-question`（`@ssk_dev/rpiv-ask-user-question-lean` 原样透传） | 拿到 `toolCallId` 与问题、选项 |
| `rpiv:ask-user:blocked` | 同上，`finally` 保证成对 | `active:true` 记录等待上屏；`active:false` 立即停表 |
| `ui_prompt_start` | pi 本体（`ui.custom`） | `kind:"custom"` 时确认对话框真正上屏，重新计时 |
| `ctx.ui.onTerminalInput` | pi 本体（不是事件总线） | 观察原始按键，人还在操作就把计时顺延 |
| `channel:send` | `@amaster.ai/pi-channels` | 出站发送，路由别名由它解析 |
| `tool_execution_end` | pi 本体 | ask 以任何方式结束时的兜底停表 |

`rpiv:*` 事件名按上游稳定性政策（名称永不改、payload 只增不减）硬编码。`ui_prompt_start`、`tool_execution_end` 与 `onTerminalInput` 是 pi 本体的扩展 API。

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
    "afterActivityMs": 360000,
    "repeatMs": 0,
    "maxReminders": 1,
    "includeDescriptions": false,
    "maxChars": 1500,
    "resetOnActivity": true
  }
}
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉后不再登记新问题 |
| `route` | `"ops"` | pi-channels 的 adapter 名或 route 别名 |
| `afterMs` | `180000` | 没人活动时，等待多久发第一条提醒（1s ~ 24h） |
| `afterActivityMs` | `2 × afterMs` | 用户活动过之后，从最后一次按键起再等多久；`-1` = 不再提醒，`0` = 沿用 `afterMs`/`repeatMs`。省略该字段时按 `2 × afterMs` 计算（默认配置下 6 分钟） |
| `repeatMs` | `0` | 重复间隔；`0` = 只发一条（此时 `maxReminders` 无意义） |
| `maxReminders` | `1` | 单个问题的提醒上限，仅 `repeatMs > 0` 时生效 |
| `includeDescriptions` | `false` | 提醒里是否带选项 `description`（更啰嗦，也可能带出更多内部信息） |
| `maxChars` | `1500` | 单条提醒长度上限，超出截断 |
| `resetOnActivity` | `true` | ask 等待期间有终端按键就顺延 `afterMs`；关掉则回到纯时间驱动 |

设置只在 `session_start` 和 `/ask-reminder reload` 时读取。

## 计时与状态

- 计时从 `rpiv:ask-user:prompt` 开始；`ui_prompt_start { kind: "custom" }` 确认对话框真正上屏后再重新计满 `afterMs`，懒加载那几百毫秒不算“你已经看到”。
- `resetOnActivity: true` 时，ask 等待期间任意有意义的终端按键都会把计时顺延到 `afterActivityMs`（默认 `2 × afterMs`）：人还在选就不催，停手超过这个时长才发。首次提醒和 `repeatMs` 重复都适用；`afterActivityMs: -1` 表示只要活动过就不再提醒（包括已经发过首条之后的重复）。鼠标和焦点上报不算。
- `blocked { active: false }` 或 `tool_execution_end` 到达时立即停表并移出等待列表，不再向通道发任何收尾消息；作答结果只在终端可见。
- 原始按键只观察、不吞，ask 自己的键盘操作不受影响。

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
/ask-reminder status   # 当前配置、已展示/最近操作/活动后策略、最近一次发送成功/失败
/ask-reminder test     # 按真实排版发一条测试提醒，验证通道通不通
/ask-reminder reload   # 重读设置
```

等待期间页脚状态栏显示 `⏳ 待回答 N`；确认对话框上屏后追加 `· 已展示 M`。排查接线问题时用 `PI_ASK_REMINDER_DEBUG=1 pi …`，会在 stderr 打印读到的配置、登记的 `toolCallId`、上屏与按键事件（只记字节数，不记按键内容）。

## 已知边界

- **总线是 per-session 的**：subagent / lanes 子运行里的 ask 跑在自己的总线上，本扩展看不见也提醒不了。
- **RPC/ACP 主机**（Codex、Zed 等）下 ask 走宿主自己的对话框，`rpiv:ask-user:*` 仍会发，提醒可用；但那条路径不支持外部作答，也没有 `onTerminalInput` 与 `ui_prompt_start { kind: "custom" }`，按键顺延和“已展示”标记都会退化为纯时间驱动。
- **上屏配对是启发式的**：`ui_prompt_start` 不带 `toolCallId`，本扩展用 `blocked { active: true }` 的到达顺序 FIFO 配对；并发 ask 或其他扩展的 custom UI 可能让“已展示”标记错位，最坏只影响状态显示，不影响收口。
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
