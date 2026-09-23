import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import agentDeck from "../src/index.ts";
import { initializeRun, launchRunner, readRun, runDirectory, sendToRun, shutdownRuns, stopRun } from "../src/runtime.ts";

async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`任务流程测试超时：${label}`);
}
function alive(pid?: number): boolean { try { if (!pid) return false; process.kill(pid, 0); return true; } catch { return false; } }
const finished = (id: string) => until(async () => {
  const run = await readRun(id);
  return run && ["已完成", "失败", "已停止", "已取消"].includes(run.status) ? run : undefined;
}, "完成");

// Persistent local Pi-RPC peer. It emits the event boundaries consumed by runtime.ts.
const rpcSource = String.raw`import fs from "node:fs";
import readline from "node:readline";
const args=process.argv.slice(2), option=(name)=>args[args.indexOf(name)+1];
const output=(value)=>process.stdout.write(JSON.stringify(value)+"\n");
const log=(value)=>fs.appendFileSync("executions.jsonl",JSON.stringify(value)+"\n");
const sessionFile=option("--session"), model=option("--model"), thinkingLevel=option("--thinking");
const [provider,modelId]=model.split("/");
let streaming=false, queue=[], turn=0;
log({type:"start",args});
function start(message){
  streaming=true; turn++; log({type:"prompt",message,turn}); output({type:"agent_start"});
  if(process.env.DECK_RPC_HANG==="1") return;
  setTimeout(()=>{
    output({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"调查完成："+message}]}});
    if(queue.length){ start(queue.shift()); return; }
    streaming=false; output({type:"agent_settled"});
  },Number(process.env.DECK_RPC_DELAY_MS||300));
}
readline.createInterface({input:process.stdin}).on("line",line=>{
  let request;try{request=JSON.parse(line)}catch{return}
  const {type,id}=request;
  if(type==="get_state") return output({type:"response",id,command:type,success:true,data:{model:{provider,id:modelId},thinkingLevel,sessionId:sessionFile,sessionFile,isStreaming:streaming}});
  if(type==="prompt"||type==="steer"){
    output({type:"response",id,command:type,success:true,data:{}});
    if(streaming) queue.push(request.message); else start(request.message);
    return;
  }
  if(type==="clear_queue") queue=[];
  if(type==="abort") streaming=false;
  output({type:"response",id,command:type,success:true,data:{}});
});`;

async function fixture(cwd: string, write: boolean, env: Record<string, string> = {}, timeoutMs = 0) {
  const id = `test-flow-${randomUUID()}`;
  const script = path.join(cwd, `${id}.mjs`);
  await fs.writeFile(script, rpcSource);
  const session = path.join(cwd, `${id}.jsonl`);
  const run: any = { version: 1, runId: id, turnId: randomUUID(), agentId: "test", agentName: "fixture", agentSource: "内置",
    objective: "测试任务", instruction: "initial", acceptanceCriteria: [], status: "运行中", model: "fake/model", thinking: "off", tools: [],
    writePermission: write, cwd, parentSessionId: "flow-parent", childSessionId: id, childSessionPath: session,
    startedAt: Date.now(), reports: [], events: [], autoDeliver: true,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  await initializeRun(run, { version: 1, cwd, command: process.execPath,
    argsPrefix: [script, "--session", session, "--model", run.model, "--thinking", run.thinking],
    prompt: "initial", naturalOutput: true, env, timeoutMs }, true);
  return id;
}

test("独立写任务同工作区并行；完成释放进程后复用原会话；停止不重启", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-flow-"));
  t.after(async () => { await shutdownRuns("flow-parent"); await fs.rm(cwd, { recursive: true, force: true }); });
  const a = await fixture(cwd, true, { DECK_RPC_DELAY_MS: "350" });
  const b = await fixture(cwd, true);
  await launchRunner(a);
  const firstPid = await until(async () => (await readRun(a))?.childPid, "首个写任务启动");
  await launchRunner(b);
  await until(async () => (await readRun(b))?.childPid, "第二个独立写任务启动");
  assert.ok(alive(firstPid), "第二个任务无需等待第一个任务结束");
  assert.equal((await sendToRun(a, "追加调查")).delivery, "queued");
  const first = await finished(a);
  assert.equal(first.status, "已完成");
  const second = await finished(b);
  assert.equal(second.status, "已完成");
  const resumed = await sendToRun(a, "继续已经完成的任务");
  assert.equal(resumed.delivery, "resumed");
  const last = await until(async () => { const run = await readRun(a); return run?.status === "已完成" && run.turnId !== first.turnId ? run : undefined; }, "原会话续跑");
  assert.match(last.finalText ?? "", /继续已经完成的任务/);
  assert.equal(last.childPid, undefined);
  assert.equal(alive(firstPid), false);
  assert.equal(last.childSessionId, first.childSessionId);
  assert.equal(last.model, first.model);
  const c = await fixture(cwd, true, { DECK_RPC_DELAY_MS: "500" });
  const d = await fixture(cwd, true, { DECK_RPC_HANG: "1" });
  await launchRunner(c);
  await until(async () => (await readRun(c))?.childPid, "第三个任务启动");
  await launchRunner(d);
  await until(async () => (await readRun(d))?.childPid, "待停止任务启动");
  await sendToRun(d, "不应执行");
  assert.equal((await stopRun(d)).status, "已停止");
  await finished(c);
  assert.equal((await readRun(d))?.childPid, undefined);
  assert.equal(await launchRunner(d), 0);
});

