import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { prepareRouting } from "../src/routing.ts";
import { selectExecution, MODEL_PROFILES, type RoutingPlan } from "../src/router.mjs";
import { DEFAULT_CONFIG, parseDeckConfig, readDeckConfig, writeDeckConfig } from "../src/config.ts";
import { discoverAgents } from "../src/agents.ts";
import { registerRouting } from "../src/routing-ui.ts";
import { listRuns } from "../src/runtime.ts";

const sol: any = { provider: "openai-codex", id: "gpt-5.6-sol", reasoning: true, thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } };
const astra: any = { provider: "openai-codex", id: "gpt-6-astra", reasoning: true, thinkingLevelMap: { off: null, minimal: null, xhigh: "xhigh", max: "max" } };
const role = discoverAgents(process.cwd()).find((agent) => agent.id === "scout")!;
const context = (models = [sol, astra], model = sol) => ({ model, modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id) } });
const plan = () => prepareRouting(role, "调查认证失败，报告根因与证据", context(), structuredClone(DEFAULT_CONFIG), "high");
function answer(p: RoutingPlan, choice = "astra_high") {
  const probabilities = Object.fromEntries([...p.candidates.map((item) => item.id), "no_match"].map((id) => [id, id === choice ? 1 : 0]));
  return { model: "jev-1.13.0", answers: { execution_profile: { type: "choice", choice, confidence: 1, probabilities } }, usage: { input_tokens: 200, output_tokens: 0 } };
}
const fake = (body: any, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;

test("候选只包含同一提供商的可用模型及官方支持组合，角色不固定模型", () => {
  const p = plan();
  assert.equal(p.candidates.length, 11);
  assert.deepEqual(new Set(p.candidates.map((item) => item.id)), new Set(MODEL_PROFILES.map((item) => item.id)));
  assert.equal(p.candidates.some((item) => item.id === "astra_none"), false);
  assert.deepEqual(p.fallback, { model: "openai-codex/gpt-5.6-sol", thinking: "high" });
  const other = { ...astra, provider: "openai" };
  const restricted = prepareRouting(role, "调查", context([sol, other]), DEFAULT_CONFIG, "medium");
  assert.ok(restricted.candidates.every((item) => item.model === "openai-codex/gpt-5.6-sol"));
  assert.equal(restricted.candidates.length, 6);
  const legacy = { ...sol, id: "legacy", thinkingLevelMap: {} };
  assert.equal(prepareRouting(role, "调查", context([legacy], legacy), DEFAULT_CONFIG, "max").immediate?.thinking, "high");
});

test("明确模型或强度限制候选；双方固定跳过 Jev；最小强度显示实际映射", async () => {
  const byModel = prepareRouting({ ...role, model: "openai-codex/gpt-6-astra" }, "调查", context(), DEFAULT_CONFIG, "medium");
  assert.equal(byModel.candidates.length, 5);
  assert.ok(byModel.candidates.every((item) => item.model.endsWith("gpt-6-astra")));
  const byThinking = prepareRouting({ ...role, thinking: "high" }, "调查", context(), DEFAULT_CONFIG, "medium");
  assert.equal(byThinking.candidates.length, 2);
  assert.ok(byThinking.candidates.every((item) => item.thinking === "high"));
  const both = prepareRouting({ ...role, model: "openai-codex/gpt-5.6-sol", thinking: "high" }, "调查", context(), DEFAULT_CONFIG, "low",
    { model: "openai-codex/gpt-6-astra", thinking: "max" });
  assert.equal((await selectExecution(both, { fetch: (() => { throw new Error("must not call"); }) as any })).mode, "fixed");
  assert.equal(both.immediate!.model, "openai-codex/gpt-6-astra");
  assert.equal(both.immediate!.thinking, "max");
  const mapped = prepareRouting({ ...role, model: "openai-codex/gpt-5.6-sol", thinking: "minimal" }, "调查", context(), DEFAULT_CONFIG, "medium");
  assert.equal(mapped.immediate!.thinking, "low");
  assert.throws(() => prepareRouting({ ...role, model: "openai-codex/gpt-6-astra", thinking: "off" }, "调查", context(), DEFAULT_CONFIG, "medium"), /不支持固定/);
  const fixedOff = prepareRouting({ ...role, thinking: "off" }, "摘录", context([sol, astra], astra), DEFAULT_CONFIG, "medium");
  assert.equal(fixedOff.immediate!.model, "openai-codex/gpt-5.6-sol");
  assert.equal(fixedOff.immediate!.thinking, "off");
});

test("选配关闭、候选缺失、密钥缺失均可明确回退，不向网络发送请求", async () => {
  let calls = 0;
  const options = { apiKey: "", fetch: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch };
  assert.equal((await selectExecution(plan(), options)).mode, "fallback");
  const disabled = prepareRouting(role, "调查", context(), { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, enabled: false } }, "high");
  assert.equal((await selectExecution(disabled, options)).mode, "disabled");
  const absent = prepareRouting(role, "调查", context([], { ...sol, id: "gpt-5.5" }), DEFAULT_CONFIG, "medium");
  assert.match((await selectExecution(absent, options)).reason, /没有/);
  assert.equal(calls, 0);
});

