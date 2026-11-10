/**
 * pi-ask-channel-reminder
 *
 * 当 `ask_user_question` 长时间无人回答时，通过 pi-channels（飞书 / 钉钉 / 企微 / webhook）
 * 给自己发一条提醒。只做提醒，不代答：回答仍然在终端完成。
 *
 * 依赖既有扩展与 pi 本体的公开事件，运行期不 import 它们（事件名硬编码）：
 *
 *   rpiv:ask-user:prompt    { toolCallId, questions[] }   ask 问题内容，弹框前发出
 *   rpiv:ask-user:blocked   { active, toolCallId }        等待人回答的括号（finally 关）
 *   ui_prompt_start         { kind }                      pi core：custom 对话框真正上屏
 *   tool_execution_end      { toolCallId, toolName }        pi core：ask 结束时的兜底停表
 *   channel:send            { adapter, text, callback }   交给 pi-channels 出站
 *
 * 另外用 `ctx.ui.onTerminalInput` 观察原始按键：ask 弹框期间有按键就说明人在场。
 * 总线是 per-session 的：subagent / lanes 子运行里的 ask 跑在自己的总线上，看不见。
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const ASK_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_BLOCKED_EVENT = "rpiv:ask-user:blocked";
const CHANNEL_SEND_EVENT = "channel:send";
const ASK_TOOL_NAME = "ask_user_question";
const SETTINGS_KEY = "pi-ask-reminder";
const STATUS_KEY = "ask-reminder";
/** pi-channels 没加载时 channel:send 没人应答，用它兜底而不是永久挂起。 */
const SEND_ACK_TIMEOUT_MS = 20000;
/** 发送失败后的重试间隔与次数上限，避免对通道无限轰炸。 */
const SEND_RETRY_DELAY_MS = 30000;
const SEND_MAX_FAILURES = 2;

type SendResult = { ok: boolean; error?: string };

type Config = {
  enabled: boolean;
  /** pi-channels 的 adapter 名或 route 别名（如 "ops"）。 */
  route: string;
  /** 等待多久后发第一条提醒。 */
  afterMs: number;
  /** 重复提醒间隔，0 = 只发一次。 */
  repeatMs: number;
  maxReminders: number;
  /** 提醒里是否带上每个选项的 description（更啰嗦，也可能带出更多内部信息）。 */
  includeDescriptions: boolean;
  maxChars: number;
  /** ask 等待期间有终端按键时重置计时；关掉则回到纯时间驱动。 */
  resetOnActivity: boolean;
  /**
   * 用户活动过之后，下一次提醒的静默时长。
   * -1 = 不再提醒；0 = 沿用 afterMs/repeatMs；正数 = 从最后一次活动起算。
   * 未配置时在 normalizeConfig 里取 2 × afterMs。
   */
  afterActivityMs: number;
};

const DEFAULTS: Config = {
  enabled: true,
  route: "ops",
  afterMs: 180000,
  repeatMs: 0,
  maxReminders: 1,
  includeDescriptions: false,
  maxChars: 1500,
  resetOnActivity: true,
  /** 仅作为文档默认值；实际未配置时由 normalizeConfig 取 2 × afterMs。 */
  afterActivityMs: 360000,
};

type NormalizedOption = { label: string; description: string };
type NormalizedQuestion = {
  header: string;
  question: string;
  multiSelect: boolean;
  options: NormalizedOption[];
};