test("配置的执行超时终止 RPC 子进程并记录失败", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-timeout-"));
  t.after(async () => { await shutdownRuns("flow-parent"); await fs.rm(cwd, { recursive: true, force: true }); });
  const id = await fixture(cwd, false, { DECK_RPC_HANG: "1" }, 150);
  await launchRunner(id);
  const run = await finished(id);
  assert.equal(run.status, "失败");
  assert.ok(run.events.some((event) => event.text.includes("超时")));
  assert.equal(alive(run.childPid), false);
});

test("Agent 公共入口立即返回，RPC 完成后自动交付结果", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-public-flow-"));
  const fakeCli = path.join(cwd, "fake-pi.mjs");
  await fs.writeFile(fakeCli, rpcSource);
  const tools = new Map<string, any>(), handlers = new Map<string, any>(), messages: any[] = [];
  let active: string[] = [];
  agentDeck({
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand() {}, registerMessageRenderer() {},
    on: (name: string, fn: any) => handlers.set(name, fn),
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    getThinkingLevel: () => "high", sendMessage: (message: any) => messages.push(message),
  } as any);
  const entries: any[] = [];
  const ctx: any = { cwd, isProjectTrusted: () => false, model: { provider: "fake", id: "model", reasoning: true },
    sessionManager: { getSessionId: () => "public-flow", getSessionFile: () => undefined, getBranch: () => entries },
    ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
  ctx.modelRegistry = { getAvailable: () => [ctx.model], find: (provider: string, id: string) => provider === "fake" && id === "model" ? ctx.model : undefined };
  t.after(async () => { await handlers.get("session_shutdown")(); await fs.rm(cwd, { recursive: true, force: true }); });
  await handlers.get("session_start")({}, ctx);
  const originalCli = process.argv[1];
  let result: any;
  try {
    process.argv[1] = fakeCli;
    result = await tools.get("Agent").execute("call", { description: "调查入口", prompt: "只读调查入口", subagent_type: "Explore" }, undefined, undefined, ctx);
  } finally { process.argv[1] = originalCli; }
  const id = result.details.publicResult.agentId;
  assert.notEqual((await readRun(id))?.status, "已完成", "派发工具不应等待子 Agent 完成");
  const run = await finished(id);
  assert.equal(run.status, "已完成");
  await until(async () => messages.length ? true : undefined, "自动交付");
  assert.match(messages[0].content, /调查完成：只读调查入口/);
  const request = JSON.parse(await fs.readFile(path.join(runDirectory(id), "request.json"), "utf8"));
  assert.equal(request.naturalOutput, true);
  assert.equal(request.env.PI_AGENT_DECK_SIMPLE, "1");
  assert.equal(run.writePermission, false);
  assert.equal(run.thinking, "high");
  assert.equal(alive(run.childPid), false, "执行返回后进程自动释放");
  assert.equal(run.resourceState, "released");
});
