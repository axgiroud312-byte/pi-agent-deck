import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initializeRun, launchRunner, readRun, runDirectory, stopRun, continueRun, startFollowUp } from "../src/runtime.ts";
import { readCompletions, alive } from "../src/persistence.mjs";
import type { RoutingPlan } from "../src/router.mjs";
import agentDeck from "../src/index.ts";

async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error("routing fixture timed out");
}
async function settled(id: string) {
  await until(async () => { const r = await readRun(id); return !!r && ["已完成", "失败", "已停止", "已取消"].includes(r.status) && !alive(r.runnerPid) && !alive(r.childPid); });
  return (await readRun(id))!;
}
function plan(task: string): RoutingPlan {
  return {
    version: 1, routerModel: "jev-1.13.0", timeoutMs: 10000,
    fallback: { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
    candidates: [
      { id: "sol_medium", model: "openai-codex/gpt-5.6-sol", thinking: "medium", criteria: "routine" },
      { id: "astra_high", model: "openai-codex/gpt-6-astra", thinking: "high", criteria: "complex" },
    ],
    state: { task, role: "scout", roleDescription: "调查", writePermission: false, tools: ["read"] },
  };
}
async function fixture(task: string) {
  const id = "routing-" + randomUUID();
  const directory = path.join(getAgentDir(), "fixtures", id);
  await fs.mkdir(directory, { recursive: true });
  const script = path.join(directory, "child.mjs");
  await fs.writeFile(script, [
    'import fs from "node:fs";',
    'fs.appendFileSync("started.jsonl",JSON.stringify(process.argv.slice(2))+"\\n");',
    'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:process.argv.join(" ")}]}}));',
  ].join("\n"));
  const routing = plan(task);
  const run: any = {
    version: 1, autoDeliver: true, runId: id, agentId: "scout", agentName: "fixture", objective: task, instruction: task,
    status: "选配中", model: routing.fallback.model, thinking: routing.fallback.thinking, routingPending: true,
    tools: ["read"], writePermission: false, cwd: directory, parentSessionId: id, childSessionId: id, childSessionPath: path.join(directory, "child.jsonl"),
    startedAt: Date.now(), reports: [], events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  await initializeRun(run, { version: 1, cwd: directory, command: process.execPath, argsPrefix: [script, "--model", run.model, "--thinking", run.thinking], prompt: task, naturalOutput: true, routing }, true);
  return { id, directory };
}
async function service(t: any, responseMode: "delayed" | "invalid" = "delayed") {
  const calls: any[] = [];
  let respond: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    const send = () => {
      res.setHeader("Content-Type", "application/json");
      const keys = Object.keys(body.questions.execution_profile.criteria);
      res.end(JSON.stringify(responseMode === "invalid" ? { invalid: true } : { model: "jev-1.13.0", answers: { execution_profile: { type: "choice", choice: "astra_high", confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === "astra_high" ? 1 : 0])) } } }));
    };
    if (responseMode === "invalid") send(); else respond = send;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const preload = path.join(getAgentDir(), randomUUID() + ".mjs");
  const endpoint = "http://127.0.0.1:" + (server.address() as any).port;
  await fs.writeFile(preload, 'const nativeFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{if(url!=="https://api.typesafe.ai/v1/systemone")throw new Error("unexpected network");return nativeFetch(' + JSON.stringify(endpoint) + ',options);};');
  const originalOptions = process.env.NODE_OPTIONS, originalKey = process.env.TYPESAFE_API_KEY;
  process.env.NODE_OPTIONS = (originalOptions ? originalOptions + " " : "") + "--import=" + pathToFileURL(preload).href;
  process.env.TYPESAFE_API_KEY = "fake-local-only-key";
  t.after(async () => {
    if (originalOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = originalOptions;
    if (originalKey === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = originalKey;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { calls, respond: () => { assert.ok(respond); respond(); } };
}

test("新工具串联 Jev：选配中不虚报模型，补充排队、继续不重选、停止阻断迟到启动", async (t) => {
  const svc = await service(t);
  const directory = path.join(getAgentDir(), "public-routing");
  await fs.mkdir(directory, { recursive: true });
  const cli = path.join(directory, "fake-pi.mjs");
  await fs.writeFile(cli, 'import fs from "node:fs";fs.appendFileSync("started.jsonl",JSON.stringify(process.argv.slice(2))+"\\n");console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:process.argv.at(-1)}]}}));');
  const sol: any = { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } };
  const astra: any = { ...sol, id: "gpt-6-astra", thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
  const tools = new Map<string, any>();
  agentDeck({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {}, on() {}, getThinkingLevel: () => "medium" } as any);
  const ctx: any = { cwd: directory, model: sol, modelRegistry: { getAvailable: () => [sol, astra], find: (provider: string, id: string) => [sol, astra].find((model) => model.provider === provider && model.id === id) }, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "public-routing", getSessionFile: () => undefined } };
  const call = async (name: string, input: any) => (await tools.get(name).execute("call", input, undefined, undefined, ctx)).details.publicResult;
  const original = process.argv[1];
  const ids: string[] = [];
  t.after(async () => { process.argv[1] = original; for (const id of ids) await stopRun(id); });
  process.argv[1] = cli;
  const created = await call("Agent", { description: "复杂问题调查", prompt: "调查认证问题并给出证据", name: "routing-live", subagent_type: "Explore", model: "openai-codex/gpt-6-astra" });
  ids.push(created.agentId);
  await until(() => svc.calls.length === 1);
  assert.equal(created.status, "selecting"); assert.equal(created.resolvedModel, undefined); assert.equal(created.thinking, undefined);
  assert.equal((await call("SendMessage", { to: "routing-live", message: "保留最后的证据行" })).delivery, "queued");
  svc.respond();
  const first = await settled(created.agentId);
  assert.equal(first.model, "openai-codex/gpt-6-astra"); assert.equal(first.thinking, "high");
  assert.equal(await startFollowUp(created.agentId), true);
  const continued = await settled(created.agentId);
  assert.equal(continued.model, first.model); assert.equal(continued.childSessionId, first.childSessionId); assert.equal(svc.calls.length, 1);
  assert.match(continued.finalText!, /保留最后的证据行/);
  const pending = await call("Agent", { description: "待取消任务", prompt: "不应启动", subagent_type: "Explore", name: "cancel-route" });
  ids.push(pending.agentId);
  await until(() => svc.calls.length === 2);
  await call("SendMessage", { to: pending.agentId, message: "这条补充也不应执行" });
  const stopped = await call("TaskStop", { task_id: "cancel-route" });
  assert.equal(stopped.status, "stopped"); assert.equal(stopped.resolvedModel, undefined);
  svc.respond();
  assert.equal(await launchRunner(pending.agentId), 0);
  assert.equal(await startFollowUp(pending.agentId), false);
  assert.equal((await fs.readFile(path.join(directory, "started.jsonl"), "utf8")).trim().split("\n").length, 2);
});

test("后台选配先返回 PID；重复启动只建一个进程；已选组合和续任务持久化", async (t) => {
  const svc = await service(t);
  const f = await fixture("delayed selection");
  t.after(() => stopRun(f.id));
  const pid = await launchRunner(f.id);
  assert.ok(pid > 0);
  await until(() => svc.calls.length === 1);
  const selecting = (await readRun(f.id))!;
  assert.equal(selecting.status, "选配中");
  assert.equal(selecting.childPid, undefined);
  assert.deepEqual(await Promise.all([launchRunner(f.id), launchRunner(f.id)]), [pid, pid]);
  await continueRun(f.id, "补充证据");
  svc.respond();
  const run = await settled(f.id);
  assert.equal(run.status, "已完成");
  assert.equal(run.model, "openai-codex/gpt-6-astra");
  assert.equal(run.thinking, "high");
  assert.equal(run.routing!.mode, "jev");
  assert.match(run.finalText!, /--model openai-codex\/gpt-6-astra --thinking high/);
  assert.equal(await launchRunner(f.id), 0);
  const saved = JSON.parse(await fs.readFile(path.join(runDirectory(f.id), "request.json"), "utf8"));
  assert.equal(saved.routing, undefined);
  assert.equal(saved.routingDecision.model, run.model);
  assert.equal(JSON.stringify(saved).includes("fake-local-only-key"), false);
  assert.equal(await startFollowUp(f.id), true);
  const continued = await settled(f.id);
  assert.equal(svc.calls.length, 1);
  assert.equal(continued.model, run.model);
  assert.match(continued.finalText!, /补充证据/);
  const starts = (await fs.readFile(path.join(f.directory, "started.jsonl"), "utf8")).trim().split("\n");
  assert.equal(starts.length, 2);
  const results = await readCompletions(runDirectory(f.id));
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.routing?.model === run.model && result.thinking === "high"));
});

