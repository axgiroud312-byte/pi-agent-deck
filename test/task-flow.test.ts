import { resumeFixtureRun } from "./fixtures/resume-fixture.ts";
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
  const run: any = { version: 3, runId: id, turnId: randomUUID(), roleId: write ? "worker" : "reviewer", agentName: "fixture", agentSource: "内置",
    objective: "测试任务", instruction: "initial", status: "运行中", model: "fake/model", thinking: "off", tools: [],
    cwd, parentSessionId: "flow-parent", childSessionId: id, childSessionPath: session,
    startedAt: Date.now(), events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  await initializeRun(run, { version: 3, cwd, command: process.execPath,
    argsPrefix: [script, "--session", session, "--model", run.model, "--thinking", run.thinking],
    prompt: "initial", env, timeoutMs }, true);
  return id;
}

test("同工作区任务不受硬写锁或固定容量限制；完成后续接复用原会话", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-flow-"));
  t.after(async () => { await shutdownRuns("flow-parent"); await fs.rm(cwd, { recursive: true, force: true }); });
  const a = await fixture(cwd, true, { DECK_RPC_DELAY_MS: "350" });
  const secondWriter = await fixture(cwd, true);
  const b = await fixture(cwd, false);
  await launchRunner(a);
  const firstPid = await until(async () => (await readRun(a))?.childPid, "首个写任务启动");
  await launchRunner(b);
  await until(async () => (await readRun(b))?.childPid, "并行审查任务启动");
  await launchRunner(secondWriter);
  await until(async () => (await readRun(secondWriter))?.childPid, "第二个写角色任务启动");
  assert.ok(alive(firstPid), "插件不因角色或 Bash 推断实施者并阻塞任务");
  assert.equal((await sendToRun(a, "追加调查")).delivery, "queued");
  const first = await finished(a);
  assert.equal(first.status, "已完成");
  const second = await finished(b);
  assert.equal(second.status, "已完成");
  assert.equal((await finished(secondWriter)).status, "已完成");
  const resumed = await resumeFixtureRun(a, "继续已经完成的任务");
  assert.equal(resumed.status, "运行中");
  const last = await until(async () => { const run = await readRun(a); return run?.status === "已完成" && run.turnId !== first.turnId ? run : undefined; }, "原会话续跑");
  assert.match(last.finalText ?? "", /继续已经完成的任务/);
  assert.equal(last.childPid, undefined);
  assert.equal(alive(firstPid), false);
  assert.equal(last.childSessionId, first.childSessionId);
  assert.equal(last.model, first.model);
  const c = await fixture(cwd, true, { DECK_RPC_DELAY_MS: "500" });
  const d = await fixture(cwd, false, { DECK_RPC_HANG: "1" });
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

test("Agent 公共入口显式后台立即返回，RPC 完成后自动交付结果", async (t) => {
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
    result = await tools.get("Agent").execute("call", { description: "调查入口", prompt: "只读调查入口", subagent_type: "Explore", run_in_background: true }, undefined, undefined, ctx);
  } finally { process.argv[1] = originalCli; }
  const id = result.details.publicResult.agentId;
  assert.notEqual((await readRun(id))?.status, "已完成", "派发工具不应等待子 Agent 完成");
  const run = await finished(id);
  assert.equal(run.status, "已完成");
  await until(async () => messages.length ? true : undefined, "自动交付");
  assert.match(messages[0].content, /调查完成：只读调查入口/);
  const request = JSON.parse(await fs.readFile(path.join(runDirectory(id), "request.json"), "utf8"));
  assert.equal("naturalOutput" in request, false);
  assert.equal("PI_AGENT_DECK_SIMPLE" in request.env, false);
  assert.deepEqual(run.disallowedTools, ["edit", "write"]);
  assert.equal(run.thinking, "high");
  assert.equal(alive(run.childPid), false, "执行返回后进程自动释放");
  assert.equal(run.resourceState, "released");

  const noticesBeforeBackgroundResume = messages.length;
  process.argv[1] = fakeCli;
  let resumedInBackground: any;
  try {
    resumedInBackground = await tools.get("Agent").execute(randomUUID(), {
      resume: id,
      prompt: "BACKGROUND_RESUME",
      description: "后台续接原任务",
      run_in_background: true,
    }, undefined, undefined, ctx);
  } finally { process.argv[1] = originalCli; }
  assert.equal(resumedInBackground.details.publicResult.delivery, "resumed");
  assert.equal(resumedInBackground.details.run.deliveryMode, "background");
  assert.notEqual(resumedInBackground.details.run.status, "已完成", "后台续接入口不等待本轮完成");
  const resumedTurnId = resumedInBackground.details.run.turnId;
  const resumedRun = await until(async () => {
    const current = await readRun(id);
    return current && current.turnId === resumedTurnId && current.status === "已完成" ? current : undefined;
  }, "后台续接完成");
  assert.equal(resumedRun.childSessionId, run.childSessionId, "后台续接沿用原 Pi 子会话");
  assert.match(resumedRun.finalText ?? "", /BACKGROUND_RESUME/);
  await until(async () => messages.length === noticesBeforeBackgroundResume + 1 ? true : undefined, "后台续接自动交付");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.length, noticesBeforeBackgroundResume + 1, "后台续接只能自动通知一次");
  assert.match(messages.at(-1).content, /BACKGROUND_RESUME/);
  const resumedHistory = await import("../src/persistence.mjs").then(({ readCompletions }) => readCompletions(runDirectory(id)));
  assert.equal(resumedHistory.length, 2, "后台续接追加一条完成记录");

  const backgroundNotices = messages.length;
  const foreground = async (run_in_background?: boolean) => {
    process.argv[1] = fakeCli;
    try {
      return await tools.get("Agent").execute(randomUUID(), {
        description: run_in_background === false ? "显式前台" : "默认前台",
        prompt: run_in_background === false ? "FOREGROUND_FALSE" : "FOREGROUND_OMITTED",
        subagent_type: "Explore",
        ...(run_in_background === undefined ? {} : { run_in_background }),
      }, undefined, undefined, ctx);
    } finally { process.argv[1] = originalCli; }
  };
  const omitted = await foreground();
  const explicitFalse = await foreground(false);
  assert.equal(omitted.details.run.status, "已完成");
  assert.equal(explicitFalse.details.run.status, "已完成");
  assert.match(omitted.content[0].text, /FOREGROUND_OMITTED/);
  assert.match(explicitFalse.content[0].text, /FOREGROUND_FALSE/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.length, backgroundNotices, "前台结果不能再发送后台唤醒通知");
  for (const foregroundResult of [omitted, explicitFalse]) {
    const history = await import("../src/persistence.mjs").then(({ readCompletions }) => readCompletions(runDirectory(foregroundResult.details.run.runId)));
    assert.equal(history.length, 1, "前台执行也保存完成记录");
  }

  const abort = new AbortController();
  process.argv[1] = fakeCli;
  const cancelledPromise = tools.get("Agent").execute(randomUUID(), {
    description: "取消前台等待", prompt: "FOREGROUND_ABORT", subagent_type: "Explore",
  }, abort.signal, undefined, ctx);
  setTimeout(() => abort.abort(), 50);
  let cancelled: any;
  try { cancelled = await cancelledPromise; }
  finally { process.argv[1] = originalCli; }
  assert.ok(["已停止", "已取消"].includes(cancelled.details.run.status));
  assert.equal(cancelled.details.run.resourceState, "released");
  assert.equal(alive(cancelled.details.run.childPid), false);

  const originalRename = fs.rename;
  const statusWrites = new Map<string, number>();
  fs.rename = async (from, to) => {
    const target = String(to);
    if (path.basename(target) === "status.json") {
      const count = (statusWrites.get(target) ?? 0) + 1;
      statusWrites.set(target, count);
      if (count === 2) throw Object.assign(new Error("PUBLIC_START_SAVE_INJECTED"), { code: "EIO" });
    }
    return originalRename(from, to);
  };
  const noticesBeforeFailure = messages.length;
  try {
    for (const background of [true, false]) {
      process.argv[1] = fakeCli;
      const failure = await tools.get("Agent").execute(randomUUID(), {
        description: background ? "后台启动保存失败" : "前台启动保存失败",
        prompt: "PUBLIC_START_SAVE_FAILURE",
        subagent_type: "Explore",
        run_in_background: background,
      }, undefined, undefined, ctx);
      assert.equal(failure.details.run.status, "失败");
      assert.match(failure.content[0].text, /PUBLIC_START_SAVE_INJECTED|启动状态保存失败/);
    }
  } finally {
    process.argv[1] = originalCli;
    fs.rename = originalRename;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages.length, noticesBeforeFailure, "同步返回的启动失败不能再发送后台结果通知");
});

test("其他同目录任务运行时仍可明确 resume，暂存消息只送一次", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-resume-admission-"));
  t.after(async () => { await shutdownRuns("flow-parent"); await fs.rm(cwd, { recursive: true, force: true }); });
  const original = await fixture(cwd, true);
  await launchRunner(original);
  const completed = await finished(original);
  await sendToRun(original, "KEEP_AFTER_REJECT");
  const blocker = await fixture(cwd, true, { DECK_RPC_HANG: "1" });
  await launchRunner(blocker);
  await until(async () => (await readRun(blocker))?.childPid, "并行任务启动");
  const resumed = await resumeFixtureRun(original, "ACCEPTED_RESUME");
  assert.notEqual(resumed.turnId, completed.turnId);
  const result = await until(async () => {
    const run = await readRun(original);
    return run?.status === "已完成" && run.turnId === resumed.turnId ? run : undefined;
  }, "拒绝后重新续接");
  assert.match(result.finalText ?? "", /KEEP_AFTER_REJECT\s+ACCEPTED_RESUME/);
  assert.equal((result.finalText ?? "").split("KEEP_AFTER_REJECT").length, 2);
  assert.equal(result.queuedMessageCount, 0);
  await stopRun(blocker);
});
