import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { prepareRouting } from "../src/routing.ts";
import { selectExecution, type RoutingPlan } from "../src/router.mjs";
import { DEFAULT_CONFIG, parseDeckConfig, readDeckConfig, writeDeckConfig } from "../src/config.ts";
import { discoverAgents } from "../src/agents.ts";
import { registerRouting } from "../src/routing-ui.ts";
import { listRuns } from "../src/runtime.ts";

const levels = { off: "none", minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
const sol: any = { provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol", reasoning: true, thinkingLevelMap: levels };
const astra: any = { ...sol, id: "gpt-6-astra", name: "Astra" };
const sol6: any = { ...sol, id: "gpt-6-sol", name: "Sol 6" };
const luna6: any = { ...sol, id: "gpt-6-luna", name: "Luna 6" };
const models = [sol, astra, sol6, luna6];
const scout = discoverAgents(process.cwd()).find((agent) => agent.id === "scout")!;
const reviewer = discoverAgents(process.cwd()).find((agent) => agent.id === "reviewer")!;
const context = (available = models, model = sol6) => ({
  model,
  modelRegistry: {
    getAvailable: () => available,
    find: (provider: string, id: string) => available.find((item) => item.provider === provider && item.id === id),
  },
});
const plan = () => prepareRouting(scout, "调查认证失败，报告根因与证据", context(), structuredClone(DEFAULT_CONFIG), "high");
function answer(p: RoutingPlan, choice = p.candidates.at(-1)?.id ?? "no_match") {
  const probabilities = Object.fromEntries([...p.candidates.map((item) => item.id), "no_match"].map((id) => [id, id === choice ? 1 : 0]));
  return { model: "jev-1.13.0", answers: { execution_profile: { type: "choice", choice, confidence: 1, probabilities } }, usage: { input_tokens: 200, output_tokens: 0 } };
}
const fake = (body: any, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;

test("Jev 候选来自 Pi 当前可用模型与思考档位，不按角色或型号硬过滤", () => {
  const scoutPlan = plan();
  const reviewPlan = prepareRouting(reviewer, "审查代码", context(), DEFAULT_CONFIG, "high");
  for (const model of models) {
    assert.ok(scoutPlan.candidates.some((item) => item.model.endsWith(`/${model.id}`)), model.id);
    assert.ok(reviewPlan.candidates.some((item) => item.model.endsWith(`/${model.id}`)), model.id);
  }
  assert.ok(scoutPlan.candidates.some((item) => item.model.endsWith("/gpt-6-astra")));
  assert.deepEqual(reviewPlan.state, { task: "审查代码", role: "reviewer", roleDescription: reviewer.description, tools: reviewer.tools });
  assert.deepEqual(scoutPlan.fallback, { model: "openai-codex/gpt-6-sol", thinking: "high" });
});

test("不可用模型偏好和不支持的思考档位会软回退，不阻止任务", () => {
  const unavailable = prepareRouting({ ...scout, model: "missing/model", thinking: "max" }, "调查", context([luna6], luna6), DEFAULT_CONFIG, "off");
  assert.equal(unavailable.fallback.model, "openai-codex/gpt-6-luna");
  assert.match(unavailable.immediate?.reason ?? "", /不可用|没有匹配/);
  const limited: any = { ...sol6, thinkingLevelMap: { off: "none", minimal: "low", low: "low", medium: null, high: null, xhigh: null, max: null } };
  const adjusted = prepareRouting({ ...scout, thinking: "max" }, "调查", context([limited], limited), DEFAULT_CONFIG, "max");
  assert.ok(["off", "low"].includes(adjusted.fallback.thinking));
});

test("明确可用模型与 thinking 原样优先，Jev 关闭也正常执行", async () => {
  const fixed = prepareRouting(scout, "调查", context(), DEFAULT_CONFIG, "low", { model: "openai-codex/gpt-6-astra", thinking: "low" });
  assert.equal(fixed.immediate?.mode, "fixed");
  assert.equal(fixed.immediate?.model, "openai-codex/gpt-6-astra");
  assert.equal(fixed.immediate?.thinking, "low");
  const selected = await selectExecution(fixed, { fetch: (() => { throw new Error("must not call"); }) as any });
  assert.equal(selected.mode, "fixed");
  const disabled = prepareRouting(scout, "调查", context(), { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, enabled: false } }, "high");
  assert.equal((await selectExecution(disabled, { apiKey: "" })).mode, "disabled");
});

test("真实本地 HTTP 验证 Jev 请求、选择和用量解析", async (t) => {
  const p = plan();
  const choice = p.candidates.find((item) => item.model.endsWith("/gpt-6-astra") && item.thinking === "xhigh")!;
  let body: any;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(req.headers.authorization, "Bearer fake-test-key");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(answer(p, choice.id)));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const port = (server.address() as any).port;
  const decision = await selectExecution(p, { apiKey: "fake-test-key", fetch: (async (_url, options) => fetch(`http://127.0.0.1:${port}`, options)) as typeof fetch });
  assert.equal(body.model, "jev-1.13.0");
  assert.deepEqual(body.state, { task: p.state.task, role: p.state.role, roleDescription: p.state.roleDescription });
  assert.equal(decision.model, choice.model);
  assert.equal(decision.thinking, "xhigh");
  assert.equal(decision.usage?.input_tokens, 200);
});

test("未知选择、缺项、非法分布、非 JSON 和 HTTP 错误都回退且不泄漏密钥", async () => {
  const p = plan();
  const first = p.candidates[0].id;
  const mutations = [
    (body: any) => { body.answers.execution_profile.choice = "unknown"; },
    (body: any) => { delete body.answers.execution_profile.probabilities[first]; },
    (body: any) => { body.answers.execution_profile.probabilities[first] = 2; },
    (body: any) => { body.answers.execution_profile.confidence = "sure"; },
  ];
  for (const mutate of mutations) {
    const body = answer(p); mutate(body);
    const result = await selectExecution(p, { apiKey: "secret-marker", fetch: fake(body) });
    assert.equal(result.mode, "fallback");
    assert.match(result.reason, /无效/);
  }
  const unauthorized = await selectExecution(p, { apiKey: "secret-marker", fetch: fake({ error: "secret-marker" }, 401) });
  assert.match(unauthorized.reason, /HTTP 401/);
  assert.equal(JSON.stringify(unauthorized).includes("secret-marker"), false);
  assert.match((await selectExecution(p, { apiKey: "x", fetch: (async () => new Response("oops")) as typeof fetch })).reason, /无效/);
  assert.match((await selectExecution(p, { apiKey: "x", fetch: fake(answer(p, "no_match")) })).reason, /未找到合适/);
});

test("无候选、无密钥和 Jev 超时都回退；调用方取消继续传播", async () => {
  let calls = 0;
  const noKey = await selectExecution(plan(), { apiKey: "", fetch: (async () => { calls++; throw new Error("unexpected"); }) as typeof fetch });
  assert.equal(noKey.mode, "fallback");
  const absent = prepareRouting(scout, "调查", context([], { ...sol, id: "other" }), DEFAULT_CONFIG, "medium");
  assert.match((await selectExecution(absent, { apiKey: "" })).reason, /没有匹配|没有可供/);
  assert.equal(calls, 0);
  const slowFetch = ((_url: any, options: any) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }))) as typeof fetch;
  assert.match((await selectExecution({ ...plan(), timeoutMs: 20 }, { apiKey: "x", fetch: slowFetch })).reason, /超时/);
  const controller = new AbortController();
  const pending = selectExecution({ ...plan(), timeoutMs: 10_000 }, { apiKey: "x", fetch: slowFetch, signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
});

test("配置迁移忽略旧数量限制，未知与非法选配字段拒绝，默认值独立", () => {
  assert.deepEqual(parseDeckConfig({ maxConcurrent: 1 }), DEFAULT_CONFIG);
  assert.throws(() => parseDeckConfig({ routing: { enabled: "yes" } }), /enabled/);
  assert.throws(() => parseDeckConfig({ routing: { timeoutMs: 0 } }), /timeoutMs/);
  assert.throws(() => parseDeckConfig({ routing: { apiKey: "do-not-store" } }), /不支持/);
  assert.throws(() => parseDeckConfig({ routing: { model: "made-up" } }), /模型 ID/);
  const changed = parseDeckConfig({}); changed.routing.enabled = false;
  assert.equal(parseDeckConfig({}).routing.enabled, true);
});

test("独立选配开关与试选命令不改变派遣开关，也不创建任务或角色", async () => {
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
  assert.match(notices.at(-1)!, /未配置 Jev 密钥/);
  assert.match(notices.at(-1)!, /未创建子任务/);
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER)).length, before.length);
  await assert.rejects(fs.access(path.join(getAgentDir(), "agents")));
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
});
