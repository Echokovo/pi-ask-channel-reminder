import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import extension, {
  buildReminderText,
  buildResolvedText,
  formatDuration,
  loadConfig,
  normalizeConfig,
  normalizeQuestions,
} from "../index.ts";

mkdirSync("/tmp/pi", { recursive: true });

const SAMPLE_QUESTIONS = [
  {
    question: "这次要发布到哪个环境？",
    header: "发布环境",
    multiSelect: false,
    options: [
      { label: "预发", description: "走预发库，可随时回滚" },
      { label: "生产", description: "直接影响线上" },
    ],
  },
];

test("formatDuration 按量级切换单位并补零", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(59_000), "59s");
  assert.equal(formatDuration(181_000), "3m01s");
  assert.equal(formatDuration(3_720_000), "1h02m");
  assert.equal(formatDuration(-5), "0s");
});

test("normalizeConfig 忽略类型错误与越界的值，回落到默认", () => {
  const cfg = normalizeConfig({
    route: "  ops  ",
    afterMs: "1000", // 类型错 → 默认
    repeatMs: -1, // 越界 → 默认
    maxReminders: 999, // 越界 → 默认
    includeDescriptions: "yes", // 类型错 → 默认
    notifyResolved: false,
  });
  assert.equal(cfg.route, "ops");
  assert.equal(cfg.afterMs, 180_000);
  assert.equal(cfg.repeatMs, 0);
  assert.equal(cfg.maxReminders, 1);
  assert.equal(cfg.includeDescriptions, false);
  assert.equal(cfg.notifyResolved, false);
  assert.equal(cfg.enabled, true);
});

test("normalizeQuestions 压平多行、跳过无问题项、保留多选标记", () => {
  const questions = normalizeQuestions([
    { question: "第一行\n第二行", header: "H", multiSelect: true, options: [{ label: "甲" }, { label: "  " }, 42] },
    { header: "没有问题文本" },
    "not-an-object",
  ]);
  assert.equal(questions.length, 1);
  assert.equal(questions[0].question, "第一行 第二行");
  assert.equal(questions[0].multiSelect, true);
  assert.deepEqual(questions[0].options.map((option) => option.label), ["甲"]);
});

test("buildReminderText 排版：题号、字母选项、多选标记、定位信息", () => {
  const cfg = normalizeConfig({});
  const text = buildReminderText(cfg, {
    questions: normalizeQuestions(SAMPLE_QUESTIONS),
    waitedMs: 181_000,
    session: "发布演练",
    cwd: "deploy",
    host: "workstation",
    reminderIndex: 1,
    reminderTotal: 1,
  });
  assert.match(text, /⏰ pi 在等你回答 · 已等 3m01s/);
  assert.match(text, /发布演练 · deploy · workstation/);
  assert.match(text, /\[发布环境\] 这次要发布到哪个环境？/);
  assert.match(text, /A\. 预发/);
  assert.match(text, /B\. 生产/);
  assert.match(text, /→ 回终端选择即可/);
  // 默认不外发选项说明
  assert.doesNotMatch(text, /走预发库/);
});

test("buildReminderText 多题编号、说明开关、无选项占位、超长截断", () => {
  const withDescriptions = buildReminderText(normalizeConfig({ includeDescriptions: true }), {
    questions: normalizeQuestions([
      SAMPLE_QUESTIONS[0],
      { question: "要不要一起跑冒烟？", header: "冒烟", multiSelect: true, options: [{ label: "要" }, { label: "不要" }] },
      { question: "自定义分支名？", header: "分支", options: [] },
    ]),
    waitedMs: 1000,
    session: "",
    cwd: "",
    host: "box",
    reminderIndex: 2,
    reminderTotal: 3,
  });
  assert.match(withDescriptions, /第 2\/3 次/);
  assert.match(withDescriptions, /1\) \[发布环境\]/);
  assert.match(withDescriptions, /3\) \[分支\]/);
  assert.match(withDescriptions, /（多选）/);
  assert.match(withDescriptions, /预发 — 走预发库，可随时回滚/);
  assert.match(withDescriptions, /（无选项，需在终端输入）/);
  // session/cwd 为空时定位行只留 host
  assert.match(withDescriptions, /^box$/m);

  const tiny = buildReminderText(normalizeConfig({ maxChars: 200 }), {
    questions: normalizeQuestions([{ question: "很长".repeat(200), header: "H", options: [{ label: "甲" }] }]),
    waitedMs: 0,
    session: "s",
    cwd: "c",
    host: "h",
    reminderIndex: 1,
    reminderTotal: 1,
  });
  assert.match(tiny, /内容过长已截断/);
  assert.ok(tiny.length < 400);
});

