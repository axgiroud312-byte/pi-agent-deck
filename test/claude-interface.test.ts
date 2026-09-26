import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import test from "node:test";
import { getAgentDir, DefaultResourceLoader, SettingsManager, ModelRuntime, ModelRegistry } from "@earendil-works/pi-coding-agent";
import agentDeck from "../src/index.ts";
import { DEFAULT_CONFIG, parseDeckConfig, readDeckConfig, writeDeckConfig } from "../src/config.ts";
import { discoverAgents } from "../src/agents.ts";
import { initializeRun, listRuns, readRun, runDirectory, stopRun, writeJsonAtomic } from "../src/runtime.ts";
import { resolveTaskTarget } from "../src/task-identity.ts";
import { publicTaskResult, resolveAgentRole } from "../src/tool-contract.ts";
import { readCompletions } from "../src/persistence.mjs";

async function until<T>(check: () => Promise<T | undefined | false>): Promise<T> {
  const end = Date.now() + 15000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("Claude interface fixture timed out");
}
async function settled(id: string) {
  await until(async () => { const run = await readRun(id); return !!run && ["已完成", "失败", "已停止", "已取消", "等待决定"].includes(run.status); });
  return (await readRun(id))!;
}
async function harness(t: any, duration = 350) {
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
  const cwd = path.join(getAgentDir(), "fixtures", randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  const cli = path.join(cwd, "fixture-cli.mjs");
  await fs.writeFile(cli, String.raw`import fs from "node:fs";
import readline from "node:readline";
const args = process.argv.slice(2), option = (name) => args[args.indexOf(name) + 1];
const log = (value) => fs.appendFileSync("executions.jsonl", JSON.stringify(value) + "\n");
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
let streaming = false;
let prompt = "";
let queued = [];
function reply(command, data = {}) { emit({ type: "response", id: command.id, command: command.type, success: true, data }); }
function complete(text) {
  streaming = false;
  emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] } });
  emit({ type: "agent_settled" });
}
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") return reply(command, { isStreaming: streaming });
  if (command.type === "set_steering_mode" || command.type === "clear_queue" || command.type === "abort") return reply(command);
  if (command.type === "steer" || (command.type === "prompt" && streaming && command.streamingBehavior === "steer")) {
    queued.push(command.message);
    log({ type: "steer", message: command.message });
    return reply(command);
  }
  if (command.type !== "prompt") return reply(command);
  streaming = true;
  prompt = command.message;
  queued = [];
  log({ type: "prompt", message: prompt, args: process.argv.slice(2) });
  reply(command);
  setTimeout(() => complete([prompt, ...queued].join("\n")), ${duration});
});`);
  const originalCli = process.argv[1];
  process.argv[1] = cli;
  const tools = new Map<string, any>(), handlers = new Map<string, any>(), commands = new Map<string, any>();
  const messages: any[] = [], entries: any[] = [], notices: string[] = [];
  let active: string[] = [];
  agentDeck({
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand: (name: string, command: any) => commands.set(name, command), registerMessageRenderer() {},
    on: (name: string, fn: any) => handlers.set(name, fn),
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; }, getThinkingLevel: () => "high",
    sendMessage: (message: any) => { messages.push(message); entries.push({ type: "custom_message", ...message }); },
  } as any);
  const models = ["default", "explicit", "role", "unavailable"].map((id) => ({ provider: "fixture", id, reasoning: true }));
  const parent = randomUUID();
  const ctx: any = { cwd, isProjectTrusted: () => true, model: models[0],
    modelRegistry: { find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id), getAvailable: () => models.filter((model) => model.id !== "unavailable") },
    sessionManager: { getSessionId: () => parent, getSessionFile: () => undefined, getBranch: () => entries },
    ui: { setStatus() {}, setWidget() {}, notify: (text: string) => notices.push(text), theme: { fg: (_: string, text: string) => text } },
  };
  const call = (tool: string, args: any, context = ctx) => tools.get(tool).execute(randomUUID(), args, undefined, undefined, context);
  t.after(async () => {
    await handlers.get("session_shutdown")(); process.argv[1] = originalCli;
    for (const run of await listRuns(Number.MAX_SAFE_INTEGER)) if (run.cwd === cwd) await stopRun(run.runId);
    await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
  });
  return { cwd, cli, parent, ctx, tools, handlers, commands, messages, entries, notices, call, active: () => active };
}
const input = { description: "检查入口", prompt: "阅读入口并报告证据。", subagent_type: "Explore", run_in_background: true };
const receipt = (result: any) => result.details.publicResult;

