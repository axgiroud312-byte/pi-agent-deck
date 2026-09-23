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
import { initializeRun, launchRunner, readRun, runDirectory, sendToRun, shutdownRuns } from "../src/runtime.ts";
import { showAgentPanel } from "../src/ui.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

async function until<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待${label}超时`);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fixture(t: any, options: { duration?: number; role?: string; roleLimit?: number; final?: string; completed?: boolean } = {}) {
  const id = `test-opt-${randomUUID()}`;
  const directory = path.join(getAgentDir(), "fixtures", id);
  await fs.mkdir(directory, { recursive: true });
  const script = path.join(directory, "child.mjs");
  await fs.writeFile(script, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") return send({ type: "response", id: request.id, command: request.type, success: true, data: { isStreaming: false } });
  if (["set_steering_mode", "clear_queue", "abort"].includes(request.type)) return send({ type: "response", id: request.id, command: request.type, success: true, data: {} });
  if (request.type === "prompt") {
    turn += 1;
    send({ type: "response", id: request.id, command: request.type, success: true, data: {} });
    setTimeout(() => {
      const text = turn === 1 ? "FIRST_RESULT" : "SECOND_RESULT";
      send({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
      send({ type: "agent_settled" });
    }, ${options.duration ?? 50});
  }
});
lines.on("close", () => process.exit(0));
`);
  const now = Date.now();
  const run: any = {
    version: 1, autoDeliver: true, runId: id,
    agentId: options.role ?? "probe", agentName: "probe", objective: "probe", instruction: "probe", acceptanceCriteria: [],
    status: options.completed ? "已完成" : "运行中", model: "fake/model", thinking: "off", tools: [], writePermission: false,
    cwd: directory, parentSessionId: id, childSessionId: "same-child", childSessionPath: path.join(directory, "child.jsonl"),
    startedAt: now - 1000, endedAt: options.completed ? now - 100 : undefined,
    reports: [], events: [], finalText: options.final,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  await initializeRun(run, { version: 1, cwd: directory, command: process.execPath, argsPrefix: [script], prompt: "fixture", naturalOutput: true }, true);
  if (options.roleLimit) {
    const file = path.join(runDirectory(id), "request.json");
    const saved = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...saved, maxConcurrent: options.roleLimit }));
  }
  t.after(async () => {
    await shutdownRuns(id);
    await fs.rm(runDirectory(id), { recursive: true, force: true });
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { id, directory, run };
}

function host(parent: string) {
  const handlers = new Map<string, any>(), commands = new Map<string, any>(), tools = new Map<string, any>();
  const messages: any[] = [];
  const ctx: any = {
    mode: "tui", cwd: getAgentDir(), isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => parent, getBranch: () => [] },
    ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, value: string) => value } },
  };
  agentDeck({
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, value: any) => commands.set(name, value),
    registerMessageRenderer() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {},
    sendMessage: (message: any) => messages.push(message),
  } as any);
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

test("关闭后面板和兼容命令也不再启动继续任务", async (t) => {
  const f = await fixture(t, { completed: true, final: "done" });
  await writeDeckConfig({ enabled: false });
  const h = host(f.id);
  h.ctx.ui.custom = async () => ({ action: "继续", runId: f.id });
  h.ctx.ui.editor = () => { throw new Error("Disabled continuation must not open the editor"); };
  try {
    await h.commands.get("agent-continue").handler(`${f.id} continue`, h.ctx);
    await h.commands.get("agents").handler("", h.ctx);
    assert.equal((await readRun(f.id))!.status, "已完成");
    assert.equal((await readRun(f.id))!.childPid, undefined);
  } finally { await writeDeckConfig({ enabled: true }); }
});

test("配置入口编辑内置角色为个人覆盖，新任务读取有效的零时限", async () => {
  const h = host("config-edit");
  h.ctx.ui.editor = async () => "---\nid: scout\nname: 私人侦察员\nmodel: inherit\nthinking: high\ntools: Read, Grep, Glob\ntimeoutMs: 0\nmaxConcurrent: 1\n---\n只读调查。\n";
  await h.commands.get("agent-config").handler("scout --raw", h.ctx);
  const text = await fs.readFile(path.join(getAgentDir(), "agents", "scout.md"), "utf8");
  const role = parseAgentDefinition(text, "scout.md", "用户");
  assert.equal(role.timeoutMs, 0); assert.equal(role.thinking, "high"); assert.equal("maxConcurrent" in role, false);
});

test("同一非 Git 目录树和 Git 工作区的不同子目录不能同时写入", async () => {
  const root = path.join(getAgentDir(), "nested-writers");
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  const a = await acquireWriterLease(root, "nested-a"); assert.equal(a.acquired, true);
  try { assert.equal((await acquireWriterLease(path.join(root, "src"), "nested-b")).acquired, false); }
  finally { if (a.acquired) await releaseWriterLease(a.lease); }
  await fs.mkdir(path.join(root, "tests"), { recursive: true });
  execFileSync("git", ["init", "--quiet", root], { windowsHide: true });
  const b = await acquireWriterLease(path.join(root, "src"), "git-a"); assert.equal(b.acquired, true);
  try { assert.equal((await acquireWriterLease(path.join(root, "tests"), "git-b")).acquired, false); }
  finally { if (b.acquired) await releaseWriterLease(b.lease); }
});

test("不同 cwd 的只读任务超过旧全局与角色限制仍同时启动", async (t) => {
  await fs.writeFile(deckConfigPath(), JSON.stringify({ enabled: true, maxConcurrent: 1, timeoutMs: 0 }));
  const tasks = await Promise.all(Array.from({ length: 5 }, () => fixture(t, { duration: 500, role: "same-role", roleLimit: 1 })));
  await Promise.all(tasks.map((task) => launchRunner(task.id)));
  const active = await Promise.all(tasks.map((task) => until(async () => {
    const run = await readRun(task.id);
    return run?.childPid && alive(run.childPid) && run.status === "运行中" ? run : undefined;
  }, `${task.id} 启动`)));
  assert.equal(new Set(active.map((run) => run.childPid)).size, tasks.length);
  await Promise.all(tasks.map((task) => until(async () => {
    const run = await readRun(task.id);
    return run?.status === "已完成" ? run : undefined;
  }, `${task.id} 完成`)));
  await writeDeckConfig({ enabled: true });
});

test("续接任务时结果和通知都以当前 turn 为准", async (t) => {
  const f = await fixture(t);
  const h = host(f.id);
  await h.handlers.get("session_start")({}, h.ctx);
  t.after(async () => { await h.handlers.get("session_shutdown")(); });
  await launchRunner(f.id);
  const first = await until(async () => {
    const run = await readRun(f.id);
    return run?.status === "已完成" && run.finalText === "FIRST_RESULT" ? run : undefined;
  }, "第一轮结果");
  const firstTurn = first.turnId;
  await sendToRun(f.id, "继续第二轮");
  const during = await readRun(f.id);
  assert.notEqual(during?.turnId, firstTurn);
  assert.equal(during?.finalText, undefined);
  const second = await until(async () => {
    const run = await readRun(f.id);
    return run?.status === "已完成" && run.turnId !== firstTurn ? run : undefined;
  }, "第二轮结果");
  assert.equal(second.finalText, "SECOND_RESULT");
  assert.ok(h.messages.some((message) => message.details?.turnId === second.turnId && /SECOND_RESULT/.test(message.content)));
});

test("实际面板组件能显示结果、切换页面和继续，窄终端不越界", async (t) => {
  const f = await fixture(t, { completed: true, final: "panel result" });
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
