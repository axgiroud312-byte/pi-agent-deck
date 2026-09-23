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
const sol6 = { ...sol, id: "gpt-6-sol", api: "openai-codex-responses" };
const luna6 = { ...sol6, id: "gpt-6-luna" };
const reviewer = discoverAgents(process.cwd()).find((agent) => agent.id === "reviewer")!;
const context = (models = [sol, astra, sol6, luna6], model = sol6) => ({ model, modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((item) => item.provider === provider && item.id === id) } });
const plan = () => prepareRouting(role, "调查认证失败，报告根因与证据", context(), structuredClone(DEFAULT_CONFIG), "high");
function answer(p: RoutingPlan, choice = "luna6_xhigh") {
  const probabilities = Object.fromEntries([...p.candidates.map((item) => item.id), "no_match"].map((id) => [id, id === choice ? 1 : 0]));
  return { model: "jev-1.13.0", answers: { execution_profile: { type: "choice", choice, confidence: 1, probabilities } }, usage: { input_tokens: 200, output_tokens: 0 } };
}
const fake = (body: any, status = 200) => (async () => Response.json(body, { status })) as typeof fetch;

test("停用 Astra 后三模型共 8 组合；非审查池 6 个，审查池仅 GPT-5.6 Sol 的两档", async () => {
  const p = plan();
  assert.equal(MODEL_PROFILES.length, 8);
  assert.equal(p.candidates.length, 6);
  assert.equal(new Set(p.candidates.map((item) => item.id)).size, 6);
  assert.ok(p.candidates.every((item) => !item.model.endsWith("/gpt-6-astra")));
  assert.ok(p.candidates.every((item) => !item.model.endsWith("/gpt-5.6-sol")));
  assert.deepEqual(p.fallback, { model: "openai-codex/gpt-6-sol", thinking: "high" });
  for (const model of [sol6, luna6]) {
    assert.deepEqual(p.candidates.filter((item) => item.model.endsWith("/" + model.id)).map((item) => item.thinking), ["high", "xhigh", "max"]);
    const fixed = prepareRouting(role, "明确指定模型", context(), DEFAULT_CONFIG, "off", { model: `openai-codex/${model.id}` });
    assert.equal(fixed.candidates.length, 3);
    assert.equal(fixed.fallback.thinking, "high");
  }
  for (const agent of [reviewer, { ...role, id: "custom-audit", reportProfile: "审查" as const }, { ...reviewer, reportProfile: "通用" as const }]) {
    const review = prepareRouting(agent, "审查代码", context(), DEFAULT_CONFIG, "off");
    assert.deepEqual(review.candidates.map((item) => item.id), ["sol_xhigh", "sol_max"]);
    assert.equal(review.state.review, true);
    assert.deepEqual(review.fallback, { model: "openai-codex/gpt-5.6-sol", thinking: "xhigh" });
    const chosen = await selectExecution(review, { apiKey: "fake", fetch: fake(answer(review, "sol_max")) });
    assert.equal(chosen.thinking, "max");
    assert.equal(chosen.model, review.fallback.model);
  }
  for (const id of ["sol6_high", "luna6_xhigh"]) {
    assert.equal((await selectExecution(p, { apiKey: "fake", fetch: fake(answer(p, id)) })).profileId, id);
  }
});

test("候选过滤账户和档位；继承违规模型时使用同一提供商的合规模型", () => {
  const limitedLuna = { ...luna6, thinkingLevelMap: { off: null, minimal: "low", xhigh: null, max: null } };
  const p = prepareRouting(role, "调查", context([sol, { ...sol6, provider: "other" }, limitedLuna], sol), DEFAULT_CONFIG, "off");
  assert.deepEqual(p.candidates.map((item) => item.id), ["luna6_high"]);
  assert.deepEqual(p.fallback, { model: "openai-codex/gpt-6-luna", thinking: "high" });
  assert.throws(() => prepareRouting(reviewer, "审查", context([sol6, { ...sol, provider: "other" }]), DEFAULT_CONFIG, "max"), /没有.*可用配置/);
  assert.throws(() => prepareRouting(role, "调查", context([sol, { ...astra, provider: "other" }], sol), DEFAULT_CONFIG, "high"), /符合模型策略/);
  const legacy = { ...sol, id: "legacy", thinkingLevelMap: {} };
  assert.equal(prepareRouting(role, "调查", context([legacy], legacy), DEFAULT_CONFIG, "max").immediate?.thinking, "high");
  const downgraded = { ...sol, thinkingLevelMap: { xhigh: "high", max: "high" } };
  assert.throws(() => prepareRouting(reviewer, "审查", context([downgraded, astra], astra), DEFAULT_CONFIG, "max"), /没有.*可用配置/);
  const mapped = { ...sol6, thinkingLevelMap: { high: "low", xhigh: "xhigh", max: "max" } };
  const filtered = prepareRouting(role, "实现", context([mapped], mapped), DEFAULT_CONFIG, "high");
  assert.equal(filtered.fallback.thinking, "xhigh");
  assert.deepEqual(filtered.candidates.map((item) => item.thinking), ["xhigh", "max"]);
});

