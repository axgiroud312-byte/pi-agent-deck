import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { initializeRun, launchRunner, readRun, runDirectory, stopRun, continueRun, startFollowUp, writeJsonAtomic } from "../src/runtime.ts";
import { readCompletions, alive } from "../src/persistence.mjs";
import type { RoutingPlan } from "../src/router.mjs";
import agentDeck from "../src/index.ts";
import { writeSavedJevKey } from "../src/jev-service.mjs";

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
    fallback: { model: "openai-codex/gpt-6-sol", thinking: "high" },
    candidates: [
      { id: "sol6_high", model: "openai-codex/gpt-6-sol", thinking: "high", criteria: "routine" },
      { id: "luna6_high", model: "openai-codex/gpt-6-luna", thinking: "high", criteria: "complex" },
    ],
    state: { task, role: "scout", roleDescription: "调查", writePermission: false, tools: ["read"] },
  };
}
async function fixture(task: string, routing = plan(task)) {
  const id = "routing-" + randomUUID();
  const directory = path.join(getAgentDir(), "fixtures", id);
  await fs.mkdir(directory, { recursive: true });
  const script = path.join(directory, "child.mjs");
  await fs.writeFile(script, [
    'import fs from "node:fs";',
    'fs.appendFileSync("started.jsonl",JSON.stringify(process.argv.slice(2))+"\\n");',
    'console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:process.argv.join(" ")}]}}));',
  ].join("\n"));
  const run: any = {
    version: 1, autoDeliver: true, runId: id, agentId: routing.state.role, agentName: "fixture", objective: task, instruction: task,
    status: "选配中", model: routing.fallback.model, thinking: routing.fallback.thinking, routingPending: true,
    tools: ["read"], writePermission: false, cwd: directory, parentSessionId: id, childSessionId: id, childSessionPath: path.join(directory, "child.jsonl"),
    startedAt: Date.now(), reports: [], events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  await initializeRun(run, { version: 1, cwd: directory, command: process.execPath, argsPrefix: [script, "--model", run.model, "--thinking", run.thinking], prompt: task, naturalOutput: true, routing }, true);
  return { id, directory };
}
async function service(t: any, responseMode: "delayed" | "invalid" = "delayed") {
  const calls: any[] = [];
  const authorizations: Array<string | undefined> = [];
  let respond: (() => void) | undefined;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push(body);
    authorizations.push(req.headers.authorization);
    const send = () => {
      res.setHeader("Content-Type", "application/json");
      const keys = Object.keys(body.questions.execution_profile.criteria);
      res.end(JSON.stringify(responseMode === "invalid" ? { invalid: true } : { model: "jev-1.13.0", answers: { execution_profile: { type: "choice", choice: "luna6_high", confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === "luna6_high" ? 1 : 0])) } } }));
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
  return { calls, authorizations, respond: () => { assert.ok(respond); respond(); } };
}

test("后台进程直接读取可视化保存的密钥，不依赖环境变量，不写入任务记录", async (t) => {
  const svc = await service(t);
  delete process.env.TYPESAFE_API_KEY;
  const file = path.join(getAgentDir(), "isolated-saved-credential.json");
  const key = "fake-saved-runner-credential";
  await writeSavedJevKey(file, key, undefined);
  const p = { ...plan("saved credential"), credentialFile: file };
  const f = await fixture("saved credential", p);
  t.after(() => stopRun(f.id));
  const requestFile = path.join(runDirectory(f.id), "request.json");
  const initial = await fs.readFile(requestFile, "utf8");
  assert.equal(JSON.parse(initial).routing.credentialFile, file);
  assert.ok(!initial.includes(key));
  await launchRunner(f.id);
  await until(() => svc.calls.length === 1);
  assert.equal(svc.authorizations[0], `Bearer ${key}`);
  svc.respond();
  const run = await settled(f.id);
  assert.equal(run.status, "已完成"); assert.equal(run.routing!.mode, "jev");
  assert.ok(!JSON.stringify(run).includes(key));
  assert.ok(!(await fs.readFile(requestFile, "utf8")).includes(key));
  assert.ok(!JSON.stringify(await readCompletions(runDirectory(f.id))).includes(key));
});