test("buildResolvedText 说明提醒次数与等待时长", () => {
  assert.match(buildResolvedText({ question: "发布到哪个环境？", waitedMs: 420_000, sent: 2 }), /2 次提醒/);
  assert.match(buildResolvedText({ question: "发布到哪个环境？", waitedMs: 420_000, sent: 1 }), /提醒后 7m00s/);
});

/* ── 事件接线：用假 EventBus + 假 pi-channels 走完整链路 ── */

type Send = { adapter: string; text: string; source?: string };

function harness(settings: Record<string, unknown>) {
  const home = mkdtempSync(join(process.env.TMP_ROOT ?? "/tmp/pi", "pi-ask-reminder-home-"));
  const agentDir = mkdtempSync(join(process.env.TMP_ROOT ?? "/tmp/pi", "pi-ask-reminder-agent-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "settings.json"), JSON.stringify(settings));
  process.env.HOME = home;
  process.env.PI_AGENT_DIR = agentDir;

  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const sends: Send[] = [];
  const sendResults: Array<{ ok: boolean; error?: string }> = [];
  const bus = {
    emit(channel: string, data: unknown) {
      const entry = data as { callback?: (result: unknown) => void };
      if (channel === "channel:send") {
        sends.push(data as Send);
        const result = sendResults.shift() ?? { ok: true };
        if (!result.ok) queueMicrotask(() => entry.callback?.(result));
        else entry.callback?.(result);
        return;
      }
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return () => {};
    },
  };

  const listeners: Array<{ type: string; handler: (event: any, ctx: any) => unknown }> = [];
  const pi = {
    events: bus,
    on(type: string, handler: (event: any, ctx: any) => unknown) {
      listeners.push({ type, handler });
      return () => {};
    },
    registerCommand(_name: string, _options: unknown) {},
    registerTool(_tool: unknown) {},
    getSessionName() {
      return "测试会话";
    },
    async fire(type: string, event: any = {}, ctx: any = {}) {
      for (const listener of listeners.filter((item) => item.type === type)) await listener.handler(event, ctx);
    },
  };

  extension(pi as never);
  return { pi, sends, sendResults };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("ask 超过 afterMs 未答 → 通过 channel:send 提醒；终端作答后补收尾并停表", async () => {
  const { pi, sends } = harness({ "pi-ask-reminder": { route: "ops", afterMs: 1000, notifyResolved: true } });

  await pi.fire("session_start", {}, { cwd: process.cwd(), isProjectTrusted: () => false, ui: { setStatus() {} } });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-1", questions: SAMPLE_QUESTIONS });

  assert.equal(sends.length, 0, "未到延时不应发送");
  await wait(1300);
  assert.equal(sends.length, 1, "超时后应发一条提醒");
  assert.equal(sends[0].adapter, "ops");
  assert.equal(sends[0].source, "pi-ask-reminder");
  assert.match(sends[0].text, /A\. 预发/);
  assert.match(sends[0].text, /测试会话/);

  // 作答后 blocked 先关，tool_execution_end 再兜底：收尾消息只能有一条
  pi.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "call-1" });
  await pi.fire("tool_execution_end", { type: "tool_execution_end", toolCallId: "call-1", toolName: "ask_user_question" });
  await wait(50);
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /✅ pi 的问题已处理/);

  await wait(1200);
  assert.equal(sends.length, 2, "已收口后不应再发，也不应重复收尾");
});

