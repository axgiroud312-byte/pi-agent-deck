import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import agentDeck from "../src/index.ts";
import { DEFAULT_CONFIG, parseDeckConfig, readDeckConfig, writeDeckConfig } from "../src/config.ts";
import { discoverAgents } from "../src/agents.ts";
import { initializeRun, listRuns, readRun, runDirectory, startFollowUp, stopRun, writeJsonAtomic } from "../src/runtime.ts";
import { resolveTaskTarget } from "../src/task-identity.ts";
import { publicTaskResult, resolveAgentRole } from "../src/tool-contract.ts";
import { alive, readCompletions } from "../src/persistence.mjs";

async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 15000;
  while (Date.now() < end) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
  throw new Error("Claude interface fixture timed out");
}
async function settled(id: string) {
  await until(async () => { const run = await readRun(id); return !!run && ["已完成", "失败", "已停止", "已取消", "等待决定"].includes(run.status) && !alive(run.runnerPid) && !alive(run.childPid); });
  return (await readRun(id))!;
}
async function harness(t: any, duration = 350) {
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
  const cwd = path.join(getAgentDir(), "fixtures", randomUUID());
  await fs.mkdir(cwd, { recursive: true });
  const cli = path.join(cwd, "fixture-cli.mjs");
  await fs.writeFile(cli, `import fs from "node:fs";
fs.appendFileSync("executions.jsonl",JSON.stringify(process.argv.slice(2))+"\\n");
setTimeout(()=>console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:process.argv.at(-1)}]}})),${duration});`);
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
    handlers.get("session_shutdown")(); process.argv[1] = originalCli;
    for (const run of await listRuns(Number.MAX_SAFE_INTEGER)) if (run.cwd === cwd) await stopRun(run.runId);
    await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
  });
  return { cwd, cli, parent, ctx, tools, handlers, commands, messages, entries, notices, call, active: () => active };
}
const input = { description: "检查入口", prompt: "阅读入口并报告证据。", subagent_type: "Explore" };
const receipt = (result: any) => JSON.parse(result.content[0].text);