type Pending = {
  toolCallId: string;
  questions: NormalizedQuestion[];
  startedAt: number;
  /** 首次确认对话框已上屏的时间；RPC 主机或没捕获到 ui_prompt_start 时为空。 */
  mountedAt: number | undefined;
  /** 最近一次终端按键的时间；初始等于 startedAt。 */
  lastActivityAt: number;
  /** 用户是否在这次 ask 里有过有效按键。 */
  seen: boolean;
  /** 最近一次成功发出提醒的时间。 */
  lastSentAt: number | undefined;
  sent: number;
  failures: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  lastSend: (SendResult & { at: number }) | undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 折成一行并截断：问题/选项可能是多行的，通道消息要能扫读。 */
function clip(value: string, max: number): string {
  const flat = value.replace(/\s*\r?\n\s*/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, Math.max(0, max - 1))}…` : flat;
}

function num(raw: unknown, fallback: number, min: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= min && raw <= max ? Math.floor(raw) : fallback;
}
/** afterActivityMs 比普通时长多一个 -1（活动后不再提醒）；0 表示沿用基准时长。 */
function activityDelay(raw: unknown, fallback: number): number {
  return raw === -1 ? -1 : num(raw, fallback, 0, 172800000);
}

function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}
function str(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

export function normalizeConfig(raw: Record<string, unknown>): Config {
  const afterMs = num(raw.afterMs, DEFAULTS.afterMs, 1000, 86400000);
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    route: str(raw.route, DEFAULTS.route),
    afterMs,
    repeatMs: num(raw.repeatMs, DEFAULTS.repeatMs, 0, 86400000),
    maxReminders: num(raw.maxReminders, DEFAULTS.maxReminders, 1, 20),
    includeDescriptions: bool(raw.includeDescriptions, DEFAULTS.includeDescriptions),
    maxChars: num(raw.maxChars, DEFAULTS.maxChars, 200, 4000),
    resetOnActivity: bool(raw.resetOnActivity, DEFAULTS.resetOnActivity),
    afterActivityMs: activityDelay(raw.afterActivityMs, Math.min(172800000, afterMs * 2)),
  };
}

/** PI_ASK_REMINDER_DEBUG=1 时输出接线细节，用于确认事件有没有收到、设置读到什么。 */
function debug(event: string, data: Record<string, unknown>): void {
  if (process.env.PI_ASK_REMINDER_DEBUG !== "1") return;
  console.error(`[pi-ask-reminder] ${event}`, JSON.stringify(data));
}

function readSection(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(parsed)) return {};
    const section = parsed[SETTINGS_KEY];
    return isRecord(section) ? section : {};
  } catch {
    return {}; // 坏 JSON 交给 pi 自己的设置报错，这里只当没配
  }
}

/**
 * 读取 `pi-ask-reminder` 段：全局 < agentDir < 已信任项目，与 pi 自身的设置分层一致。
 * 不做 `${ENV}` 展开——本段只放路由名和延时，不放密钥。
 */
export function loadConfig(cwd: string, projectTrusted: boolean): Config {
  const globalFile = join(homedir(), ".pi", "agent", "settings.json");
  const agentDir = process.env.PI_AGENT_DIR?.trim() ? process.env.PI_AGENT_DIR.trim() : globalFile;
  const layers = [readSection(globalFile)];
  if (agentDir !== globalFile) layers.push(readSection(join(agentDir, "settings.json")));
  if (projectTrusted) layers.push(readSection(join(cwd, ".pi", "settings.json")));
  const config = normalizeConfig(Object.assign({}, ...layers) as Record<string, unknown>);
  debug("config", { cwd, projectTrusted, globalFile, config });
  return config;
}

export function normalizeQuestions(raw: unknown): NormalizedQuestion[] {
  if (!Array.isArray(raw)) return [];
  const questions: NormalizedQuestion[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const question = typeof item.question === "string" ? clip(item.question, 300) : "";
    if (!question) continue;
    const options: NormalizedOption[] = [];
    if (Array.isArray(item.options)) {
      for (const option of item.options) {
        if (!isRecord(option)) continue;
        const label = typeof option.label === "string" ? clip(option.label, 120) : "";
        if (!label) continue;
        options.push({
          label,
          description: typeof option.description === "string" ? clip(option.description, 160) : "",
        });
      }
    }
    questions.push({
      header: typeof item.header === "string" ? clip(item.header, 24) : "",
      question,
      multiSelect: item.multiSelect === true,
      options,
    });
  }
  return questions;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

/** `/ask-reminder status` 用：活动后的策略一句话。 */
export function formatActivityTimeout(cfg: Config): string {
  if (cfg.afterActivityMs === -1) return "不再提醒";
  if (cfg.afterActivityMs === 0) return "同首条";
  return formatDuration(cfg.afterActivityMs);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 40))}\n…（内容过长已截断）` : text;
}