test("第 9 个公开 Agent 调用不受固定产品容量限制，Agent 描述承载角色与并行指导", async (t) => {
  const h = await harness(t, 60_000);
  const created = await Promise.all(Array.from({ length: 9 }, (_, i) => h.call("Agent", { ...input, name: `slot-${i}` })));
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER, h.parent)).length, 9);
  assert.equal((await resolveTaskTarget("slot-8", h.parent)).runId, receipt(created[8]).agentId);
  assert.equal(await h.handlers.get("before_agent_start")({}, h.ctx), undefined);
  assert.equal(h.tools.get("Agent").executionMode, "parallel");
  assert.match(h.tools.get("Agent").description, /同一模型轮次.*多个.*Agent/);
  assert.match(h.tools.get("Agent").description, /同一工作目录.*一个.*实施者/);
  assert.match(h.tools.get("Agent").description, /reviewer.*Bash.*只读/);
  assert.match(h.tools.get("Agent").description, /reviewer/);
  assert.doesNotMatch(h.tools.get("Agent").description, /8\/8|最多 8|writePermission/);
  await Promise.all(created.map((result) => h.call("TaskStop", { task_id: receipt(result).agentId })));
});

test("Agent 工具描述随可信项目角色的职责、工具、排除项和扩展动态刷新", async (t) => {
  const h = await harness(t);
  const directory = path.join(h.cwd, ".pi", "agents");
  await fs.mkdir(directory, { recursive: true });
  const roleFile = path.join(directory, "dynamic.md");
  await fs.writeFile(roleFile, "---\nid: dynamic\nname: 动态角色\ndescription: 第一版职责\ntools: [read, bash]\ndisallowedTools: [edit, write]\nextensions: [./local-extension.ts]\n---\n只读检查。\n");
  await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.match(h.tools.get("Agent").description, /dynamic（动态角色）：第一版职责；tools=read, bash；排除=edit, write；extensions=1/);

  await fs.writeFile(roleFile, "---\nid: dynamic\nname: 动态角色\ndescription: 第二版职责\ntools: []\ndisallowedTools: [edit, write]\nextensions: []\n---\n只读检查。\n");
  await h.handlers.get("before_agent_start")({}, h.ctx);
  assert.match(h.tools.get("Agent").description, /dynamic（动态角色）：第二版职责；tools=无；排除=edit, write；extensions=0/);
  assert.doesNotMatch(h.tools.get("Agent").description, /第一版职责/);
});

test("公开 Agent 接口允许 Astra 等 Pi 可用模型及配置别名", async (t) => {
  const h = await harness(t);
  const models = [...h.ctx.modelRegistry.getAvailable(), { provider: "fixture", id: "gpt-6-astra", reasoning: true }];
  h.ctx.modelRegistry.getAvailable = () => models;
  h.ctx.modelRegistry.find = (provider: string, id: string) => models.find((model: any) => model.provider === provider && model.id === id);
  await writeDeckConfig({ modelAliases: { blockedAstra: "fixture/gpt-6-astra" } });
  let sessionCreations = 0;
  h.ctx.sessionManager.getSessionFile = () => { sessionCreations++; return undefined; };
  for (const model of ["fixture/gpt-6-astra", "blockedAstra"]) {
    const result = receipt(await h.call("Agent", { ...input, model }));
    const run = await settled(result.agentId);
    assert.equal(run.model, "fixture/gpt-6-astra");
  }
  assert.equal(sessionCreations, 2);
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER, h.parent)).length, 2);
});

test("无效参数和不可用模型在创建任务、Session、名称绑定和消息队列前拒绝", async (t) => {
  const h = await harness(t);
  let sessionCreations = 0;
  h.ctx.sessionManager.getSessionFile = () => { sessionCreations++; return undefined; };
  const invalid = [
    { ...input, description: " " }, { ...input, prompt: "\n" }, { ...input, name: " " },
    { ...input, subagent_type: " " }, { ...input, model: " " },
    { ...input, model: "sonnet" },
    ...["task_id", "resume", "thinking", "isolation", "cwd", "team_name", "mode", "max_turns"].map((key) => ({ ...input, [key]: "unsupported" })),
    ...["main", "MAIN", "team-lead", "a-12345678", "任务", "a b", "x".repeat(65)].map((name) => ({ ...input, name })),
  ];
  for (const value of invalid) await assert.rejects(h.call("Agent", value));
  for (const args of [{ to: "x", message: " " }, { to: " ", message: "hello" }, { to: "x", message: "hello", summary: " " }, { to: "x", message: "hello", notify_when_idle: true }]) await assert.rejects(h.call("SendMessage", args));
  for (const args of [{ task_id: " " }, { task_id: "x", shell_id: "z" }]) await assert.rejects(h.call("TaskStop", args));
  assert.equal(sessionCreations, 0);
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER, h.parent)).length, 0);
  await assert.rejects(fs.access(path.join(h.cwd, "executions.jsonl")));
});