test("无 toolCallId 的 blocked 事件把所有等待收口，且 notifyResolved 关闭时不发收尾", async () => {
  const { pi, sends } = harness({ "pi-ask-reminder": { route: "ops", afterMs: 1000, notifyResolved: false } });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-a", questions: SAMPLE_QUESTIONS });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-b", questions: SAMPLE_QUESTIONS });
  pi.events.emit("rpiv:ask-user:blocked", { active: false });
  await wait(1300);
  assert.equal(sends.length, 0);
});

test("重复提醒按 repeatMs 续期，达到 maxReminders 后停止", async () => {
  const { pi, sends } = harness({
    "pi-ask-reminder": { route: "ops", afterMs: 1000, repeatMs: 1000, maxReminders: 2, notifyResolved: false },
  });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-r", questions: SAMPLE_QUESTIONS });
  await wait(1300);
  assert.equal(sends.length, 1);
  assert.match(sends[0].text, /第 1\/2 次/);
  await wait(1000);
  assert.equal(sends.length, 2);
  assert.match(sends[1].text, /第 2\/2 次/);
  await wait(1300);
  assert.equal(sends.length, 2, "达到上限后不再提醒");
});

test("enabled=false 时完全不监听", async () => {
  const { pi, sends } = harness({ "pi-ask-reminder": { enabled: false, afterMs: 1000 } });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-off", questions: SAMPLE_QUESTIONS });
  await wait(1300);
  assert.equal(sends.length, 0);
});

test("发送失败时不发收尾消息，也不谎报成功", async () => {
  const { pi, sends, sendResults } = harness({
    "pi-ask-reminder": { route: "ghost", afterMs: 1000, notifyResolved: true },
  });
  sendResults.push({ ok: false, error: 'No adapter "ghost"' });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-fail", questions: SAMPLE_QUESTIONS });
  await wait(1300);
  assert.equal(sends.length, 1);
  pi.events.emit("rpiv:ask-user:blocked", { active: false, toolCallId: "call-fail" });
  await wait(50);
  assert.equal(sends.length, 1, "一条都没送达时不应发「已处理」");
});

test("项目设置（已信任）覆盖 agent 目录设置", async () => {
  const project = mkdtempSync(join(process.env.TMP_ROOT ?? "/tmp/pi", "pi-ask-reminder-project-"));
  mkdirSync(join(project, ".pi"), { recursive: true });
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ "pi-ask-reminder": { route: "private-chat" } }));
  const { pi, sends } = harness({ "pi-ask-reminder": { route: "ops", afterMs: 1000, notifyResolved: false } });

  await pi.fire("session_start", {}, { cwd: project, isProjectTrusted: () => true, ui: { setStatus() {} } });
  pi.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-proj", questions: SAMPLE_QUESTIONS });
  await wait(1300);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].adapter, "private-chat");

  // 未信任的项目设置不生效，回落到 agent 目录的 route
  const { pi: untrusted, sends: untrustedSends } = harness({ "pi-ask-reminder": { route: "ops", afterMs: 1000 } });
  await untrusted.fire("session_start", {}, { cwd: project, isProjectTrusted: () => false, ui: { setStatus() {} } });
  untrusted.events.emit("rpiv:ask-user:prompt", { toolCallId: "call-untrusted", questions: SAMPLE_QUESTIONS });
  await wait(1300);
  assert.equal(untrustedSends[0]?.adapter, "ops");
});

test("loadConfig 对坏 JSON 与缺失文件保持默认值", () => {
  // 清掉前面用例留下的 HOME / PI_AGENT_DIR，让这次只看到空设置与坏 JSON。
  const blankHome = mkdtempSync(join(process.env.TMP_ROOT ?? "/tmp/pi", "pi-ask-reminder-blank-home-"));
  mkdirSync(join(blankHome, ".pi", "agent"), { recursive: true });
  process.env.HOME = blankHome;
  delete process.env.PI_AGENT_DIR;
  const dir = mkdtempSync(join(process.env.TMP_ROOT ?? "/tmp/pi", "pi-ask-reminder-bad-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "settings.json"), "{ this is not json");
  assert.equal(loadConfig(dir, true).route, "ops");
  assert.equal(loadConfig("/does/not/exist", false).afterMs, 180_000);
});