export type ReminderInput = {
  questions: NormalizedQuestion[];
  waitedMs: number;
  session: string;
  cwd: string;
  host: string;
  reminderIndex: number;
  reminderTotal: number;
};

/** 提醒正文：一行标题 + 定位信息 + 每题问题与 A/B/C 选项（选项用字母，避免和题号混淆）。 */
export function buildReminderText(cfg: Config, input: ReminderInput): string {
  const lines: string[] = [];
  const repeat = input.reminderTotal > 1 ? `（第 ${input.reminderIndex}/${input.reminderTotal} 次）` : "";
  lines.push(`⏰ pi 在等你回答 · 已等 ${formatDuration(input.waitedMs)}${repeat}`);
  const where = [input.session, input.cwd, input.host].filter(Boolean).join(" · ");
  if (where) lines.push(where);
  lines.push("");

  const multi = input.questions.length > 1;
  input.questions.forEach((question, index) => {
    const prefix = multi ? `${index + 1}) ` : "";
    const header = question.header ? `[${question.header}] ` : "";
    lines.push(`${prefix}${header}${question.question}${question.multiSelect ? "（多选）" : ""}`);
    if (question.options.length === 0) {
      lines.push("   （无选项，需在终端输入）");
    }
    question.options.forEach((option, optionIndex) => {
      const letter = String.fromCharCode(65 + optionIndex);
      const description = cfg.includeDescriptions && option.description ? ` — ${option.description}` : "";
      lines.push(`   ${letter}. ${option.label}${description}`);
    });
    if (multi && index < input.questions.length - 1) lines.push("");
  });

  lines.push("");
  lines.push("→ 回终端选择即可");
  return truncate(lines.join("\n"), cfg.maxChars);
}

/** 用于 `/ask-reminder test`：走和真实提醒完全一样的排版。 */
export function buildSampleQuestions(): NormalizedQuestion[] {
  return [
    {
      header: "示例问题",
      question: "这是一条测试提醒，用来确认通道排版是否正常",
      multiSelect: false,
      options: [
        { label: "收到，排版没问题", description: "测试项" },
        { label: "没收到/格式不对", description: "测试项" },
      ],
    },
  ];
}