test("角色精确映射，显示名称不作 ID；自定义覆盖保留，别名冲突报错", () => {
  const roles = discoverAgents(process.cwd());
  for (const alias of [undefined, "general-purpose", "general", "worker"]) assert.equal(resolveAgentRole(alias, roles).id, "worker");
  for (const alias of ["Explore", "explore", "scout"]) assert.equal(resolveAgentRole(alias, roles).id, "scout");
  assert.equal(resolveAgentRole("reviewer", roles).id, "reviewer");
  assert.throws(() => resolveAgentRole("Plan", roles), /找不到/);
  assert.throws(() => resolveAgentRole(roles[0].name, roles), /找不到/);
  const custom = { ...roles[0], id: "custom-review", name: "自定义角色", source: "用户" as const };
  assert.equal(resolveAgentRole(custom.id, [...roles, custom]), custom);
  assert.throws(() => resolveAgentRole("Explore", [...roles, { ...custom, id: "Explore" }]), /冲突/);
  const override = { ...custom, id: "scout" };
  assert.equal(resolveAgentRole("Explore", [...roles.filter((role) => role.id !== "scout"), override]), override);
});

test("中文标题、完整说明、角色和实例名称独立；消息正文可见身份及模型", async (t) => {
  const h = await harness(t);
  const prompt = "这是很长的任务说明。".repeat(25) + "\n最后一行也必须保留。";
  const result = await h.call("Agent", { ...input, description: "核对登录", prompt, name: "scan-login", run_in_background: true });
  const r = receipt(result);
  assert.equal(r.name, "scan-login"); assert.equal(r.description, "核对登录"); assert.equal(r.agentType, "scout");
  assert.match(r.agentId, /^A-/); assert.equal(r.resolvedModel, "fixture/default"); assert.equal(r.thinking, "high");
  const run = await settled(r.agentId);
  assert.equal(result.details.run.roleId, "scout"); assert.equal(result.details.publicResult.agentId, run.runId);
  assert.equal(run.description, "核对登录"); assert.equal(run.instruction, prompt); assert.equal(run.instanceName, "scan-login");
  assert.equal(run.finalText, prompt); assert.deepEqual(run.disallowedTools, ["edit", "write"]);
  assert.equal((await resolveTaskTarget("SCAN-LOGIN", h.parent)).runId, run.runId);
  const record = (await readCompletions(runDirectory(run.runId)))[0];
  assert.equal(record.instanceName, run.instanceName); assert.equal(record.description, run.description); assert.equal(record.roleId, "scout");
  assert.equal("outputFile" in r, false);
});

test("同名并发只创建一次；结束、重载后仍绑定；不同主会话可复用名称", async (t) => {
  const h = await harness(t);
  const batch = await Promise.allSettled([h.call("Agent", { ...input, name: "scan-config" }), h.call("Agent", { ...input, name: "SCAN-CONFIG" })]);
  assert.equal(batch.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER, h.parent)).length, 1);
  const run = await settled((batch.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>).value.details.publicResult.agentId);
  await assert.rejects(h.call("Agent", { ...input, name: "scan-config" }), /已有/);
  await h.handlers.get("session_start")({}, h.ctx);
  await h.handlers.get("session_shutdown")();
  assert.equal((await resolveTaskTarget("scan-config", h.parent)).runId, run.runId);
  const other = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => `${h.parent}-other` } };
  await assert.rejects(h.call("SendMessage", { to: run.runId, message: "跨会话" }, other), /当前会话/);
  await assert.rejects(h.call("TaskStop", { task_id: "scan-config" }, other), /当前会话/);
  await assert.rejects(h.call("SendMessage", { to: "scout", message: "角色不是实例" }), /当前会话/);
  const separate = receipt(await h.call("Agent", { ...input, name: "scan-config" }, other));
  assert.notEqual(separate.agentId, run.runId);
  assert.equal((await resolveTaskTarget("scan-config", other.sessionManager.getSessionId())).runId, separate.agentId);
  await settled(separate.agentId);
});