test("无效参数和不可用模型在创建任务、Session、名称绑定和消息队列前拒绝", async (t) => {
  const h = await harness(t);
  let sessionCreations = 0;
  h.ctx.sessionManager.getSessionFile = () => { sessionCreations++; return undefined; };
  const invalid = [
    { ...input, description: " " }, { ...input, prompt: "\n" }, { ...input, name: " " },
    { ...input, subagent_type: " " }, { ...input, model: " " }, { ...input, run_in_background: false },
    { ...input, model: "sonnet" }, { ...input, model: "fixture/missing" }, { ...input, model: "fixture/unavailable" },
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
  assert.equal(result.details.run.agentId, "scout"); assert.equal(result.details.publicResult.agentId, run.runId);
  assert.equal(run.description, "核对登录"); assert.equal(run.instruction, prompt); assert.equal(run.instanceName, "scan-login");
  assert.equal(run.finalText, prompt); assert.equal(run.writePermission, false);
  assert.equal((await resolveTaskTarget("SCAN-LOGIN", h.parent)).runId, run.runId);
  const record = (await readCompletions(runDirectory(run.runId)))[0];
  assert.equal(record.instanceName, run.instanceName); assert.equal(record.description, run.description); assert.equal(record.agentId, "scout");
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
  h.handlers.get("session_shutdown")();
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

test("运行中两条消息按顺序持久化，摘要不截断正文；只在当前轮结束后恢复", async (t) => {
  const h = await harness(t, 1000);
  const id = receipt(await h.call("Agent", { ...input, name: "ordered" })).agentId;
  const first = "  /not-a-command @not-a-file\n" + "完整内容".repeat(100) + "\nFIRST_END  ";
  const a = receipt(await h.call("SendMessage", { to: "ordered", message: first, summary: "摘要".repeat(130) }));
  const b = receipt(await h.call("SendMessage", { to: id, message: "SECOND_MESSAGE\n第二行" }));
  assert.equal(a.delivery, "queued"); assert.equal(a.success, true); assert.equal(b.delivery, "queued");
  assert.match(a.message, /尚未即时/);
  const queue = JSON.parse(await fs.readFile(path.join(runDirectory(id), "follow-up.json"), "utf8"));
  assert.equal(queue.length, 2); assert.equal(queue[0].message, first); assert.equal(queue[0].summary.length, 200);
  assert.equal(queue[1].summary, "SECOND_MESSAGE");
  const original = await settled(id);
  assert.equal(original.finalText, input.prompt);
  assert.equal(await startFollowUp(id), true);
  const continued = await settled(id);
  assert.equal(continued.childSessionId, original.childSessionId); assert.equal(continued.childSessionPath, original.childSessionPath);
  assert.equal(continued.model, original.model); assert.equal(continued.thinking, original.thinking);
  assert.ok(continued.finalText!.includes(first)); assert.ok(continued.finalText!.indexOf("FIRST_END") < continued.finalText!.indexOf("SECOND_MESSAGE"));
  assert.equal(await startFollowUp(id), false);
  assert.equal((await fs.readFile(path.join(h.cwd, "executions.jsonl"), "utf8")).trim().split("\n").length, 2);
  assert.equal((await readCompletions(runDirectory(id))).length, 2);
});

test("任务刚结束时的新消息不会越过旧排队消息；旧字符串队列仍可恢复", async (t) => {
  const h = await harness(t);
  const id = receipt(await h.call("Agent", input)).agentId;
  await settled(id);
  await fs.writeFile(path.join(runDirectory(id), "follow-up.json"), JSON.stringify(["OLD_MESSAGE"]));
  const r = receipt(await h.call("SendMessage", { to: id, message: "NEW_MESSAGE" }));
  assert.equal(r.delivery, "resumed");
  const run = await settled(id);
  assert.ok(run.finalText!.indexOf("OLD_MESSAGE") < run.finalText!.indexOf("NEW_MESSAGE"));
  assert.equal(await startFollowUp(id), false);
});

test("agent_question 自动交付后 SendMessage 在同一 Session 回答，重载不重复交付", async (t) => {
  const h = await harness(t);
  await fs.writeFile(h.cli, `const prompt=process.argv.at(-1);
if(!prompt.includes("保持兼容")) console.log(JSON.stringify({type:"tool_execution_end",toolName:"agent_question",result:{details:{type:"问题",title:"需要决定",summary:"是否保持兼容？",question:"是否保持兼容？",blocking:true,evidence:[],tests:[],risks:[]}}}));
else console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:prompt}]}}));`);
  const id = receipt(await h.call("Agent", { ...input, name: "ask-compat", description: "兼容检查" })).agentId;
  const waiting = await settled(id); assert.equal(waiting.status, "等待决定");
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal(h.messages.length, 1); assert.match(h.messages[0].content, /SendMessage/); assert.match(h.messages[0].content, /ask-compat/);
  const reply = receipt(await h.call("SendMessage", { to: "ask-compat", message: "保持兼容" })); assert.equal(reply.delivery, "resumed");
  const done = await settled(id); assert.equal(done.status, "已完成"); assert.equal(done.childSessionId, waiting.childSessionId);
  await until(async () => h.messages.length === 2);
  h.handlers.get("session_shutdown")();
  await h.handlers.get("session_start")({}, h.ctx);
  assert.equal(h.messages.length, 2); assert.ok(h.messages.every((message) => message.details.agentId === id && message.details.name === "ask-compat"));
});

test("TaskStop 停止运行或排队任务并清理消息，重复停止保持真实终态", async (t) => {
  const h = await harness(t, 6000);
  const first = receipt(await h.call("Agent", { ...input, subagent_type: "general-purpose", name: "writer-one" })).agentId;
  const second = receipt(await h.call("Agent", { ...input, subagent_type: "worker", name: "writer-two" }));
  assert.equal(second.status, "queued");
  await h.call("SendMessage", { to: "writer-two", message: "不应继续" });
  assert.equal(receipt(await h.call("TaskStop", { task_id: "writer-two" })).status, "cancelled");
  await assert.rejects(fs.access(path.join(runDirectory(second.agentId), "follow-up.json")));
  assert.equal(receipt(await h.call("TaskStop", { task_id: "writer-one" })).status, "stopped");
  assert.equal(receipt(await h.call("TaskStop", { task_id: first })).status, "stopped");
});

test("旧记录没有新字段仍可读取、继续和停止；停止未确认不会被说成成功", async (t) => {
  const h = await harness(t);
  const id = receipt(await h.call("Agent", input)).agentId;
  const old = await settled(id);
  delete old.description; delete old.instanceName;
  await writeJsonAtomic(path.join(runDirectory(id), "status.json"), old);
  const resumed = receipt(await h.call("SendMessage", { to: id, message: "继续旧记录" }));
  assert.equal(resumed.description, old.objective);
  const done = await settled(id);
  assert.equal(done.childSessionId, old.childSessionId);
  assert.equal(receipt(await h.call("TaskStop", { task_id: id })).status, "completed");
  const uncertain = publicTaskResult({ ...done, status: "停止未确认" }, "停止未确认");
  assert.equal(uncertain.status, "stop_unconfirmed");
  const lost = { ...done, runId: `lost-${randomUUID()}`, status: "失联" as const, childPid: process.pid };
  await initializeRun(lost, { version: 1, cwd: h.cwd, command: process.execPath, argsPrefix: [], prompt: "test" }, true).then(async (run) => {
    await assert.rejects(h.call("SendMessage", { to: run.runId, message: "不能启动第二个进程" }), /尚未完全退出/);
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