/** 鼠标、焦点上报不算“人在决策”；按键、粘贴、Esc 都算。 */
function isMeaningfulInput(data: string): boolean {
  if (!data) return false;
  return !/^\x1b\[(?:<|M|[IO])/.test(data);
}

const safeTrusted = (ctx: ExtensionContext | undefined): boolean => {
  if (!ctx) return false;
  try {
    return ctx.isProjectTrusted() === true;
  } catch {
    return false;
  }
};

export default function (pi: ExtensionAPI): void {
  let cfg = loadConfig(process.cwd(), false);
  let lastCtx: ExtensionContext | undefined;
  let lastSendLog: (SendResult & { at: number; kind: string }) | undefined;
  const pending = new Map<string, Pending>();
  /** blocked{true} 后按顺序等待上屏的 toolCallId；ui_prompt_start 不带 id，只能 FIFO 配对。 */
  const mountQueue: string[] = [];
  let watchedUi: unknown;
  let inputUnsub: (() => void) | undefined;

  function setStatus(): void {
    try {
      const mounted = [...pending.values()].filter((entry) => entry.mountedAt !== undefined).length;
      lastCtx?.ui.setStatus(
        STATUS_KEY,
        pending.size > 0 ? `⏳ 待回答 ${pending.size}${mounted > 0 ? ` · 已展示 ${mounted}` : ""}` : undefined,
      );
    } catch {
      // 非交互模式下没有 footer，忽略。
    }
  }

  function clearTimer(entry: Pending): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
  }

  function dropFromMountQueue(toolCallId: string): void {
    const index = mountQueue.indexOf(toolCallId);
    if (index !== -1) mountQueue.splice(index, 1);
  }

  function stop(entry: Pending): void {
    pending.delete(entry.toolCallId);
    clearTimer(entry);
    dropFromMountQueue(entry.toolCallId);
  }

  /** 下一次提醒的间隔；-1 = 不再提醒。活动过之后走 afterActivityMs，否则走 afterMs/repeatMs。 */
  function nextDelay(entry: Pending): number {
    const active = cfg.resetOnActivity && entry.seen;
    if (entry.sent === 0) {
      if (!active) return cfg.afterMs;
      return cfg.afterActivityMs === -1 ? -1 : cfg.afterActivityMs > 0 ? cfg.afterActivityMs : cfg.afterMs;
    }
    if (cfg.repeatMs <= 0) return -1;
    const activeSinceLastSend = active && entry.lastActivityAt > (entry.lastSentAt ?? 0);
    if (activeSinceLastSend) {
      return cfg.afterActivityMs === -1 ? -1 : cfg.afterActivityMs > 0 ? cfg.afterActivityMs : cfg.repeatMs;
    }
    return cfg.repeatMs;
  }

  /** 下一次提醒的起算点：没发过看首次等待/最近活动，发过看最近发送或最近活动。 */
  function nextAnchor(entry: Pending): number {
    if (entry.sent === 0) return Math.max(entry.startedAt, entry.lastActivityAt);
    const activeSinceLastSend = cfg.resetOnActivity && entry.seen && entry.lastActivityAt > (entry.lastSentAt ?? 0);
    return activeSinceLastSend ? entry.lastActivityAt : (entry.lastSentAt ?? entry.lastActivityAt);
  }

  function arm(entry: Pending, delay: number): void {
    if (delay < 0) {
      clearTimer(entry);
      return;
    }
    schedule(entry, Math.max(1, delay));
  }

  /**
   * 交互模式下观察原始按键：ask 弹框期间有按键就顺延计时，避免“人已经在选、手机还在催”。
   * 只观察不吞输入；RPC/print 主机没有这个能力，退化为纯时间驱动。
   */
  function watchTerminalInput(ctx: ExtensionContext): void {
    const ui = ctx.ui;
    if (!ui || typeof ui.onTerminalInput !== "function" || watchedUi === ui) return;
    inputUnsub?.();
    watchedUi = ui;
    try {
      inputUnsub = ui.onTerminalInput((data: string) => {
        try {
          if (pending.size === 0 || !isMeaningfulInput(data)) return undefined;
          const now = Date.now();
          for (const entry of pending.values()) {
            entry.lastActivityAt = now;
            entry.seen = true;
            if (!cfg.resetOnActivity) continue;
            if (cfg.afterActivityMs === -1) {
              clearTimer(entry);
              continue;
            }
            // 上次发送失败时已有 30s 重试计时，不被按键顺延；否则一次失败会拖到活动后超时之后。
            if (entry.lastSend && !entry.lastSend.ok) continue;
            if (entry.sent >= cfg.maxReminders) {
              clearTimer(entry);
              continue;
            }
            arm(entry, nextDelay(entry));
          }
          debug("activity", { pending: pending.size, bytes: data.length });
          setStatus();
        } catch (error) {
          debug("activity-error", { error: error instanceof Error ? error.message : String(error) });
        }
        return undefined;
      });
    } catch (error) {
      debug("activity-unavailable", { error: error instanceof Error ? error.message : String(error) });
    }
  }

  function unwatchTerminalInput(): void {
    inputUnsub?.();
    inputUnsub = undefined;
    watchedUi = undefined;
  }

  function context(): { session: string; cwd: string; host: string } {
    return {
      session: pi.getSessionName() ?? "",
      cwd: lastCtx?.cwd ? basename(lastCtx.cwd) : "",
      host: hostname(),
    };
  }

  /** 交给 pi-channels 出站；没人接管（未安装/未加载）时超时返回错误。 */
  function send(text: string): Promise<SendResult> {
    return new Promise<SendResult>((resolve) => {
      let settled = false;
      const done = (result: SendResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => done({ ok: false, error: "channel:send 无应答（pi-channels 未加载？）" }), SEND_ACK_TIMEOUT_MS);
      timer.unref?.();
      try {
        pi.events.emit(CHANNEL_SEND_EVENT, {
          adapter: cfg.route,
          recipient: "",
          text,
          source: "pi-ask-reminder",
          callback: (result: unknown) =>
            done(isRecord(result) && typeof result.ok === "boolean"
              ? { ok: result.ok, error: typeof result.error === "string" ? result.error : undefined }
              : { ok: false, error: "channel:send 返回了非预期结果" }),
        });
      } catch (error) {
        done({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  function schedule(entry: Pending, delayMs: number): void {
    if (delayMs <= 0) return;
    clearTimer(entry);
    const timer = setTimeout(() => {
      entry.timer = undefined;
      void fire(entry);
    }, delayMs);
    timer.unref?.();
    entry.timer = timer;
  }

  async function fire(entry: Pending): Promise<void> {
    if (!pending.has(entry.toolCallId)) return; // 等待期间已解决
    if (entry.sent >= cfg.maxReminders) {
      clearTimer(entry);
      return;
    }
    const retrying = entry.lastSend !== undefined && !entry.lastSend.ok;
    if (!retrying) {
      const delay = nextDelay(entry);
      if (delay < 0) {
        clearTimer(entry);
        return;
      }
      const wait = nextAnchor(entry) + delay - Date.now();
      if (wait > 0) {
        schedule(entry, wait);
        return;
      }
    }
    const text = buildReminderText(cfg, {
      questions: entry.questions,
      waitedMs: Date.now() - (entry.mountedAt ?? entry.startedAt),
      ...context(),
      reminderIndex: entry.sent + 1,
      reminderTotal: cfg.maxReminders,
    });
    const result = await send(text);
    entry.lastSend = { ...result, at: Date.now() };
    lastSendLog = { ...result, at: Date.now(), kind: "提醒" };
    if (!pending.has(entry.toolCallId)) return;
    if (result.ok) {
      entry.sent += 1;
      entry.lastSentAt = Date.now();
    } else {
      entry.failures += 1;
    }
    if (entry.sent >= cfg.maxReminders || entry.failures > SEND_MAX_FAILURES) {
      clearTimer(entry);
      return;
    }
    if (!result.ok) {
      schedule(entry, SEND_RETRY_DELAY_MS);
      return;
    }
    const delay = nextDelay(entry);
    if (delay < 0) clearTimer(entry);
    else schedule(entry, delay);
  }

  /** 问题结束：停表、移出等待列表，不再向通道发任何收尾消息。 */
  function settle(toolCallId: string): void {
    const entry = pending.get(toolCallId);
    if (!entry) return;
    stop(entry);
    setStatus();
  }

  pi.events.on(ASK_PROMPT_EVENT, (data: unknown) => {
    if (!cfg.enabled || !isRecord(data)) return;
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const questions = normalizeQuestions(data.questions);
    if (!toolCallId || questions.length === 0 || pending.has(toolCallId)) return;
    const now = Date.now();
    const entry: Pending = {
      toolCallId,
      questions,
      startedAt: now,
      mountedAt: undefined,
      lastActivityAt: now,
      seen: false,
      lastSentAt: undefined,
      sent: 0,
      failures: 0,
      timer: undefined,
      lastSend: undefined,
    };
    pending.set(toolCallId, entry);
    debug("prompt", { toolCallId, questions: questions.length, inMs: cfg.afterMs, route: cfg.route });
    arm(entry, nextDelay(entry));
    setStatus();
  });

  pi.events.on(ASK_BLOCKED_EVENT, (data: unknown) => {
    if (!isRecord(data)) return;
    if (data.active === true) {
      if (typeof data.toolCallId === "string" && pending.has(data.toolCallId) && !mountQueue.includes(data.toolCallId)) {
        mountQueue.push(data.toolCallId);
        debug("blocked", { toolCallId: data.toolCallId });
      }
      return;
    }
    if (typeof data.toolCallId === "string") {
      settle(data.toolCallId);
      return;
    }
    // 早期版本或异常载荷没带 toolCallId：全部收口，宁可少提醒也不要提醒过期问题。
    for (const toolCallId of [...pending.keys()]) settle(toolCallId);
  });

  // ui_prompt_start 只带 kind，不带 toolCallId；按 blocked{true} 的到达顺序 FIFO 配对。
  pi.on("ui_prompt_start", (event) => {
    if (event.kind !== "custom") return;
    const toolCallId = mountQueue.shift();
    const entry = toolCallId ? pending.get(toolCallId) : undefined;
    if (!entry) return;
    entry.mountedAt = Date.now();
    // 从真正上屏开始重新计时；上屏前已经有过按键时按活动后的间隔走。
    if (entry.sent === 0) arm(entry, nextDelay(entry));
    debug("mounted", { toolCallId });
    setStatus();
  });

  // 兜底：ask 调用以任何方式结束（含没发 blocked{false} 的主机）都收口，并拿到最终结果。
  pi.on("tool_execution_end", (event) => {
    if (event.toolName !== ASK_TOOL_NAME) return;
    const entry = pending.get(event.toolCallId);
    if (!entry) return;
    stop(entry);
    setStatus();
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    cfg = loadConfig(ctx.cwd, safeTrusted(ctx));
    watchTerminalInput(ctx);
    setStatus();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    lastCtx = ctx;
    watchTerminalInput(ctx);
  });

  pi.on("session_shutdown", () => {
    unwatchTerminalInput();
    for (const entry of pending.values()) clearTimer(entry);
    pending.clear();
    mountQueue.length = 0;
    setStatus();
  });

  pi.registerCommand("ask-reminder", {
    description: "ask 超时提醒：status | test | reload",
    getArgumentCompletions: (prefix: string) => {
      const options = ["status", "test", "reload"].filter((name) => name.startsWith(prefix.trim()));
      return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      lastCtx = ctx;
      watchTerminalInput(ctx);
      const [sub = "status"] = args.trim().split(/\s+/);

      if (sub === "reload") {
        cfg = loadConfig(ctx.cwd, safeTrusted(ctx));
        ctx.ui.notify(`pi-ask-reminder 已重载：${cfg.enabled ? "on" : "off"} · ${cfg.route} · ${formatDuration(cfg.afterMs)} 后提醒`, "info");
        return;
      }

      if (sub === "test") {
        const text = buildReminderText(cfg, {
          questions: buildSampleQuestions(),
          waitedMs: 0,
          ...context(),
          reminderIndex: 1,
          reminderTotal: 1,
        });
        const result = await send(text);
        lastSendLog = { ...result, at: Date.now(), kind: "测试" };
        ctx.ui.notify(result.ok ? `已通过 "${cfg.route}" 发出测试提醒` : `发送失败：${result.error}`, result.ok ? "info" : "error");
        return;
      }

      const lines = [
        `${cfg.enabled ? "启用" : "停用"} · 路由 ${cfg.route}`,
        `首条提醒 ${formatDuration(cfg.afterMs)} 后${cfg.repeatMs > 0 ? ` · 每 ${formatDuration(cfg.repeatMs)} 重复` : " · 不重复"} · 上限 ${cfg.maxReminders} 条`,
        `带选项说明 ${cfg.includeDescriptions ? "是" : "否"} · 活动重置 ${cfg.resetOnActivity ? "开" : "关"} · 活动后 ${formatActivityTimeout(cfg)} · 长度上限 ${cfg.maxChars}`,
        `等待中的问题：${pending.size}`,
      ];
      const now = Date.now();
      for (const entry of pending.values()) {
        const sent = entry.sent > 0 ? `已提醒 ${entry.sent} 次` : "尚未提醒";
        const shown = entry.mountedAt ? `已展示 ${formatDuration(now - entry.mountedAt)}` : "等待上屏";
        const idle = entry.seen
          ? `最近操作 ${formatDuration(now - entry.lastActivityAt)}前（活动后 ${formatActivityTimeout(cfg)}）`
          : "暂无操作";
        lines.push(
          `· 已等 ${formatDuration(now - entry.startedAt)} · ${shown} · ${idle} · ${entry.questions[0]?.header || entry.questions[0]?.question.slice(0, 24)} · ${sent}`,
        );
        if (entry.lastSend && !entry.lastSend.ok) lines.push(`  上次发送失败：${entry.lastSend.error}`);
      }
      if (lastSendLog) {
        lines.push(
          `最近一次发送（${lastSendLog.kind}，${formatDuration(Date.now() - lastSendLog.at)}前）：${lastSendLog.ok ? "成功" : `失败 ${lastSendLog.error}`}`,
        );
      }
      await ctx.ui.select("ask-reminder", lines);
    },
  });
}