test("模型显式值和配置别名覆盖角色，省略继承角色或主会话，配置编辑保留 Jev", async (t) => {
  const h = await harness(t);
  const directory = path.join(h.cwd, ".pi", "agents");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "fixed.md"), "---\nname: 固定角色\nmodel: fixture/role\nthinking: low\ntools: read\n---\n调查并给出证据。\n");
  await writeDeckConfig({ modelAliases: { sonnet: "fixture/explicit" } });
  await writeDeckConfig({ timeoutMs: 120000 });
  assert.deepEqual(readDeckConfig().routing, DEFAULT_CONFIG.routing);
  assert.equal(readDeckConfig().modelAliases.sonnet, "fixture/explicit");
  for (const [extra, expected] of [[{}, "fixture/role"], [{ model: "fixture/explicit" }, "fixture/explicit"], [{ model: "sonnet" }, "fixture/explicit"]] as const) {
    const r = receipt(await h.call("Agent", { ...input, subagent_type: "fixed", ...extra }));
    assert.equal(r.resolvedModel, expected); assert.equal(r.thinking, "low"); await settled(r.agentId);
  }
  assert.deepEqual(parseDeckConfig({ enabled: false }).modelAliases, {});
  for (const value of [null, [], { sonnet: "opus" }, { sonnet: 42 }]) assert.throws(() => parseDeckConfig({ modelAliases: value }));
});

test("持久化记录损坏时不把已绑定名称当作可用，也不创建重复 Session", async (t) => {
  const h = await harness(t);
  const id = receipt(await h.call("Agent", { ...input, name: "durable-name" })).agentId;
  await settled(id);
  await h.handlers.get("session_shutdown")();
  const file = path.join(runDirectory(id), "status.json");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, "{broken");
  let created = false;
  h.ctx.sessionManager.getSessionFile = () => { created = true; return undefined; };
  try {
    await assert.rejects(h.call("Agent", { ...input, name: "durable-name" }), /无法读取任务记录/);
    await assert.rejects(h.call("SendMessage", { to: "durable-name", message: "不应发错对象" }), /无法读取任务记录/);
    assert.equal(created, false);
  } finally { await fs.writeFile(file, original); }
});

test("其他父会话的损坏记录不阻止新会话创建；当前会话仍严格检查名称", async (t) => {
  const h = await harness(t);
  const oldId = receipt(await h.call("Agent", { ...input, name: "old-record" })).agentId;
  await settled(oldId);
  await h.handlers.get("session_shutdown")();
  const file = path.join(runDirectory(oldId), "status.json");
  const original = await fs.readFile(file, "utf8");
  await fs.writeFile(file, "{broken foreign record");
  try {
    const otherParent = randomUUID();
    const other = { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getSessionId: () => otherParent } };
    const id = receipt(await h.call("Agent", { ...input, name: "fresh-name" }, other)).agentId;
    await settled(id);
    assert.equal((await resolveTaskTarget("fresh-name", otherParent)).runId, id);
    await assert.rejects(h.call("Agent", { ...input, name: "old-record" }), /无法读取任务记录/);
  } finally { await fs.writeFile(file, original); }
});

test("任务初始化中途失败会清除本次 provider、子 Session、run 和父索引", async (t) => {
  const h = await harness(t);
  const secret = `ROLLBACK_SECRET_${randomUUID()}`;
  h.ctx.modelRegistry.getRegisteredProviderConfig = (id: string) => id === "fixture" ? {
    name: "rollback fixture", baseUrl: "http://127.0.0.1/never-called", apiKey: secret,
    api: "openai-completions", models: [],
  } : undefined;
  const originalWriteFile = (fs as any).writeFile;
  const attempted: string[] = [];
  (fs as any).writeFile = async (file: unknown, ...args: unknown[]) => {
    const target = String(file);
    attempted.push(target);
    if (target.includes(`${path.sep}agent-deck${path.sep}parents${path.sep}`) && path.basename(target).startsWith("A-")) {
      throw Object.assign(new Error("PARENT_INDEX_WRITE_INJECTED"), { code: "EIO" });
    }
    return originalWriteFile.call(fs, file, ...args);
  };
  try {
    await assert.rejects(h.call("Agent", { ...input, name: "rollback-init" }), /PARENT_INDEX_WRITE_INJECTED/);
  } finally {
    (fs as any).writeFile = originalWriteFile;
  }
  const providerFile = attempted.find((file) => file.includes(`${path.sep}agent-deck${path.sep}providers${path.sep}`) && file.endsWith(".json"));
  const sessionFile = attempted.find((file) => file.endsWith(".jsonl"));
  const systemFile = attempted.find((file) => file.endsWith(`${path.sep}SYSTEM.md`));
  const parentMarker = attempted.find((file) => file.includes(`${path.sep}agent-deck${path.sep}parents${path.sep}`) && path.basename(file).startsWith("A-"));
  assert.ok(providerFile, `未观察到 provider 快照写入：${JSON.stringify(attempted)}`);
  assert.ok(sessionFile, `未观察到子 Session 写入：${JSON.stringify(attempted)}`);
  assert.ok(systemFile, `未观察到 SYSTEM 写入：${JSON.stringify(attempted)}`);
  assert.ok(parentMarker, `未观察到父索引写入：${JSON.stringify(attempted)}`);
  for (const file of [providerFile, sessionFile, systemFile, parentMarker]) {
    await assert.rejects(fs.access(file!), (error: NodeJS.ErrnoException) => error.code === "ENOENT", `${file} 不应残留`);
  }
  await assert.rejects(fs.access(path.dirname(systemFile!)), (error: NodeJS.ErrnoException) => error.code === "ENOENT", "未提交的 run 目录不应残留");
  assert.equal((await listRuns(Number.MAX_SAFE_INTEGER, h.parent, true)).length, 0);
});