test("新工具串联 Jev：选配中不虚报模型，补充排队、继续不重选、停止阻断迟到启动", async (t) => {
  const svc = await service(t);
  const directory = path.join(getAgentDir(), "public-routing");
  await fs.mkdir(directory, { recursive: true });
  const cli = path.join(directory, "fake-pi.mjs");
  await fs.writeFile(cli, 'import fs from "node:fs";fs.appendFileSync("started.jsonl",JSON.stringify(process.argv.slice(2))+"\\n");console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:process.argv.at(-1)}]}}));');
  const sol: any = { provider: "openai-codex", id: "gpt-6-sol", reasoning: true, thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } };
  const luna: any = { ...sol, id: "gpt-6-luna", thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
  const tools = new Map<string, any>();
  agentDeck({ registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerMessageRenderer() {}, on() {}, getThinkingLevel: () => "medium" } as any);
  const ctx: any = { cwd: directory, model: sol, modelRegistry: { getAvailable: () => [sol, luna], find: (provider: string, id: string) => [sol, luna].find((model) => model.provider === provider && model.id === id) }, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "public-routing", getSessionFile: () => undefined } };
  const call = async (name: string, input: any) => (await tools.get(name).execute("call", input, undefined, undefined, ctx)).details.publicResult;
  const original = process.argv[1];
  const ids: string[] = [];
  t.after(async () => { process.argv[1] = original; for (const id of ids) await stopRun(id); });
  process.argv[1] = cli;
  const created = await call("Agent", { description: "复杂问题调查", prompt: "调查认证问题并给出证据", name: "routing-live", subagent_type: "Explore", model: "openai-codex/gpt-6-luna" });
  ids.push(created.agentId);
  await until(() => svc.calls.length === 1);
  assert.equal(created.status, "selecting"); assert.equal(created.resolvedModel, undefined); assert.equal(created.thinking, undefined);
  assert.equal((await call("SendMessage", { to: "routing-live", message: "保留最后的证据行" })).delivery, "queued");
  svc.respond();
  const first = await settled(created.agentId);
  assert.equal(first.model, "openai-codex/gpt-6-luna"); assert.equal(first.thinking, "high");
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
  assert.equal(run.model, "openai-codex/gpt-6-luna");
  assert.equal(run.thinking, "high");
  assert.equal(run.routing!.mode, "jev");
  assert.match(run.finalText!, /--model openai-codex\/gpt-6-luna --thinking high/);
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
  assert.equal(run.model, "openai-codex/gpt-6-sol");
  assert.equal(run.thinking, "high");
  assert.equal(run.routing!.mode, "fallback");
  assert.match(run.routing!.reason, /无效/);
  assert.match(run.finalText!, /gpt-6-sol --thinking high/);
  const results = await readCompletions(runDirectory(f.id));
  assert.match(results[0].routing!.reason, /无效/);
});

