import { resumeFixtureRun } from "./fixtures/resume-fixture.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import agentDeck from "../src/index.ts";
import { initializeRun, launchRunner, readRun, runDirectory, sendToRun, shutdownRuns, stopRun } from "../src/runtime.ts";
import { readCompletions } from "../src/persistence.mjs";
import type { RoutingPlan } from "../src/router.mjs";
import { writeSavedJevKey } from "../src/jev-service.mjs";

async function until<T>(check: () => Promise<T | undefined>, label: string, timeout = 15_000): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`选配测试超时：${label}`);
}
const finished = (id: string) => until(async () => {
  const run = await readRun(id);
  return run && ["已完成", "失败", "已停止", "已取消"].includes(run.status) ? run : undefined;
}, "任务完成");

// A persistent local Pi-RPC peer: enough protocol to exercise the real parent
// runtime while keeping all model calls and network traffic inside this test.
const rpcSource = String.raw`import fs from "node:fs";
import readline from "node:readline";
const args=process.argv.slice(2), option=(name)=>args[args.indexOf(name)+1];
const output=(value)=>process.stdout.write(JSON.stringify(value)+"\n");
const log=(value)=>fs.appendFileSync("started.jsonl",JSON.stringify(value)+"\n");
const sessionFile=option("--session"), model=option("--model"), thinkingLevel=option("--thinking");
const [provider,modelId]=model.split("/");
let streaming=false, queue=[], turn=0;
log({type:"start",args});
function start(message){
  streaming=true; turn++; log({type:"prompt",message,turn}); output({type:"agent_start"});
  setTimeout(()=>{
    output({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:"模型 "+model+" 思考 "+thinkingLevel+"："+message}]}});
    if(queue.length){ start(queue.shift()); return; }
    streaming=false; output({type:"agent_settled"});
  },150);
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

function plan(task: string): RoutingPlan {
  return {
    version: 1, routerModel: "jev-1.13.0", timeoutMs: 10_000,
    fallback: { model: "openai-codex/gpt-6-sol", thinking: "high" },
    candidates: [
      { id: "sol6_high", model: "openai-codex/gpt-6-sol", thinking: "high", criteria: "routine" },
      { id: "luna6_high", model: "openai-codex/gpt-6-luna", thinking: "high", criteria: "complex" },
    ],
    state: { task, role: "scout", roleDescription: "调查", writePermission: false, tools: ["read"] },
  };
}

async function fixture(t: any, task: string, routing = plan(task)) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "deck-route-"));
  const id = "routing-" + randomUUID();
  const script = path.join(directory, "fake-pi.mjs");
  await fs.writeFile(script, rpcSource);
  const session = path.join(directory, "child.jsonl");
  const run: any = { version: 1, autoDeliver: true, runId: id, turnId: randomUUID(),
    agentId: routing.state.role, agentName: "fixture", agentSource: "内置",
    objective: task, instruction: task, acceptanceCriteria: [], status: "选配中",
    model: routing.fallback.model, thinking: routing.fallback.thinking, routingPending: true,
    tools: ["read"], writePermission: false, cwd: directory,
    parentSessionId: id, childSessionId: id, childSessionPath: session,
    startedAt: Date.now(), reports: [], events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  await initializeRun(run, { version: 1, cwd: directory, command: process.execPath,
    argsPrefix: [script, "--session", session, "--model", run.model, "--thinking", run.thinking],
    prompt: task, naturalOutput: true, routing }, true);
  t.after(async () => { await shutdownRuns(id); await fs.rm(directory, { recursive: true, force: true }); });
  return { id, directory };
}

function service(t: any, responseMode: "delayed" | "invalid" = "delayed") {
  const originalFetch = globalThis.fetch, originalKey = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = "fake-local-only-key";
  const calls: Array<{ url: string; options: RequestInit }> = [];
  const pending: Array<{ resolve: (value: Response) => void; reject: (error: Error) => void; options: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, options: RequestInit = {}) => {
    assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
    calls.push({ url: String(url), options });
    const send = () => {
      if (responseMode === "invalid") return new Response(JSON.stringify({ invalid: true }), { status: 200 });
      const body = JSON.parse(String(options.body));
      const keys = Object.keys(body.questions.execution_profile.criteria);
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { execution_profile: {
        type: "choice", choice: "luna6_high", confidence: 1,
        probabilities: Object.fromEntries(keys.map((key) => [key, key === "luna6_high" ? 1 : 0])),
      } } }), { status: 200 });
    };
    if (responseMode === "invalid") return send();
    return new Promise<Response>((resolve, reject) => {
      pending.push({ resolve: () => resolve(send()), reject, options });
      options.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
  });
  return { calls, respond() { const next = pending.shift(); assert.ok(next, "Jev 请求应已进入本地等待"); next.resolve(new Response()); } };
}

test("Jev 异步选配不阻塞任务入口；保存的密钥不进入任务记录，续跑沿用同一模型和会话", async (t) => {
  const svc = service(t);
  delete process.env.TYPESAFE_API_KEY;
  const credentialFile = path.join(getAgentDir(), `test-jev-${randomUUID()}.json`);
  const key = "fake-saved-runner-credential";
  await writeSavedJevKey(credentialFile, key, undefined);
  t.after(() => fs.rm(credentialFile, { force: true }));
  const p = { ...plan("saved credential"), credentialFile };
  const f = await fixture(t, "saved credential", p);
  const requestFile = path.join(runDirectory(f.id), "request.json");
  assert.ok(!(await fs.readFile(requestFile, "utf8")).includes(key));
  assert.equal(await launchRunner(f.id), 0);
  await until(async () => svc.calls.length === 1 ? true : undefined, "Jev 请求");
  const selecting = (await readRun(f.id))!;
  assert.equal(selecting.status, "选配中");
  assert.equal(selecting.childPid, undefined);
  assert.equal((svc.calls[0].options.headers as Record<string, string>).Authorization, `Bearer ${key}`);
  assert.equal((await sendToRun(f.id, "保留最后的证据行")).delivery, "queued");
  svc.respond();
  const first = await finished(f.id);
  assert.equal(first.status, "已完成");
  assert.equal(first.model, "openai-codex/gpt-6-luna");
  assert.equal(first.thinking, "high");
  assert.equal(first.routing?.mode, "jev");
  assert.match(first.finalText ?? "", /保留最后的证据行/);
  assert.ok(!(await fs.readFile(requestFile, "utf8")).includes(key));
  assert.ok(!JSON.stringify(first).includes(key));
  assert.ok(!JSON.stringify(await readCompletions(runDirectory(f.id))).includes(key));
  const session = first.childSessionId, pid = first.childPid, turnId = first.turnId;
  assert.equal((await resumeFixtureRun(f.id, "再次调查")).status, "运行中");
  const second = await until(async () => {
    const run = await readRun(f.id);
    return run?.status === "已完成" && run.turnId !== turnId ? run : undefined;
  }, "原会话续跑");
  assert.equal(second.model, first.model);
  assert.equal(second.thinking, first.thinking);
  assert.equal(second.childSessionId, session);
  assert.equal(second.childPid, pid);
  assert.equal(svc.calls.length, 1);
  assert.match(second.finalText ?? "", /再次调查/);
});

test("取消未完成的 Jev 选配后，迟到响应不能启动子进程", async (t) => {
  const svc = service(t);
  const f = await fixture(t, "cancel selection");
  await launchRunner(f.id);
  await until(async () => svc.calls.length === 1 ? true : undefined, "待取消 Jev 请求");
  await sendToRun(f.id, "不能执行的补充");
  const stopped = await stopRun(f.id);
  assert.equal(stopped.status, "已停止");
  svc.respond();
  assert.equal(await launchRunner(f.id), 0);
  assert.equal((await readRun(f.id))?.childPid, undefined);
  await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
});

test("Jev 无效结果使用合规回退并交付原因", async (t) => {
  const svc = service(t, "invalid");
  const f = await fixture(t, "invalid selection");
  await launchRunner(f.id);
  const run = await finished(f.id);
  assert.equal(svc.calls.length, 1);
  assert.equal(run.status, "已完成");
  assert.equal(run.model, "openai-codex/gpt-6-sol");
  assert.equal(run.thinking, "high");
  assert.equal(run.routing?.mode, "fallback");
  assert.match(run.routing?.reason ?? "", /无效/);
  assert.match(run.finalText ?? "", /gpt-6-sol 思考 high/);
  assert.match((await readCompletions(runDirectory(f.id)))[0].routing?.reason ?? "", /无效/);
});

test("禁止 Astra 与非审查角色使用专属审查模型，违规请求不启动 RPC", async (t) => {
  for (const [role, model, thinking] of [
    ["scout", "gpt-6-astra", "high"],
    ["reviewer", "gpt-6-sol", "high"],
    ["scout", "gpt-5.6-sol", "xhigh"],
  ] as const) {
    const p = plan("blocked route");
    p.state.role = role;
    p.fallback = { model: `openai-codex/${model}`, thinking };
    const f = await fixture(t, "blocked route", p);
    await launchRunner(f.id);
    const failed = await finished(f.id);
    assert.equal(failed.status, "失败");
    assert.match(failed.stderr ?? "", /模型策略不允许/);
    assert.equal(failed.childPid, undefined);
    assert.equal(await launchRunner(f.id), 0);
    await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
  }
});

test("Agent 公共入口在 Jev 选配中可收补充消息，取消中的任务不因迟到响应启动", async (t) => {
  const svc = service(t);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "deck-public-route-"));
  const cli = path.join(directory, "fake-pi.mjs");
  await fs.writeFile(cli, rpcSource);
  const sol: any = { provider: "openai-codex", id: "gpt-6-sol", reasoning: true, thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } };
  const luna: any = { ...sol, id: "gpt-6-luna" };
  const tools = new Map<string, any>();
  let active: string[] = [];
  agentDeck({ registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand() {}, registerMessageRenderer() {}, on() {},
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
    getThinkingLevel: () => "medium" } as any);
  const parent = randomUUID();
  const ctx: any = { cwd: directory, model: sol,
    modelRegistry: { getAvailable: () => [sol, luna], find: (provider: string, id: string) => [sol, luna].find((model) => model.provider === provider && model.id === id) },
    isProjectTrusted: () => false, sessionManager: { getSessionId: () => parent, getSessionFile: () => undefined } };
  const call = async (name: string, input: any) => (await tools.get(name).execute("call", input, undefined, undefined, ctx)).details.publicResult;
  const original = process.argv[1];
  process.argv[1] = cli;
  t.after(async () => { process.argv[1] = original; await shutdownRuns(parent); await fs.rm(directory, { recursive: true, force: true }); });
  const created = await call("Agent", { description: "复杂问题调查", prompt: "调查认证问题并给出证据", name: "routing-live", subagent_type: "Explore" });
  await until(async () => svc.calls.length === 1 ? true : undefined, "公共入口 Jev 请求");
  assert.equal(created.status, "selecting");
  assert.equal(created.resolvedModel, undefined);
  assert.equal((await call("SendMessage", { to: "routing-live", message: "保留最后的证据行" })).delivery, "queued");
  svc.respond();
  const first = await finished(created.agentId);
  assert.equal(first.status, "已完成");
  assert.equal(first.model, "openai-codex/gpt-6-luna");
  assert.match(first.finalText ?? "", /保留最后的证据行/);
  const pending = await call("Agent", { description: "待取消任务", prompt: "不应启动", subagent_type: "Explore", name: "cancel-route" });
  await until(async () => svc.calls.length === 2 ? true : undefined, "第二个 Jev 请求");
  assert.equal((await call("TaskStop", { task_id: "cancel-route" })).status, "stopped");
  svc.respond();
  assert.equal(await launchRunner(pending.agentId), 0);
  const starts = (await fs.readFile(path.join(directory, "started.jsonl"), "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(starts.filter((item) => item.type === "start").length, 1);
});
