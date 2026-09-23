import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import agentDeck from "../src/index.ts";
import { initializeRun, launchRunner, readRun, continueRun, startFollowUp, runDirectory, stopRun } from "../src/runtime.ts";

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await new Promise((r) => setTimeout(r, 50)); }
  throw new Error("任务流程测试超时");
}
function alive(pid?: number) { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } }
async function settled(id: string) {
  await until(async () => { const r = await readRun(id); return !!r && ["已完成", "失败", "已停止"].includes(r.status) && !alive(r.runnerPid) && !alive(r.childPid); });
}
async function fixture(cwd: string, write: boolean, source?: string) {
  const id = `test-flow-${randomUUID()}`;
  const script = path.join(cwd, `${id}.mjs`);
  await fs.writeFile(script, source ?? `setTimeout(()=>console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:process.argv.at(-1)}]}})),250);`);
  const run: any = { version: 1, runId: id, agentId: "test", agentName: "fixture", objective: "测试任务", instruction: "initial", status: "运行中", model: "fake/model", thinking: "off", tools: [], writePermission: write, cwd, parentSessionId: "flow-parent", childSessionId: "same-session", childSessionPath: path.join(cwd, "session.jsonl"), startedAt: Date.now(), reports: [], events: [], autoDeliver: true, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  await initializeRun(run, { version: 1, cwd, command: process.execPath, argsPrefix: [script], prompt: "initial", naturalOutput: true }, true);
  return id;
}

test("写任务排队后可启动；补充要求持久化并复用原会话；停止取消排队要求", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-flow-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const a = await fixture(cwd, true);
  const b = await fixture(cwd, true);
  await launchRunner(a);
  assert.equal(await launchRunner(b), 0);
  assert.equal((await readRun(b))?.status, "排队中");
  await continueRun(a, "追加调查");
  await settled(a);
  await launchRunner(b);
  await settled(b);
  assert.equal(await startFollowUp(a), true);
  await settled(a);
  assert.match((await readRun(a))!.finalText!, /追加调查/);
  assert.equal((await readRun(a))!.childSessionId, "same-session");
  assert.equal(await startFollowUp(a), false);
  await continueRun(a, "继续已经完成的任务");
  await settled(a);
  assert.match((await readRun(a))!.finalText!, /继续已经完成的任务/);
  const c = await fixture(cwd, true);
  await launchRunner(c);
  const d = await fixture(cwd, true);
  await launchRunner(d);
  await continueRun(d, "不应执行");
  assert.equal((await stopRun(d)).status, "已取消");
  await assert.rejects(fs.access(path.join(runDirectory(d), "follow-up.json")));
  await settled(c);
});

test("配置的执行超时实际结束 fixture 子进程并记录失败", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-timeout-"));
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const id = await fixture(cwd, false, "setInterval(()=>{},1000);");
  const file = path.join(runDirectory(id), "request.json");
  const request = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...request, timeoutMs: 150 }));
  await launchRunner(id);
  await settled(id);
  assert.equal((await readRun(id))!.status, "失败");
  assert.ok((await readRun(id))!.events.some((e) => e.text.includes("超时")));
});

test("从 Agent 公共入口到独立 Runner 再到自动消息交付", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-public-flow-"));
  const fakeCli = path.join(cwd, "fake-pi.mjs");
  await fs.writeFile(fakeCli, `console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:'调查完成：'+process.argv.at(-1)}]}}));`);
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  const messages: any[] = [];
  const entries: any[] = [];
  let active: string[] = [];
  agentDeck({
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand() {}, registerMessageRenderer() {},
    on: (name: string, fn: any) => handlers.set(name, fn),
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    getThinkingLevel: () => "high",
    sendMessage: (message: any) => { messages.push(message); entries.push({ type: 'custom_message', ...message }); },
  } as any);
  const ctx: any = { cwd, isProjectTrusted: () => false, model: { provider: "fake", id: "model", reasoning: true }, thinkingLevel: "off", sessionManager: { getSessionId: () => "public-flow", getSessionFile: () => undefined, getBranch: () => entries }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
  ctx.modelRegistry = { getAvailable: () => [ctx.model], find: (provider: string, id: string) => provider === ctx.model.provider && id === ctx.model.id ? ctx.model : undefined };
  t.after(async () => { handlers.get("session_shutdown")(); await fs.rm(cwd, { recursive: true, force: true }); });
  await handlers.get("session_start")({}, ctx);
  const originalCli = process.argv[1];
  let result: any;
  try {
    process.argv[1] = fakeCli;
    result = await tools.get("Agent").execute("call", { description: "调查入口", prompt: "只读调查入口", subagent_type: "Explore" }, undefined, undefined, ctx);
  } finally { process.argv[1] = originalCli; }
  const id = result.details.publicResult.agentId;
  await settled(id);
  await until(async () => messages.length === 1);
  assert.match(messages[0].content, /调查完成：只读调查入口/);
  const request = JSON.parse(await fs.readFile(path.join(runDirectory(id), "request.json"), "utf8"));
  assert.equal(request.naturalOutput, true);
  assert.equal(request.timeoutMs, 0);
  assert.equal(request.env.PI_AGENT_DECK_SIMPLE, "1");
  assert.equal((await readRun(id))!.writePermission, false);
  assert.equal((await readRun(id))!.thinking, "high");
  assert.equal(request.argsPrefix[request.argsPrefix.indexOf("--thinking") + 1], "high");
  await assert.rejects(tools.get("Agent").execute("call", { description: "继续", prompt: "继续", task_id: id }, undefined, undefined, ctx), /不支持的参数/);
  await assert.rejects(tools.get("SendMessage").execute("call", { to: id, message: "继续", model: "fake/model" }, undefined, undefined, ctx), /不支持的参数/);
});
