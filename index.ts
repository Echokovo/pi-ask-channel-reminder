/**
 * pi-ask-channel-reminder
 *
 * 当 `ask_user_question` 长时间无人回答时，通过 pi-channels（飞书 / 钉钉 / 企微 / webhook）
 * 给自己发一条提醒。只做提醒，不代答：回答仍然在终端完成。
 *
 * 依赖两个既有扩展的公开事件，运行期不 import 它们（事件名按各自契约硬编码）：
 *
 *   rpiv:ask-user:prompt    { toolCallId, questions[] }   ask 问题内容，弹框前发出
 *   rpiv:ask-user:blocked   { active, toolCallId }        等待人回答的括号（finally 关）
 *   channel:send            { adapter, text, callback }   交给 pi-channels 出站
 *
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
  /** 提醒已发出后问题在终端被解决时，补一条收尾消息。 */
  notifyResolved: boolean;
};

const DEFAULTS: Config = {
  enabled: true,
  route: "ops",
  afterMs: 180000,
  repeatMs: 0,
  maxReminders: 1,
  includeDescriptions: false,
  maxChars: 1500,
  notifyResolved: true,
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
function bool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}
function str(raw: unknown, fallback: string): string {
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

export function normalizeConfig(raw: Record<string, unknown>): Config {
  return {
    enabled: bool(raw.enabled, DEFAULTS.enabled),
    route: str(raw.route, DEFAULTS.route),
    afterMs: num(raw.afterMs, DEFAULTS.afterMs, 1000, 86400000),
    repeatMs: num(raw.repeatMs, DEFAULTS.repeatMs, 0, 86400000),
    maxReminders: num(raw.maxReminders, DEFAULTS.maxReminders, 1, 20),
    includeDescriptions: bool(raw.includeDescriptions, DEFAULTS.includeDescriptions),
    maxChars: num(raw.maxChars, DEFAULTS.maxChars, 200, 4000),
    notifyResolved: bool(raw.notifyResolved, DEFAULTS.notifyResolved),
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

export function buildResolvedText(input: { question: string; waitedMs: number; sent: number }): string {
  const who = input.sent > 1 ? `${input.sent} 次提醒` : "提醒";
  return `✅ pi 的问题已处理（${who}后 ${formatDuration(input.waitedMs)} 时作答）：${input.question}`;
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

  function setStatus(): void {
    try {
      lastCtx?.ui.setStatus(STATUS_KEY, pending.size > 0 ? `⏳ 待回答 ${pending.size}` : undefined);
    } catch {
      // 非交互模式下没有 footer，忽略。
    }
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
    if (entry.timer) clearTimeout(entry.timer);
    const timer = setTimeout(() => {
      entry.timer = undefined;
      void fire(entry);
    }, delayMs);
    timer.unref?.();
    entry.timer = timer;
  }

  async function fire(entry: Pending): Promise<void> {
    if (!pending.has(entry.toolCallId)) return; // 等待期间已解决
    const text = buildReminderText(cfg, {
      questions: entry.questions,
      waitedMs: Date.now() - entry.startedAt,
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
    } else {
      entry.failures += 1;
    }
    if (entry.sent >= cfg.maxReminders) return;
    if (entry.failures > SEND_MAX_FAILURES) return; // 通道明显不通，交给 /ask-reminder status 看
    if (result.ok && cfg.repeatMs > 0) {
      schedule(entry, cfg.repeatMs);
      return;
    }
    if (!result.ok) schedule(entry, SEND_RETRY_DELAY_MS);
  }

  function close(toolCallId: string, reason: "resolved" | "shutdown"): void {
    const entry = pending.get(toolCallId);
    if (!entry) return;
    pending.delete(toolCallId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    setStatus();
    if (reason !== "shutdown" && entry.sent > 0 && cfg.notifyResolved) {
      void send(buildResolvedText({
        question: entry.questions[0]?.question ?? "问题",
        waitedMs: Date.now() - entry.startedAt,
        sent: entry.sent,
      }));
    }
  }

  pi.events.on(ASK_PROMPT_EVENT, (data: unknown) => {
    if (!cfg.enabled || !isRecord(data)) return;
    const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
    const questions = normalizeQuestions(data.questions);
    if (!toolCallId || questions.length === 0 || pending.has(toolCallId)) return;
    const entry: Pending = {
      toolCallId,
      questions,
      startedAt: Date.now(),
      sent: 0,
      failures: 0,
      timer: undefined,
      lastSend: undefined,
    };
    pending.set(toolCallId, entry);
    debug("prompt", { toolCallId, questions: questions.length, inMs: cfg.afterMs, route: cfg.route });
    schedule(entry, cfg.afterMs);
    setStatus();
  });

  pi.events.on(ASK_BLOCKED_EVENT, (data: unknown) => {
    if (!isRecord(data)) return;
    if (data.active === true) return;
    if (typeof data.toolCallId === "string") {
      close(data.toolCallId, "resolved");
      return;
    }
    // 早期版本或异常载荷没带 toolCallId：全部收口，宁可少提醒也不要提醒过期问题。
    for (const toolCallId of [...pending.keys()]) close(toolCallId, "resolved");
  });

  // 兜底：ask 调用以任何方式结束（含没发 blocked{false} 的主机）都收口。
  pi.on("tool_execution_end", (event) => {
    if (event.toolName === ASK_TOOL_NAME) close(event.toolCallId, "resolved");
  });

  pi.on("session_start", (_event, ctx) => {
    lastCtx = ctx;
    cfg = loadConfig(ctx.cwd, safeTrusted(ctx));
    setStatus();
  });

  pi.on("before_agent_start", (_event, ctx) => {
    lastCtx = ctx;
  });

  pi.on("session_shutdown", () => {
    for (const toolCallId of [...pending.keys()]) close(toolCallId, "shutdown");
  });

  pi.registerCommand("ask-reminder", {
    description: "ask 超时提醒：status | test | reload",
    getArgumentCompletions: (prefix: string) => {
      const options = ["status", "test", "reload"].filter((name) => name.startsWith(prefix.trim()));
      return options.length > 0 ? options.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args: string, ctx: ExtensionContext) => {
      lastCtx = ctx;
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
        `带选项说明 ${cfg.includeDescriptions ? "是" : "否"} · 收尾消息 ${cfg.notifyResolved ? "是" : "否"} · 长度上限 ${cfg.maxChars}`,
        `等待中的问题：${pending.size}`,
      ];
      for (const entry of pending.values()) {
        const sent = entry.sent > 0 ? `已提醒 ${entry.sent} 次` : "尚未提醒";
        lines.push(
          `· ${formatDuration(Date.now() - entry.startedAt)} · ${entry.questions[0]?.header || entry.questions[0]?.question.slice(0, 24)} · ${sent}`,
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