test("真实本地 HTTP 验证 TypeSafe 请求结构和分布解析，输入只含子任务状态", async (t) => {
  const p = plan();
  let body: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.method, "POST");
    assert.equal(req.headers.authorization, "Bearer fake-test-key");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(answer(p)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as any).port;
  const decision = await selectExecution(p, { apiKey: "fake-test-key", fetch: (async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    return fetch("http://127.0.0.1:" + port, options);
  }) as typeof fetch });
  assert.equal(body.model, "jev-1.13.0");
  assert.equal(body.questions.execution_profile.type, "choice");
  assert.equal(Object.keys(body.questions.execution_profile.criteria).length, 12);
  assert.deepEqual(body.state, p.state);
  assert.equal(decision.mode, "jev");
  assert.equal(decision.model, "openai-codex/gpt-6-astra");
  assert.equal(decision.thinking, "high");
  assert.equal(decision.confidence, 1);
  assert.equal(decision.usage!.input_tokens, 200);
  assert.ok(decision.elapsedMs >= 0);
});

test("未知选择、缺项、非法分布与非 JSON 都回退，原始错误和密钥不进入记录", async () => {
  const p = plan();
  const mutations = [
    (body: any) => { body.answers.execution_profile.choice = "unapproved"; },
    (body: any) => { delete body.answers.execution_profile.probabilities.sol_low; },
    (body: any) => { body.answers.execution_profile.probabilities.sol_low = 2; },
    (body: any) => { body.answers.execution_profile.confidence = "sure"; },
    (body: any) => { body.answers.execution_profile.choice = "sol_medium"; },
  ];
  for (const mutate of mutations) {
    const body = answer(p); mutate(body);
    const d = await selectExecution(p, { apiKey: "secret-marker", fetch: fake(body) });
    assert.equal(d.mode, "fallback"); assert.match(d.reason, /无效/); assert.equal(d.model, p.fallback.model);
  }
  const unauthorized = await selectExecution(p, { apiKey: "secret-marker", fetch: fake({ error: "secret-marker" }, 401) });
  assert.match(unauthorized.reason, /HTTP 401/);
  assert.equal(JSON.stringify(unauthorized).includes("secret-marker"), false);
  const invalid = await selectExecution(p, { apiKey: "test", fetch: (async () => new Response("oops")) as typeof fetch });
  assert.match(invalid.reason, /无效/);
  const noMatch = await selectExecution(p, { apiKey: "test", fetch: fake(answer(p, "no_match")) });
  assert.equal(noMatch.mode, "fallback"); assert.match(noMatch.reason, /未找到合适/);
});

test("超时回退；调用方取消传播取消，不转成启动用的回退结果", async () => {
  const slowFetch = ((_url: any, options: any) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  })) as typeof fetch;
  const p = { ...plan(), timeoutMs: 20 };
  const timeout = await selectExecution(p, { apiKey: "test", fetch: slowFetch });
  assert.match(timeout.reason, /超时/);
  const controller = new AbortController();
  const pending = selectExecution({ ...p, timeoutMs: 10000 }, { apiKey: "test", fetch: slowFetch, signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("配置迁移忽略数量限制，未知与非法选配字段拒绝，默认值独立", async () => {
  assert.deepEqual(parseDeckConfig({ maxConcurrent: 1 }), DEFAULT_CONFIG);
  assert.throws(() => parseDeckConfig({ routing: { enabled: "yes" } }), /enabled/);
  assert.throws(() => parseDeckConfig({ routing: { timeoutMs: 0 } }), /timeoutMs/);
  assert.throws(() => parseDeckConfig({ routing: { apiKey: "do-not-store" } }), /不支持/);
  assert.throws(() => parseDeckConfig({ routing: { model: "made-up" } }), /模型 ID/);
  const a = parseDeckConfig({}); a.routing.enabled = false;
  assert.equal(parseDeckConfig({}).routing.enabled, true);
});

test("独立选配开关与试选真实命令工作，不改变派遣开关，不创建任务和角色", async () => {
  await writeDeckConfig({ ...DEFAULT_CONFIG, enabled: false });
  const commands = new Map<string, any>(), notices: string[] = [];
  registerRouting({ registerCommand: (name: string, command: any) => commands.set(name, command), getThinkingLevel: () => "high" } as any);
  const ctx: any = { ...context(), cwd: getAgentDir(), mode: "json", isProjectTrusted: () => false, ui: { notify: (text: string) => notices.push(text) } };
  const before = await listRuns(Number.MAX_SAFE_INTEGER);
  await commands.get("agent-router").handler("off", ctx);
  assert.equal(readDeckConfig().routing.enabled, false);
  assert.equal(readDeckConfig().enabled, false);
  await commands.get("agent-route-test").handler("explore 查找登录入口", ctx);
  assert.match(notices.at(-1)!, /自动选配关闭/);
  await commands.get("agent-router").handler("on", ctx);
  await commands.get("agent-route-test").handler("explore 查找登录入口", ctx);
  assert.match(notices.at(-1)!, /未配置 TYPESAFE_API_KEY/);
  assert.match(notices.at(-1)!, /未创建子任务/);
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER)).length, before.length);
  await assert.rejects(fs.access(path.join(getAgentDir(), "agents")));
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
});
