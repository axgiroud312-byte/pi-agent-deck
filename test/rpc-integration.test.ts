import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as runtime from "../src/runtime.ts";
import { taskOutput, resultMessage } from "../src/delivery.ts";
import { showAgentPanel } from "../src/ui.ts";
import { conversationBlocks } from "../src/conversation.ts";
import { activeRunCount } from "../src/run-capacity.ts";
import { discoverAgents } from "../src/agents.ts";
import { roleCapabilities } from "../src/capabilities.ts";

const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = path.join(path.dirname(piMain), "bundle", "cli.js");
const providerExtension = fileURLToPath(new URL("./fixtures/rpc-faux-provider.ts", import.meta.url));
const childExtension = fileURLToPath(new URL("../src/child-runtime.ts", import.meta.url));

async function until<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 ${label} 超时`);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function lines(file: string): Promise<any[]> {
  try { return (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function createRun(t: any, prompt: string, tools = ["agent_report"]) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-real-rpc-"));
  const runId = `rpc-integration-${randomUUID()}`;
  const parentSessionId = randomUUID();
  const childSessionId = randomUUID();
  const childManager = SessionManager.create(cwd, undefined, { id: childSessionId });
  childManager.appendSessionInfo(`real RPC fixture ${runId}`);
  const childSessionPath = childManager.getSessionFile();
  assert.ok(childSessionPath);
  await fs.writeFile(childSessionPath, [childManager.getHeader(), ...childManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const log = path.join(cwd, "provider.jsonl");
  const turnId = randomUUID();
  const startedAt = Date.now();
  const details: any = {
    version: 1, autoDeliver: true, runId, turnId,
    agentId: "scout", agentName: "local RPC fixture", agentSource: "内置",
    objective: prompt, instruction: prompt, acceptanceCriteria: [],
    status: "运行中", model: "deck-local-fixture/scripted", thinking: "off", tools: ["agent_report"],
    writePermission: false, parentSessionId, childSessionId, childSessionPath, cwd, startedAt,
    reports: [], events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const runDir = runtime.runDirectory(runId);
  await fs.mkdir(runDir, { recursive: true });
  await runtime.initializeRun(details, {
    version: 1, cwd, command: process.execPath,
    argsPrefix: [piCli, "--mode", "rpc", "--session", childSessionPath,
      "--model", details.model, "--thinking", details.thinking,
      "--no-extensions", "--extension", providerExtension, "--extension", childExtension,
      "--tools", tools.join(",")],
    prompt, naturalOutput: true, timeoutMs: 0,
    env: {
      PI_AGENT_DECK_SIMPLE: "1", PI_AGENT_DECK_RUN_ID: runId,
      PI_AGENT_DECK_FIXTURE_LOG: log,
    },
  } as any, true);
  t.after(async () => {
    try { await runtime.stopRun(runId); } catch { /* already settled */ }
    const shutdown = (runtime as any).shutdownRuns;
    if (typeof shutdown === "function") await shutdown(parentSessionId);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { runId, parentSessionId, childSessionId, childSessionPath, cwd, log };
}

test("真实 Pi RPC：补充、结构结果、释放、空闲不启动及明确原会话 resume", async (t) => {
  const fixture = await createRun(t, "DECK_TOOL_CASE", ["deck_pause", "agent_report"]);
  await runtime.launchRunner(fixture.runId);
  const live = await until(async () => (await lines(fixture.log)).some((item) => item.type === "long_tool_start") ? runtime.readRun(fixture.runId) : undefined, "工具开始");
  await assert.rejects(runtime.resumeRun(fixture.runId, "不得并行恢复"), /运行/);
  await runtime.sendToRun(fixture.runId, "DECK_EARLY_STEER");
  const result = await until(async () => { const r = await runtime.readRun(fixture.runId); return r?.resourceState === "released" ? r : undefined; }, "返回结果并释放");
  assert.equal(result.status, "已完成");
  assert.equal(result.result?.outcome, "完成");
  assert.equal(alive(live.childPid), false);
  assert.equal(activeRunCount(fixture.parentSessionId), 0);
  const calls = (await lines(fixture.log)).filter((item) => item.type === "provider_call");
  assert.equal(calls.length, 2, "最终报告结束执行，无额外总结模型调用");
  assert.match(calls[1].transcript, /DECK_EARLY_STEER/);
  const sessionBefore = await fs.readFile(fixture.childSessionPath, "utf8");
  const view = conversationBlocks(result, true).map((block) => block.text).join("\n");
  assert.match(view, /DECK_TOOL_CASE/); assert.match(view, /工具调用：deck_pause/); assert.match(view, /tool completed/);
  const actions: unknown[] = [];
  await showAgentPanel({ mode: "tui", sessionManager: { getSessionId: () => fixture.parentSessionId }, ui: { custom: async (factory: any) => {
    const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value };
    const component = factory({ terminal: { rows: 48 }, requestRender() {} }, theme, undefined, (action: unknown) => actions.push(action));
    try {
      const list = component.render(120).join("\n");
      assert.match(list, /进程已释放/);
      component.handleInput("\r"); component.handleInput("\u001b[H");
      const screen = component.render(120).join("\n");
      assert.match(screen, /子会话 · 只读/); assert.match(screen, /DECK_TOOL_CASE/);
      for (const key of ["c", "m", "a"]) component.handleInput(key);
      assert.deepEqual(actions, []);
      if (process.env.PI_AGENT_DECK_EVIDENCE_DIR) {
        await fs.mkdir(process.env.PI_AGENT_DECK_EVIDENCE_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.PI_AGENT_DECK_EVIDENCE_DIR, "tui-session.txt"), "真实 Pi RPC 本地模型会话，经实际 TUI 组件渲染\n\n" + list + "\n\n" + screen);
      }
    } finally { component.dispose(); }
    return { action: "关闭" };
  } } } as any);
  assert.equal(await fs.readFile(fixture.childSessionPath, "utf8"), sessionBefore, "查看不写入会话");
  const deferred = await runtime.sendToRun(fixture.runId, "DECK_IDLE_INFORMATION");
  assert.equal(deferred.delivery, "deferred");
  assert.equal(deferred.run.resourceState, "released");
  assert.equal(activeRunCount(fixture.parentSessionId), 0);
  assert.equal((await lines(fixture.log)).filter((item) => item.type === "provider_call").length, 2);
  await runtime.resumeRun(fixture.runId, "DECK_CONTINUE_CASE", "补充验证");
  const resumed = await until(async () => { const r = await runtime.readRun(fixture.runId); return r?.resourceState === "released" && r.turnId !== result.turnId ? r : undefined; }, "resume 完成");
  assert.equal(resumed.childSessionId, fixture.childSessionId);
  assert.equal(resumed.childSessionPath, fixture.childSessionPath);
  assert.equal(resumed.description, "补充验证");
  const last = (await lines(fixture.log)).filter((item) => item.type === "provider_call").at(-1);
  assert.match(last.transcript, /DECK_TOOL_CASE/); assert.match(last.transcript, /DECK_IDLE_INFORMATION/);
  assert.equal(resumed.queuedMessageCount, 0);
});

test("真实 Pi RPC：停止会中断本地模型并清空待发送消息", async (t) => {
  const fixture = await createRun(t, "DECK_STOP_CASE");
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await lines(fixture.log)).some((entry) => entry.type === "provider_call") ? true : undefined, "待中止的本地模型调用");
  await runtime.sendToRun(fixture.runId, "DECK_QUEUED_BEFORE_STOP");
  const stopped = await runtime.stopRun(fixture.runId);
  assert.ok(["已停止", "已取消"].includes(stopped.status));
  await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run && !alive(run.runnerPid) && !alive(run.childPid) ? run : undefined;
  }, "停止进程");
  const calls = (await lines(fixture.log)).filter((entry) => entry.type === "provider_call");
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((entry) => String(entry.transcript).includes("DECK_QUEUED_BEFORE_STOP")));
});

test("真实 Pi RPC：长工具调用后接收 QueueOnly 补充，同一次执行结束", async (t) => {
  const fixture = await createRun(t, "DECK_TOOL_CASE", ["deck_pause", "agent_report"]);
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await lines(fixture.log)).some((entry) => entry.type === "long_tool_start") ? true : undefined, "长工具开始");
  const turn = (await runtime.readRun(fixture.runId))!.turnId;
  await runtime.sendToRun(fixture.runId, "AT_TOOL_BOUNDARY");
  const completed = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.resourceState === "released" ? run : undefined;
  }, "工具边界收消息后完成");
  assert.equal(completed.turnId, turn);
  const calls = (await lines(fixture.log)).filter((entry) => entry.type === "provider_call");
  assert.equal(calls.length, 2);
  assert.match(calls[1].transcript, /AT_TOOL_BOUNDARY/);
});

test("真实 Pi RPC：角色目录与模型实际可调用工具一致", async (t) => {
  const agents = discoverAgents(process.cwd(), { projectTrusted: false });
  for (const role of ["worker", "scout", "reviewer"]) {
    const tools = roleCapabilities(agents.find((agent) => agent.id === role)!).tools;
    const fixture = await createRun(t, "DECK_CAPABILITY_CASE", tools);
    await runtime.launchRunner(fixture.runId);
    await until(async () => (await runtime.readRun(fixture.runId))?.resourceState === "released" ? true : undefined, `${role} 完成`);
    const call = (await lines(fixture.log)).find((entry) => entry.type === "active_tools");
    assert.deepEqual(call.tools.sort(), [...tools].sort(), `${role} 能力不能夸大或隐式继承`);
  }
});

test("真实 Pi RPC：阻塞直接返回，无提问工具、无等待进程", async (t) => {
  const fixture = await createRun(t, "DECK_BLOCK_CASE");
  await runtime.launchRunner(fixture.runId);
  const result = await until(async () => { const r = await runtime.readRun(fixture.runId); return r?.resourceState === "released" ? r : undefined; }, "阻塞返回");
  assert.equal(result.result?.outcome, "阻塞");
  assert.equal(result.pendingQuestion, undefined);
  assert.equal(activeRunCount(fixture.parentSessionId), 0);
  assert.match(taskOutput(result), /主 Agent 需要处理范围决定/);
  const call = (await lines(fixture.log)).find((item) => item.type === "active_tools");
  assert.ok(!call.tools.includes("agent_question"));
});

test("真实 Pi RPC：结果保存失败仍释放进程、通知真实错误", async (t) => {
  const fixture = await createRun(t, "DECK_TOOL_CASE", ["deck_pause", "agent_report"]);
  await fs.writeFile(path.join(runtime.runDirectory(fixture.runId), "results"), "故障注入：阻止创建结果目录");
  const notices: any[] = [];
  const unsubscribe = runtime.subscribeRunEvents((event) => { if (event.kind === "result" && event.run.runId === fixture.runId) notices.push(event); });
  t.after(unsubscribe);
  await runtime.launchRunner(fixture.runId);
  const result = await until(async () => { const r = await runtime.readRun(fixture.runId); return r?.resourceState === "released" ? r : undefined; }, "故障后清理");
  assert.equal(result.childPid, undefined); assert.equal(activeRunCount(fixture.parentSessionId), 0);
  assert.match(result.persistenceError ?? "", /保存失败/);
  assert.match(resultMessage(result, fixture.parentSessionId)!.content, /保存失败/);
  await until(async () => notices.length === 1 ? true : undefined, "结果通知");
});

test("真实 Pi RPC：会话丢失时 resume 明确报错，不创建空白替代", async (t) => {
  const fixture = await createRun(t, "DECK_BLOCK_CASE");
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await runtime.readRun(fixture.runId))?.resourceState === "released" ? true : undefined, "完成");
  await fs.unlink(fixture.childSessionPath);
  await assert.rejects(runtime.resumeRun(fixture.runId, "继续"), /子会话不存在/);
  assert.equal(activeRunCount(fixture.parentSessionId), 0);
});

test("真实 Pi RPC：模型失败和中断不会冒充完成，并自动释放资源", async (t) => {
  for (const [prompt, status] of [["DECK_FAILURE_CASE", "失败"], ["DECK_ABORTED_CASE", "已停止"]]) {
    const fixture = await createRun(t, prompt);
    await runtime.launchRunner(fixture.runId);
    const result = await until(async () => {
      const run = await runtime.readRun(fixture.runId);
      return run?.resourceState === "released" ? run : undefined;
    }, `${prompt} 结束`);
    assert.equal(result.status, status);
    if (status === "失败") { assert.match(taskOutput(result), /原因：/); assert.match(taskOutput(result), /尚未验证/); }
    assert.equal(result.childPid, undefined);
    assert.equal(activeRunCount(fixture.parentSessionId), 0);
  }
});


test("只读会话查看折叠长工具参数和输出，展开后仍保留原文", async (t) => {
  const fixture = await createRun(t, "只读显示测试");
  const records = await fs.readFile(fixture.childSessionPath, "utf8");
  const tail = "UNIQUE_TOOL_TAIL";
  const assistant = { type: "message", id: "large-call", parentId: null, timestamp: new Date().toISOString(), message: {
    role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "large", name: "write", arguments: { path: "demo.ts", content: "x".repeat(1000) + tail } }], stopReason: "toolUse",
  } };
  await fs.appendFile(fixture.childSessionPath, JSON.stringify(assistant) + "\n");
  const run = (await runtime.readRun(fixture.runId))!;
  assert.match(conversationBlocks(run).map((block) => block.text).join(""), /已折叠/);
  assert.doesNotMatch(conversationBlocks(run).map((block) => block.text).join(""), new RegExp(tail));
  assert.match(conversationBlocks(run, true).map((block) => block.text).join(""), new RegExp(tail));
  assert.equal(await fs.readFile(fixture.childSessionPath, "utf8"), records + JSON.stringify(assistant) + "\n");
  assert.equal((await runtime.readRun(fixture.runId))?.childPid, undefined);
});