test("声明式扩展模型传入真实 Pi 子进程且隔离父扩展工具和钩子", async (t) => {
  const h = await harness(t);
  const received: Array<{ headers: http.IncomingHttpHeaders; body: any }> = [];
  const server = http.createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += chunk;
    received.push({ headers: req.headers, body: JSON.parse(text) });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "review-model", choices: [{ index: 0, delta: { role: "assistant", content: "LOCAL_PROVIDER_SUCCESS" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as any).port;
  const key = "private-fixture-provider-key";
  const config = { name: "Review provider", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: key, api: "openai-completions", headers: { "X-Fixture": "private-fixture-header" }, models: [{ id: "review-model", name: "Review model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 }] };
  const extension = path.join(h.cwd, "provider-extension.ts");
  await fs.writeFile(extension, `export default function(pi) { pi.registerProvider("review-provider", ${JSON.stringify(config)}); pi.on("before_agent_start", () => { throw new Error("Parent hooks must stay isolated"); }); pi.registerTool({ name: "parent_only_tool", label: "Parent only", description: "Forbidden in child", parameters: {type:"object",properties:{}}, execute: async () => ({content:[]}) }); }`);
  const loader = new DefaultResourceLoader({ cwd: h.cwd, agentDir: getAgentDir(), settingsManager: SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, additionalExtensionPaths: [extension] });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const registry = new ModelRegistry(runtime);
  for (const item of loader.getExtensions().runtime.pendingProviderRegistrations) registry.registerProvider(item.name, item.config);
  await registry.refresh({ allowNetwork: false });
  h.ctx.modelRegistry = registry;
  h.ctx.model = registry.find("review-provider", "review-model");
  assert.ok(registry.getAvailable().some((model) => model.id === "review-model"));
  const installed = path.join(process.env.APPDATA ?? "", "npm/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js");
  const localCli = path.resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
  const hosts = [localCli];
  try { await fs.access(installed); hosts.push(installed); } catch { /* Installed host is optional in CI. */ }
  for (const cli of hosts) {
    process.argv[1] = cli;
    const id = receipt(await h.call("Agent", { ...input, model: "review-provider/review-model" })).agentId;
    const run = await settled(id);
    assert.equal(run.status, "已完成", run.stderr);
    assert.equal(run.finalText, "LOCAL_PROVIDER_SUCCESS");
    await h.call("Agent", { resume: id, prompt: "再检查一次" });
    assert.equal((await settled(id)).status, "已完成");
    for (const name of await fs.readdir(runDirectory(id))) {
      if (!/\.(json|jsonl|log|md)$/.test(name)) continue;
      const body = await fs.readFile(path.join(runDirectory(id), name), "utf8");
      assert.ok(!body.includes(key), `credential leaked into ${name}`);
      assert.ok(!body.includes("private-fixture-header"), `header leaked into ${name}`);
    }
  }
  assert.equal(received.length, hosts.length * 2);
  for (const request of received) {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    assert.equal(request.headers["x-fixture"], "private-fixture-header");
    assert.equal(request.body.model, "review-model");
    const tools = request.body.tools.map((tool: any) => tool.function.name);
    assert.ok(tools.includes("read")); assert.ok(tools.includes("bash")); assert.ok(!tools.includes("agent_report"));
    for (const name of ["Agent", "SendMessage", "TaskStop", "parent_only_tool", "edit", "write"]) assert.ok(!tools.includes(name));
  }
});

test("无关原生 Provider 不阻塞任务，显式偏好软回退；没有可传入模型时才拒绝", async (t) => {
  const h = await harness(t);
  let sessions = 0;
  h.ctx.sessionManager.getSessionFile = () => { sessions++; };
  const compatible = h.ctx.modelRegistry.getAvailable()[0];
  const native = { provider: "native-extra", id: "native-model", reasoning: true };
  h.ctx.modelRegistry.getAvailable = () => [compatible, native];
  h.ctx.modelRegistry.find = (provider: string, id: string) => [compatible, native].find((item) => item.provider === provider && item.id === id);
  h.ctx.modelRegistry.getRegisteredNativeProvider = (id: string) => id === "native-extra" ? { id } : undefined;

  const ordinary = receipt(await h.call("Agent", input));
  assert.equal((await settled(ordinary.agentId)).model, `${compatible.provider}/${compatible.id}`);
  const preferredNative = receipt(await h.call("Agent", { ...input, model: "native-extra/native-model" }));
  assert.equal((await settled(preferredNative.agentId)).model, `${compatible.provider}/${compatible.id}`);
  assert.equal(sessions, 2);

  h.ctx.model = native;
  h.ctx.modelRegistry.getAvailable = () => [native];
  const before = sessions;
  await assert.rejects(h.call("Agent", { ...input, model: "native-extra/native-model" }), /没有可执行的模型/);
  assert.equal(sessions, before, "技术上无法传入任何模型时不得留下半成品 Session");
});

async function executions(cwd: string): Promise<any[]> {
  try { return (await fs.readFile(path.join(cwd, "executions.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

test("运行中的普通补充通过 RPC 送达，正文和顺序保留；结束后在原 Session 继续", async (t) => {
  const h = await harness(t, 800);
  const launched = receipt(await h.call("Agent", { ...input, name: "ordered" }));
  const id = launched.agentId;
  await until(async () => (await executions(h.cwd)).some((item) => item.type === "prompt"));
  const original = (await readRun(id))!;
  const first = "  /not-a-command @not-a-file\n" + "完整内容".repeat(100) + "\nFIRST_END  ";
  const a = receipt(await h.call("SendMessage", { to: "ordered", message: first, summary: "摘要".repeat(130) }));
  const b = receipt(await h.call("SendMessage", { to: id, message: "SECOND_MESSAGE\n第二行" }));
  assert.equal(a.delivery, "queued"); assert.equal(a.success, true); assert.equal(b.delivery, "queued");
  assert.ok(a.message.includes("摘要"));
  const done = await settled(id);
  assert.equal(done.status, "已完成", done.stderr);
  assert.ok(done.finalText?.includes(first));
  assert.ok(done.finalText!.indexOf("FIRST_END") < done.finalText!.indexOf("SECOND_MESSAGE"));
  assert.equal(done.childSessionId, original.childSessionId);
  assert.equal(done.model, original.model); assert.equal(done.thinking, original.thinking);
  assert.equal((await executions(h.cwd)).filter((item) => item.type === "steer").length, 2);
  const next = receipt(await h.call("Agent", { resume: id, prompt: "NEXT_TURN" }));
  assert.equal(next.delivery, "resumed");
  const resumed = await until(async () => { const run = await readRun(id); return run?.status === "已完成" && run.turnId !== done.turnId ? run : undefined; });
  assert.match(resumed.finalText ?? "", /NEXT_TURN/);
  assert.ok(!resumed.finalText?.includes("FIRST_END"));
  assert.equal(resumed.childSessionId, done.childSessionId);
  assert.equal(resumed.childSessionPath, done.childSessionPath);
  assert.equal((await executions(h.cwd)).filter((item) => item.type === "prompt").length, 2);
});

test("面板确认期间任务进入新轮次时，旧停止请求不能误停新轮", async (t) => {
  const h = await harness(t, 80);
  const id = receipt(await h.call("Agent", { ...input, name: "panel-stop-race" })).agentId;
  const original = await settled(id);
  let entered!: () => void;
  let approve!: () => void;
  const confirmationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const approval = new Promise<void>((resolve) => { approve = resolve; });
  h.ctx.ui.confirm = async () => { entered(); await approval; return true; };
  const staleStop = h.commands.get("agent-stop").handler(id, h.ctx);
  await confirmationEntered;
  receipt(await h.call("Agent", { resume: id, prompt: "NEW_TURN_DURING_CONFIRM", run_in_background: true }));
  const resumedTurnId = (await readRun(id))!.turnId;
  assert.notEqual(resumedTurnId, original.turnId);
  approve();
  await assert.rejects(staleStop, /其他执行轮次/);
  const current = await settled(id);
  assert.equal(current.turnId, resumedTurnId);
  assert.equal(current.status, "已完成");
});

test("并发后台 resume 只有一方取得新轮且不会重复交付快速结果", async (t) => {
  const h = await harness(t, 1);
  await h.handlers.get("session_start")({}, h.ctx);
  const initial = receipt(await h.call("Agent", { ...input, name: "resume-delivery-race", run_in_background: false }));
  const original = (await readRun(initial.agentId))!;
  assert.equal(original.status, "已完成");
  h.messages.length = 0;

  const attempts = await Promise.allSettled([
    h.call("Agent", { resume: initial.agentId, prompt: "FAST_RESUME", run_in_background: true }),
    h.call("Agent", { resume: initial.agentId, prompt: "FAST_RESUME", run_in_background: true }),
  ]);
  assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(attempts.filter((item) => item.status === "rejected").length, 1);
  assert.match(String((attempts.find((item) => item.status === "rejected") as PromiseRejectedResult).reason), /其他执行轮次/);
  const result = receipt((attempts.find((item) => item.status === "fulfilled") as PromiseFulfilledResult<any>).value);
  const completed = await until(async () => {
    const run = await readRun(initial.agentId);
    return run && run.turnId !== original.turnId && run.status === "已完成" ? run : undefined;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (result.status === "completed") assert.equal(h.messages.length, 0, "工具直接返回终态时不再发送后台通知");
  else assert.equal(h.messages.length, 1, "工具返回运行态时只发送一次后台通知");
  assert.equal(completed.turnId === original.turnId, false);
});

test("旧问答参数拒绝；空闲消息不启动，明确 resume 才开始", async (t) => {
  const h = await harness(t, 80);
  const id = receipt(await h.call("Agent", { ...input, name: "old-task" })).agentId;
  await assert.rejects(h.call("Agent", { resume: id, prompt: "过早续接" }), /运行/);
  const original = await settled(id);
  await assert.rejects(h.call("SendMessage", { to: id, message: "旧答复", reply_to: "old" }), /不再接受/);
  const deferred = receipt(await h.call("SendMessage", { to: id, message: "仅供参考" }));
  assert.equal(deferred.delivery, "deferred");
  assert.equal((await readRun(id))?.turnId, original.turnId);
  assert.equal((await executions(h.cwd)).filter((item) => item.type === "prompt").length, 1);
  const resumed = receipt(await h.call("Agent", { resume: "old-task", prompt: "明确继续" }));
  assert.equal(resumed.agentId, id);
  const done = await settled(id);
  assert.notEqual(done.turnId, original.turnId);
  assert.match(done.finalText ?? "", /仅供参考/);
});

test("同工作区不做实施者硬锁，Bash 审查与多个 worker 都可并行；TaskStop 清理真实终态", async (t) => {
  // These children are intentionally stop-driven. Keep their natural completion
  // far away so a busy CI host cannot turn this into a timing race.
  const h = await harness(t, 60_000);
  const roleDir = path.join(h.cwd, ".pi", "agents");
  await fs.mkdir(roleDir, { recursive: true });
  await fs.writeFile(path.join(roleDir, "bash-review.md"), "---\nid: bash-review\nname: Bash 审查\ndisallowedTools: edit, write\n---\n可以使用 Bash 检查，但不修改正式文件。\n");
  const first = receipt(await h.call("Agent", { ...input, subagent_type: "general-purpose", name: "writer-one" })).agentId;
  await until(async () => Boolean((await readRun(first))?.childPid));
  const secondWriter = receipt(await h.call("Agent", { ...input, subagent_type: "worker", name: "writer-two" }));
  const reviewer = receipt(await h.call("Agent", { ...input, subagent_type: "bash-review", name: "review-with-bash" }));
  const secondReviewer = receipt(await h.call("Agent", { ...input, subagent_type: "bash-review", name: "review-with-bash-two" }));
  await until(async () => Boolean((await readRun(reviewer.agentId))?.childPid));
  await until(async () => Boolean((await readRun(secondReviewer.agentId))?.childPid));
  assert.equal((await readRun(first))?.legacy?.writerLease, undefined);
  assert.deepEqual((await readRun(reviewer.agentId))?.disallowedTools, ["edit", "write"]);
  assert.deepEqual((await readRun(secondReviewer.agentId))?.disallowedTools, ["edit", "write"]);
  assert.equal((await readRun(reviewer.agentId))?.tools, undefined);
  assert.equal((await readRun(secondReviewer.agentId))?.tools, undefined);
  await until(async () => (await executions(h.cwd)).filter((item) => item.type === "prompt").length === 4);
  await h.call("SendMessage", { to: "review-with-bash", message: "不应继续" });
  assert.equal(receipt(await h.call("TaskStop", { task_id: "review-with-bash" })).status, "stopped");
  assert.equal(receipt(await h.call("TaskStop", { task_id: "review-with-bash-two" })).status, "stopped");
  assert.ok(!(await executions(h.cwd)).some((item) => item.type === "prompt" && String(item.message).includes("不应继续")));
  assert.equal(receipt(await h.call("TaskStop", { task_id: "writer-one" })).status, "stopped");
  assert.equal(receipt(await h.call("TaskStop", { task_id: secondWriter.agentId })).status, "stopped");
  assert.equal(receipt(await h.call("TaskStop", { task_id: first })).status, "stopped");
});

test("旧记录没有新字段仍可读取、继续和停止；停止未确认不会被说成成功", async (t) => {
  const h = await harness(t);
  const id = receipt(await h.call("Agent", input)).agentId;
  const old = await settled(id);
  await h.handlers.get("session_shutdown")();
  delete old.description; delete old.instanceName;
  await writeJsonAtomic(path.join(runDirectory(id), "status.json"), old);
  const resumed = receipt(await h.call("Agent", { resume: id, prompt: "继续旧记录", description: old.objective }));
  assert.equal(resumed.description, old.objective);
  const done = await settled(id);
  assert.equal(done.childSessionId, old.childSessionId);
  assert.equal(receipt(await h.call("TaskStop", { task_id: id })).status, "completed");
  const uncertain = publicTaskResult({ ...done, status: "停止未确认" }, "停止未确认");
  assert.equal(uncertain.status, "stop_unconfirmed");
  const lost = { ...done, runId: `lost-${randomUUID()}`, status: "失联" as const, childPid: process.pid };
  await initializeRun(lost, { version: 1, cwd: h.cwd, command: process.execPath, argsPrefix: [], prompt: "test" }, true).then(async (run) => {
    await h.handlers.get("session_shutdown")();
    const file = path.join(runDirectory(run.runId), "status.json");
    await writeJsonAtomic(file, { ...run, childPid: process.pid });
    try {
      await assert.rejects(h.call("SendMessage", { to: run.runId, message: "不能启动第二个进程" }), /旧任务仍由另一个 Pi 进程运行/);
    } finally {
      await writeJsonAtomic(file, { ...run, childPid: undefined, resourceState: "released" });
    }
  });
});

test("关闭后 Agent 和 SendMessage 都停用，TaskStop 可用；重新开启不丢别名和路由设置", async (t) => {
  const h = await harness(t);
  await writeDeckConfig({ modelAliases: { haiku: "fixture/explicit" }, routing: { ...DEFAULT_CONFIG.routing, timeoutMs: 2500 } });
  await h.commands.get("agent-deck").handler("关闭", h.ctx);
  assert.deepEqual(h.active(), ["TaskStop"]);
  await assert.rejects(h.call("Agent", input), /已关闭/);
  await assert.rejects(h.call("SendMessage", { to: "missing", message: "hello" }), /已关闭/);
  await assert.rejects(h.call("TaskStop", { task_id: "missing" }), /当前会话/);
  await h.commands.get("agent-deck").handler("开启", h.ctx);
  assert.deepEqual(h.active().sort(), ["Agent", "SendMessage", "TaskStop"]);
  assert.equal(readDeckConfig().modelAliases.haiku, "fixture/explicit"); assert.equal(readDeckConfig().routing.timeoutMs, 2500);
});

test("公开 Agent 不按审查角色、模型型号或 thinking 建立硬门禁", async (t) => {
  const h = await harness(t, 10);
  const models = ["gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"].map((id) => ({ provider: "fixture", id, api: "openai-responses", reasoning: true, thinkingLevelMap: { minimal: "low", xhigh: "xhigh", max: "max" } }));
  h.ctx.model = models[1];
  h.ctx.modelRegistry = { find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id), getAvailable: () => models };
  await writeDeckConfig({ ...DEFAULT_CONFIG, routing: { ...DEFAULT_CONFIG.routing, enabled: false }, modelAliases: { audit: "fixture/gpt-5.6-sol", fast: "fixture/gpt-6-luna" } });
  const roles = path.join(h.cwd, ".pi", "agents");
  await fs.mkdir(roles, { recursive: true });
  await fs.writeFile(path.join(roles, "audit-custom.md"), '---\nname: 自定义审查\ndisallowedTools: [edit, write]\n---\n审查代码，不修改文件。');
  await fs.writeFile(path.join(roles, "audit-low.md"), '---\nname: 自定义强度\nthinking: low\ndisallowedTools: [edit, write]\n---\n审查代码，不修改文件。');
  let sessionCreations = 0;
  h.ctx.sessionManager.getSessionFile = () => { sessionCreations++; return undefined; };
  const cases = [
    { ...input, model: "audit" },
    { ...input, subagent_type: "reviewer", model: "fast" },
    { ...input, subagent_type: "audit-low" },
    { ...input, subagent_type: "audit-custom", model: "fixture/gpt-6-astra" },
  ];
  const expectedModels = ["fixture/gpt-5.6-sol", "fixture/gpt-6-luna", "fixture/gpt-6-sol", "fixture/gpt-6-astra"];
  for (let index = 0; index < cases.length; index++) {
    const result = receipt(await h.call("Agent", { ...cases[index], name: `policy-free-${index}` }));
    const run = await settled(result.agentId);
    assert.equal(run.status, "已完成");
    assert.equal(run.model, expectedModels[index]);
    assert.equal("review" in JSON.parse(await fs.readFile(path.join(runDirectory(run.runId), "request.json"), "utf8")), false);
  }
  assert.equal(sessionCreations, 4);
});
