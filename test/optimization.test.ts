import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import agentDeck from "../src/index.ts";
import { parseDeckConfig, readDeckConfig, writeDeckConfig, DEFAULT_CONFIG, deckConfigPath } from "../src/config.ts";
import { parseAgentDefinition, validateAgentDefinition } from "../src/agents.ts";
import { acquireWriterLease, releaseWriterLease } from "../src/admission.ts";
import { initializeRun, launchRunner, readRun, runDirectory, reconcileRun, stopRun } from "../src/runtime.ts";
import { alive, persistCompletion } from "../src/persistence.mjs";
import { showAgentPanel } from "../src/ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

async function fixture(options: { duration?: number; role?: string; roleLimit?: number; final?: string; completed?: boolean } = {}) {
  const id = `test-opt-${randomUUID()}`;
  const directory = path.join(getAgentDir(), "fixtures", id);
  await fs.mkdir(directory, { recursive: true });
  const script = path.join(directory, "child.mjs");
  await fs.writeFile(script, `setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'SECOND_RESULT'}]}})),${options.duration ?? 200});`);
  const now = Date.now();
  const run: any = { version: 1, autoDeliver: true, runId: id, agentId: options.role ?? "probe", agentName: "probe", objective: "probe", instruction: "probe", status: options.completed ? "已完成" : "运行中", model: "fake/model", thinking: "off", tools: [], writePermission: false, cwd: directory, parentSessionId: id, childSessionId: "same-child", childSessionPath: path.join(directory, "child.jsonl"), startedAt: now - 1000, endedAt: options.completed ? now - 100 : undefined, reports: [], events: [], finalText: options.final, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  await initializeRun(run, { version: 1, cwd: directory, command: process.execPath, argsPrefix: [script], prompt: "fixture", naturalOutput: true }, true);
  if (options.roleLimit) {
    const file = path.join(runDirectory(id), "request.json");
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...saved, maxConcurrent: options.roleLimit }));
  }
  return { id, directory, run };
}
async function settled(id: string) {
  for (let i = 0; i < 200; i++) {
    const run = await readRun(id);
    if (run && ["已完成", "失败", "已停止"].includes(run.status) && !alive(run.runnerPid) && !alive(run.childPid)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fixture did not settle");
}
function host(parent: string, entries: any[] = []) {
  const handlers = new Map<string, any>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const messages: any[] = [];
  const ctx: any = { mode: "tui", cwd: getAgentDir(), isProjectTrusted: () => false, sessionManager: { getSessionId: () => parent, getBranch: () => entries }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, value: string) => value } } };
  agentDeck({ on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, value: any) => commands.set(name, value), registerMessageRenderer() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {}, sendMessage: (message: any) => messages.push(message) } as any);
  return { handlers, commands, messages, ctx };
}

test("角色配置支持继承、工具别名和禁用列表，0 时限生效，错误字段不静默忽略", () => {
  const role = parseAgentDefinition("---\nname: Researcher\nmodel: inherit\nthinking: inherit\ntools: Read, Grep, Glob, Bash\ndisallowedTools: Bash\ntimeoutMs: 0\nmaxConcurrent: 2\n---\nInvestigate.", "researcher.md", "用户");
  assert.equal(role.model, undefined); assert.equal(role.thinking, undefined);
  assert.equal(role.timeoutMs, 0); assert.equal("maxConcurrent" in role, false);
  assert.deepEqual(role.tools, ["read", "grep", "find"]); assert.equal(role.writePermission, false);
  assert.deepEqual(validateAgentDefinition(role), []);
  const bad = parseAgentDefinition("---\npermissionMode: bypassPermissions\nmodel: opus\ntimeoutMs: -1\n---\nInvestigate.", "bad.md", "用户");
  assert.ok(validateAgentDefinition(bad).some((error) => error.includes("permissionMode")));
  assert.ok(validateAgentDefinition(bad).some((error) => error.includes("provider/model")));
  assert.ok(validateAgentDefinition(bad).some((error) => error.includes("timeoutMs")));
});

test("旧数量限制被忽略，切换派遣开关不丢失选配设置", async () => {
  assert.equal("maxConcurrent" in parseDeckConfig({ maxConcurrent: 0 }), false);
  await writeDeckConfig({ enabled: true, timeoutMs: 0 });
  const h = host("config-toggle");
  await h.commands.get("agent-deck").handler("", h.ctx);
  assert.deepEqual(readDeckConfig(), { ...DEFAULT_CONFIG, enabled: false });
  await h.commands.get("agent-deck").handler("", h.ctx);
  assert.equal(readDeckConfig().enabled, true);
});

test("关闭后面板和兼容命令也不再启动继续任务", async () => {
  const f = await fixture({ completed: true, final: "done" });
  await writeDeckConfig({ enabled: false });
  const h = host(f.id);
  h.ctx.ui.custom = async () => ({ action: "继续", runId: f.id });
  h.ctx.ui.editor = () => { throw new Error("Disabled continuation must not open the editor"); };
  try {
    await h.commands.get("agent-continue").handler(`${f.id} continue`, h.ctx);
    await h.commands.get("agents").handler("", h.ctx);
    assert.equal((await readRun(f.id))!.status, "已完成");
    assert.equal((await readRun(f.id))!.runnerPid, undefined);
  } finally { await writeDeckConfig({ enabled: true }); }
});