test("GPT-6 Sol/Luna 的 Chat Completions 配置无法满足最低 high，派遣前拒绝", () => {
  for (const id of ["gpt-6-sol", "gpt-6-luna"]) {
    const model = { ...sol, id, api: "openai-completions" };
    const ctx = context([model], model);
    assert.throws(() => prepareRouting(role, "小任务", ctx, DEFAULT_CONFIG, "off"), /Responses/);
    assert.throws(() => prepareRouting({ ...role, model: `${model.provider}/${id}`, thinking: "high" }, "调查", ctx, DEFAULT_CONFIG, "high"), /Responses/);
  }
});

test("显式角色与覆盖值不能绕过专用模型和强度下限；自动选配关闭仍执行策略", async () => {
  for (const enabled of [true, false]) {
    const config = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, enabled } };
    for (const model of [sol6, luna6]) {
      for (const thinking of ["off", "minimal", "low", "medium"] as const) {
        assert.throws(() => prepareRouting(role, "实现", context(), config, "high", { model: `${model.provider}/${model.id}`, thinking }), /最低思考强度/);
      }
      const d = prepareRouting(role, "实现", context([model], model), config, "off");
      assert.equal(d.fallback.thinking, "high");
      assert.equal((await selectExecution(d, { apiKey: "" })).thinking, "high");
    }
    for (const thinking of ["off", "low", "medium", "high"] as const) {
      assert.throws(() => prepareRouting({ ...reviewer, thinking }, "审查", context(), config, "max"), /最低 xhigh/);
    }
    for (const model of [astra, sol6, luna6]) {
      assert.throws(() => prepareRouting(reviewer, "审查", context(), config, "max", { model: `${model.provider}/${model.id}` }), /审查 Agent 只能/);
    }
    assert.throws(() => prepareRouting(role, "实现", context(), config, "max", { model: "openai-codex/gpt-5.6-sol" }), /仅供审查/);
    const r = prepareRouting(reviewer, "审查", context(), config, "medium");
    const fallback = await selectExecution(r, { apiKey: "" });
    assert.equal(fallback.model, "openai-codex/gpt-5.6-sol");
    assert.equal(fallback.thinking, "xhigh");
  }
});

test("明确配置限制候选并跳过 Jev；剩余模型不接受固定的 low 强度", async () => {
  const byModel = prepareRouting({ ...role, model: "openai-codex/gpt-6-luna" }, "调查", context(), DEFAULT_CONFIG, "medium");
  assert.equal(byModel.candidates.length, 3);
  const byThinking = prepareRouting({ ...role, thinking: "high" }, "调查", context(), DEFAULT_CONFIG, "medium");
  assert.equal(byThinking.candidates.length, 2);
  assert.ok(byThinking.candidates.every((item) => item.thinking === "high"));
  const both = prepareRouting({ ...role, model: "openai-codex/gpt-6-sol", thinking: "high" }, "调查", context(), DEFAULT_CONFIG, "low",
    { model: "openai-codex/gpt-6-luna", thinking: "max" });
  assert.equal((await selectExecution(both, { fetch: (() => { throw new Error("must not call"); }) as any })).mode, "fixed");
  assert.equal(both.immediate!.model, "openai-codex/gpt-6-luna");
  assert.equal(both.immediate!.thinking, "max");
  assert.throws(() => prepareRouting({ ...role, thinking: "low" }, "调查", context(), DEFAULT_CONFIG, "medium"), /不支持固定/);
  const legacy = { ...sol, id: "legacy" };
  const mapped = prepareRouting({ ...role, model: "openai-codex/legacy", thinking: "minimal" }, "调查", context([legacy], legacy), DEFAULT_CONFIG, "medium");
  assert.equal(mapped.immediate!.thinking, "low");
  assert.throws(() => prepareRouting({ ...role, model: "openai-codex/gpt-6-astra", thinking: "off" }, "调查", context(), DEFAULT_CONFIG, "medium"), /已停用/);
});