test("取消选配并清理追加要求；迟到的 Jev 响应不创建子进程，重试启动不复活", async (t) => {
  const svc = await service(t);
  const f = await fixture("cancel selection");
  t.after(() => stopRun(f.id));
  await launchRunner(f.id);
  await until(() => svc.calls.length === 1);
  await continueRun(f.id, "不能运行的后续任务");
  const stopped = await stopRun(f.id);
  assert.equal(stopped.status, "已停止");
  svc.respond();
  assert.equal(await launchRunner(f.id), 0);
  assert.equal(await startFollowUp(f.id), false);
  await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
  assert.equal((await readRun(f.id))!.stopRequested, true);
  assert.equal(alive(stopped.runnerPid), false);
});

test("无效选择使用原配置启动，回退原因进入最终结果", async (t) => {
  const svc = await service(t, "invalid");
  const f = await fixture("invalid selection");
  t.after(() => stopRun(f.id));
  await launchRunner(f.id);
  const run = await settled(f.id);
  assert.equal(svc.calls.length, 1);
  assert.equal(run.status, "已完成");
  assert.equal(run.model, "openai-codex/gpt-5.6-sol");
  assert.equal(run.thinking, "medium");
  assert.equal(run.routing!.mode, "fallback");
  assert.match(run.routing!.reason, /无效/);
  assert.match(run.finalText!, /gpt-5.6-sol --thinking medium/);
  const results = await readCompletions(runDirectory(f.id));
  assert.match(results[0].routing!.reason, /无效/);
});