test("配置入口编辑内置角色为个人覆盖，新任务读取有效的零时限", async () => {
  const h = host("config-edit");
  h.ctx.ui.editor = async () => "---\nid: scout\nname: 私人侦察员\nmodel: inherit\nthinking: low\ntools: Read, Grep, Glob\ntimeoutMs: 0\nmaxConcurrent: 1\n---\n只读调查。\n";
  await h.commands.get("agent-config").handler("scout --raw", h.ctx);
  const text = await fs.readFile(path.join(getAgentDir(), "agents", "scout.md"), "utf8");
  const role = parseAgentDefinition(text, "scout.md", "用户");
  assert.equal(role.timeoutMs, 0); assert.equal(role.thinking, "low"); assert.equal("maxConcurrent" in role, false);
});

test("同一非 Git 目录树和 Git 工作区的不同子目录不能同时写入", async () => {
  const root = path.join(getAgentDir(), "nested-writers");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const a = await acquireWriterLease(root, "nested-a"); assert.equal(a.acquired, true);
  try { assert.equal((await acquireWriterLease(path.join(root, "src"), "nested-b")).acquired, false); }
  finally { if (a.acquired) await releaseWriterLease(a.lease); }
  await fs.mkdir(path.join(root, "tests"));
  execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
  const b = await acquireWriterLease(path.join(root, "src"), "git-a"); assert.equal(b.acquired, true);
  try { assert.equal((await acquireWriterLease(path.join(root, "tests"), "git-b")).acquired, false); }
  finally { if (b.acquired) await releaseWriterLease(b.lease); }
});

test("真实后台只读任务超过旧全局与角色限制仍同时启动", async () => {
  await fs.writeFile(deckConfigPath(), JSON.stringify({ enabled: true, maxConcurrent: 1, timeoutMs: 0 }));
  const tasks = await Promise.all(Array.from({ length: 5 }, () => fixture({ duration: 1800, role: "same-role", roleLimit: 1 })));
  try {
    const pids = await Promise.all(tasks.map((task) => launchRunner(task.id)));
    assert.ok(pids.every((pid) => pid > 0));
    const runs = await Promise.all(tasks.map((task) => readRun(task.id)));
    assert.ok(runs.every((run) => run!.status === "运行中" && alive(run!.runnerPid)));
    await Promise.all(tasks.map((task) => settled(task.id)));
  } finally {
    await Promise.all(tasks.map((task) => stopRun(task.id)));
    await writeDeckConfig({ enabled: true });
  }
});

test("主会话忙时排队结果，自动继续后重启仍补送两轮，持久化回执去重", async () => {
  const f = await fixture({ final: "FIRST_RESULT", completed: true });
  await fs.writeFile(path.join(runDirectory(f.id), "follow-up.json"), JSON.stringify(["continue"]));
  const first = host(f.id);
  try { await first.handlers.get("session_start")({}, first.ctx); }
  finally { first.handlers.get("session_shutdown")(); }
  assert.equal(first.messages.length, 1); assert.match(first.messages[0].content, /FIRST_RESULT/);
  await settled(f.id);
  const restarted = host(f.id);
  try { await restarted.handlers.get("session_start")({}, restarted.ctx); }
  finally { restarted.handlers.get("session_shutdown")(); }
  assert.equal(restarted.messages.length, 2);
  assert.match(restarted.messages[0].content, /FIRST_RESULT/); assert.match(restarted.messages[1].content, /SECOND_RESULT/);
  const receipts = restarted.messages.map((message) => ({ type: "custom_message", ...message }));
  const received = host(f.id, receipts);
  try { await received.handlers.get("session_start")({}, received.ctx); assert.equal(received.messages.length, 0); }
  finally { received.handlers.get("session_shutdown")(); }
  const wrong = host("another-parent");
  try { await wrong.handlers.get("session_start")({}, wrong.ctx); assert.equal(wrong.messages.length, 0); }
  finally { wrong.handlers.get("session_shutdown")(); }
});

test("结果已落盘但状态尚未更新时恢复结果，不误标失联", async () => {
  const f = await fixture();
  const past = Date.now() - 30000;
  const run = { ...f.run, startedAt: past, attemptStartedAt: past };
  await fs.writeFile(path.join(runDirectory(f.id), "status.json"), JSON.stringify(run));
  await persistCompletion(runDirectory(f.id), { ...run, status: "已完成", endedAt: Date.now(), finalText: "durable result" });
  const restored = await reconcileRun(f.id);
  assert.equal(restored!.status, "已完成"); assert.equal(restored!.finalText, "durable result");
});

test("父会话取消导致内存队列清空后，无需重启也能补送结果", async () => {
  const f = await fixture({ completed: true, final: "queued result" });
  const h = host(f.id);
  let idle = false;
  h.ctx.isIdle = () => idle;
  h.ctx.hasPendingMessages = () => !idle;
  try {
    await h.handlers.get("session_start")({}, h.ctx);
    assert.equal(h.messages.length, 1);
    idle = true;
    for (let i = 0; i < 50 && h.messages.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(h.messages.length, 2);
    assert.equal(h.messages[0].details.deliveryId, h.messages[1].details.deliveryId);
  } finally { h.handlers.get("session_shutdown")(); }
});

test("实际面板组件能显示结果、切换页面和继续，窄终端不越界", async () => {
  const f = await fixture({ completed: true, final: "panel result" });
  const h = host(f.id);
  let action: any;
  h.ctx.ui.custom = async (factory: any) => {
    const component = factory({ requestRender() {} }, { fg: (_: string, value: string) => value, bold: (value: string) => value }, undefined, (value: any) => { action = value; });
    try {
      assert.ok(component.render(80).join("\n").includes("已返回结果"));
      component.handleInput("\r");
      for (const page of ["1", "2", "3"]) {
        component.handleInput(page);
        for (const width of [1, 10, 40, 80]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
      }
      component.handleInput("c");
      assert.deepEqual(action, { action: "继续", runId: f.id });
    } finally { component.dispose(); }
    return { action: "关闭" };
  };
  await showAgentPanel(h.ctx);
});