test("Astra 在所有强度、显式覆盖、角色固定、继承与关闭 Jev 情况下都不能启动", async () => {
  for (const enabled of [true, false]) {
    const config = { ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, enabled } };
    for (const thinking of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      assert.throws(() => prepareRouting(role, "调查", context(), config, thinking, { model: "openai-codex/gpt-6-astra", thinking }), /已停用/);
      assert.throws(() => prepareRouting({ ...role, model: "openai-codex/gpt-6-astra", thinking }, "调查", context(), config, "high"), /已停用/);
      const inherited = prepareRouting(role, "调查", context([astra, sol6, luna6], astra), config, thinking);
      const selected = await selectExecution(inherited, { apiKey: "" });
      assert.equal(selected.model, "openai-codex/gpt-6-sol");
      assert.ok(["high", "xhigh", "max"].includes(selected.thinking));
    }
    const luna = prepareRouting(role, "调查", context([astra, luna6], astra), config, "low");
    assert.deepEqual(luna.fallback, { model: "openai-codex/gpt-6-luna", thinking: "high" });
    assert.throws(() => prepareRouting(role, "调查", context([astra, { ...sol6, provider: "other" }], astra), config, "max"), /没有符合模型策略/);
  }
});

test("旧选配快照的违规候选被过滤，违规回退和 immediate 在网络请求前拒绝", async () => {
  const p = plan();
  const legacy = { ...p, candidates: [...p.candidates, { id: "sol_low", model: "openai-codex/gpt-5.6-sol", thinking: "low" as const, criteria: "old" },
    ...(["low", "medium", "high", "xhigh", "max"] as const).map((thinking) => ({ id: `astra_${thinking}`, model: "openai-codex/gpt-6-astra", thinking, criteria: "old" }))] };
  const result = await selectExecution(legacy, { apiKey: "fake", fetch: (async (_url, options) => {
    const body = JSON.parse(options!.body as string);
    assert.equal(body.questions.execution_profile.criteria.sol_low, undefined);
    assert.ok(Object.keys(body.questions.execution_profile.criteria).every((id) => !id.startsWith("astra_")));
    return Response.json(answer(p));
  }) as typeof fetch });
  assert.equal(result.mode, "jev");
  for (const choice of [{ model: "openai-codex/gpt-5.6-sol", thinking: "max" as const }, { model: "openai-codex/gpt-6-luna", thinking: "low" as const }, { model: "openai-codex/gpt-6-astra", thinking: "low" as const }]) {
    await assert.rejects(selectExecution({ ...p, fallback: choice }, { apiKey: "" }), /模型策略不允许/);
    await assert.rejects(selectExecution({ ...p, immediate: { ...choice, mode: "disabled", reason: "old", elapsedMs: 0 } }), /模型策略不允许/);
  }
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
  assert.equal(Object.keys(body.questions.execution_profile.criteria).length, 7);
  assert.deepEqual(body.state, p.state);
  assert.equal(decision.mode, "jev");
  assert.equal(decision.model, "openai-codex/gpt-6-luna");
  assert.equal(decision.thinking, "xhigh");
  assert.equal(decision.confidence, 1);
  assert.equal(decision.usage!.input_tokens, 200);
  assert.ok(decision.elapsedMs >= 0);
});

test("未知选择、缺项、非法分布与非 JSON 都回退，原始错误和密钥不进入记录", async () => {
  const p = plan();
  const mutations = [
    (body: any) => { body.answers.execution_profile.choice = "unapproved"; },
    (body: any) => { delete body.answers.execution_profile.probabilities.sol6_high; },
    (body: any) => { body.answers.execution_profile.probabilities.sol6_high = 2; },
    (body: any) => { body.answers.execution_profile.confidence = "sure"; },
    (body: any) => { body.answers.execution_profile.choice = "luna6_high"; },
    (body: any) => { body.answers.execution_profile.choice = "astra_low"; },
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
  assert.match(notices.at(-1)!, /未配置 Jev 密钥/);
  assert.match(notices.at(-1)!, /未创建子任务/);
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER)).length, before.length);
  await assert.rejects(fs.access(path.join(getAgentDir(), "agents")));
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
});