test("自定义审查角色的身份在选配后保留，继续沿用 GPT-5.6 Sol xhigh", async (t) => {
  const p = plan("custom review");
  p.fallback = { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" };
  p.candidates = [];
  p.state.role = "custom-review";
  p.state.review = true;
  const f = await fixture("custom review", p);
  t.after(() => stopRun(f.id));
  await launchRunner(f.id);
  const first = await settled(f.id);
  assert.equal(first.status, "已完成");
  assert.equal(first.model, p.fallback.model);
  assert.equal(first.thinking, "xhigh");
  const saved = JSON.parse(await fs.readFile(path.join(runDirectory(f.id), "request.json"), "utf8"));
  assert.equal(saved.review, true);
  assert.equal(saved.routing, undefined);
  await continueRun(f.id, "再检查边界情况");
  const resumed = await settled(f.id);
  assert.equal(resumed.status, "已完成");
  assert.equal(resumed.model, first.model);
  assert.equal(resumed.childSessionId, first.childSessionId);
  assert.equal(resumed.thinking, "xhigh");
  assert.equal((await fs.readFile(path.join(f.directory, "started.jsonl"), "utf8")).trim().split("\n").length, 2);
});

test("旧排队请求违规时持久化失败，不启动进程、不重复重试，补充内容保留", async () => {
  for (const [role, model, thinking] of [["reviewer", "gpt-6-astra", "max"], ["scout", "gpt-6-astra", "low"], ["scout", "gpt-6-astra", "medium"], ["reviewer", "gpt-5.6-sol", "high"], ["scout", "gpt-5.6-sol", "max"], ["scout", "gpt-6-luna", "medium"]] as const) {
    const p = plan("legacy queued");
    p.state.role = role;
    p.fallback = { model: `openai-codex/${model}`, thinking };
    const f = await fixture("legacy queued", p);
    await continueRun(f.id, "保留这条补充");
    assert.equal(await launchRunner(f.id), 0);
    const failed = (await readRun(f.id))!;
    assert.equal(failed.status, "失败");
    assert.match(failed.stderr!, /模型策略不允许/);
    assert.equal(failed.policyBlocked, true);
    assert.equal(await launchRunner(f.id), 0);
    assert.equal(await startFollowUp(f.id), false);
    assert.equal((await readCompletions(runDirectory(f.id))).length, 1);
    await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
    assert.match(await fs.readFile(path.join(runDirectory(f.id), "follow-up.json"), "utf8"), /保留这条补充/);
  }
});

test("旧已结束任务继续前检查保存决策及实际启动参数，拒绝时请求、状态和队列均不变", async () => {
  for (const mismatch of [false, true]) {
    const f = await fixture("legacy ended");
    const directory = runDirectory(f.id);
    const run = (await readRun(f.id))!;
    await writeJsonAtomic(path.join(directory, "status.json"), { ...run, status: "已完成", endedAt: Date.now(), finalText: "old result" });
    const request = JSON.parse(await fs.readFile(path.join(directory, "request.json"), "utf8"));
    delete request.routing;
    request.routingDecision = { model: "openai-codex/gpt-6-sol", thinking: mismatch ? "high" : "medium", mode: "fixed", elapsedMs: 0, reason: "old" };
    request.argsPrefix[request.argsPrefix.indexOf("--thinking") + 1] = "medium";
    await writeJsonAtomic(path.join(directory, "request.json"), request);
    const before = await Promise.all(["request.json", "status.json"].map((name) => fs.readFile(path.join(directory, name), "utf8")));
    await assert.rejects(continueRun(f.id, "new instruction"), /最低思考强度为 high/);
    const after = await Promise.all(["request.json", "status.json"].map((name) => fs.readFile(path.join(directory, name), "utf8")));
    assert.deepEqual(after, before);
    await assert.rejects(fs.access(path.join(directory, "follow-up.json")));
    await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
    // Previously queued messages remain available, but automatic retries stop after one notice.
    await writeJsonAtomic(path.join(directory, "follow-up.json"), [{ id: "queued", message: "old message", summary: "old message", at: Date.now() }]);
    await assert.rejects(startFollowUp(f.id), /最低思考强度为 high/);
    assert.equal(await startFollowUp(f.id), false);
    assert.equal((await readRun(f.id))!.status, "已完成");
  }
});


test("直接启动独立 Runner 也会拦截违规旧请求，实际子进程不会启动", async () => {
  for (const choice of [{ model: "openai-codex/gpt-6-sol", thinking: "low" as const }, { model: "openai-codex/gpt-6-astra", thinking: "medium" as const }]) {
    const p = plan("direct legacy runner");
    p.fallback = choice;
    const f = await fixture("direct legacy runner", p);
    await promisify(execFile)(process.execPath, [fileURLToPath(new URL("../src/runner.mjs", import.meta.url)), "--run-dir", runDirectory(f.id)], { windowsHide: true, timeout: 15000 });
    const failed = (await readRun(f.id))!;
    assert.equal(failed.status, "失败");
    assert.ok(failed.events.some((event) => /最低思考强度为 high|gpt-6-astra 已停用/.test(event.text)));
    assert.equal((await readCompletions(runDirectory(f.id))).length, 1);
    await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
  }
});

test("旧 Astra 任务的已选决策或启动参数都不能继续，保留原结果和文件", async () => {
  for (const savedDecision of [true, false]) {
    const f = await fixture("legacy Astra ended");
    const directory = runDirectory(f.id);
    await writeJsonAtomic(path.join(directory, "status.json"), { ...(await readRun(f.id)), status: "已完成", endedAt: Date.now(), finalText: "原结果" });
    const request = JSON.parse(await fs.readFile(path.join(directory, "request.json"), "utf8"));
    delete request.routing;
    request.routingDecision = { model: savedDecision ? "openai-codex/gpt-6-astra" : "openai-codex/gpt-6-sol", thinking: "high", mode: "fixed", elapsedMs: 0, reason: "old" };
    if (!savedDecision) request.argsPrefix[request.argsPrefix.indexOf("--model") + 1] = "openai-codex/gpt-6-astra";
    await writeJsonAtomic(path.join(directory, "request.json"), request);
    const before = await Promise.all(["request.json", "status.json"].map((name) => fs.readFile(path.join(directory, name), "utf8")));
    await assert.rejects(continueRun(f.id, "继续检查"), /gpt-6-astra 已停用/);
    assert.deepEqual(await Promise.all(["request.json", "status.json"].map((name) => fs.readFile(path.join(directory, name), "utf8"))), before);
    await assert.rejects(fs.access(path.join(directory, "follow-up.json")));
    await assert.rejects(fs.access(path.join(f.directory, "started.jsonl")));
  }
});
