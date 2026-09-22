import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createAgentFromDescription, generateAgentDraft, parseAgentDraft, saveGeneratedAgent, type AgentDraft } from "../src/agent-creation.ts";
import { discoverAgents } from "../src/agents.ts";
import { registerConfiguration } from "../src/configuration-ui.ts";
import { writeDeckConfig } from "../src/config.ts";
import agentDeck from "../src/index.ts";
import { chooseRenderedMenu } from "./menu-harness.ts";

const base: AgentDraft = {
  id: "login-reviewer", name: "登录审查员", description: "审查登录流程，只读并返回证据",
  systemPrompt: "定位登录流程，检查输入和会话边界。按影响排序问题，给出文件位置和验证情况。", tools: ["read", "grep", "find", "ls"],
};
const response = (value: unknown) => ({ stopReason: "stop", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] });

function harness(complete: (...args: any[]) => Promise<any> = async () => response(base)) {
  const messages: any[] = [], notices: string[] = [], commands = new Map<string, any>();
  let editorCount = 0;
  const ctx: any = {
    mode: "tui", cwd: getAgentDir(), model: { provider: "fixture", id: "model" }, isProjectTrusted: () => false,
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "model" }], find: (provider: string, id: string) => provider === "fixture" && id === "model" ? {} : undefined, complete },
    ui: {
      notify: (text: string) => notices.push(text),
      editor: async () => { editorCount++; return "创建一个只读审查登录代码的 Agent，返回文件位置和改进建议"; },
      custom: (factory: any) => new Promise((resolve) => {
        let component: any;
        const done = (value: any) => { component?.dispose?.(); resolve(value); };
        component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text }, undefined, done);
        const rendered = component.render(80).join("\n");
        if (!rendered.includes("正在生成")) chooseRenderedMenu(component, "描述需求，自动创建 Agent");
        else assert.match(rendered, /正在生成/);
      }),
    },
  };
  const pi: any = { registerCommand: (name: string, command: any) => commands.set(name, command), sendMessage: (message: any, options: any) => messages.push({ ...message, options }) };
  registerConfiguration(pi, () => {});
  return { ctx, pi, messages, notices, commands, editorCount: () => editorCount };
}

test("自然描述命令从真实加载组件生成、保存、发现角色，生成摘要且不启动任务", async () => {
  let request: any, options: any;
  const h = harness(async (_model, context, settings) => { request = context; options = settings; return response(base); });
  await h.commands.get("agent-create").handler("只读审查登录流程，返回文件位置", h.ctx);
  assert.equal(h.editorCount(), 0);
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].options.triggerTurn, false);
  const saved = discoverAgents(h.ctx.cwd).find((agent) => agent.id === h.messages[0].details.agentId)!;
  assert.ok(saved);
  assert.equal(saved.writePermission, false);
  assert.equal(saved.model, undefined);
  assert.equal("maxConcurrent" in saved, false);
  assert.equal(saved.timeoutMs, undefined);
  assert.match(saved.systemPrompt, /文件位置/);
  assert.match(request.messages[0].content[0].text, /只读审查登录流程/);
  assert.equal(request.messages.length, 1);
  assert.ok(options.signal instanceof AbortSignal);
  assert.match(h.messages[0].content, /只读/);
  await assert.rejects(fs.access(path.join(getAgentDir(), "agent-deck", "runs")));
});

test("配置菜单的新建只要求一段描述，自动选择名称并保存", async () => {
  const h = harness(async () => response({ ...base, id: "menu-reviewer" }));
  await h.commands.get("agent-config").handler("", h.ctx);
  assert.equal(h.editorCount(), 1);
  assert.equal(h.messages[0].details.agentId, "menu-reviewer");
});

test("写入角色和显式模型可保存，实际能力限制保留在提示词", async () => {
  const h = harness(async () => response({ ...base, id: "frontend-builder", tools: ["read", "edit", "write", "bash"], model: "fixture/model", thinking: "high", timeoutMs: 0, limitations: ["不能直接操作浏览器界面"] }));
  const draft = await generateAgentDraft("实现前端并执行测试，使用 fixture/model", h.ctx, new AbortController().signal);
  const saved = await saveGeneratedAgent(draft, h.ctx);
  assert.equal(saved.writePermission, true);
  assert.equal(saved.model, "fixture/model");
  assert.equal(saved.thinking, "high");
  assert.equal(saved.timeoutMs, 0);
  assert.equal("maxConcurrent" in saved, false);
  assert.match(saved.systemPrompt, /不能直接操作浏览器/);
});

test("模型配置格式错误自动修正一次，连续错误不保存角色", async () => {
  let calls = 0;
  const h = harness(async (_model, context) => {
    calls++;
    if (calls === 1) return response("bad-json");
    assert.match(context.messages[0].content[0].text, /未通过校验/);
    return response({ ...base, id: "repaired-reviewer" });
  });
  await createAgentFromDescription(h.pi, h.ctx, "检查登录代码");
  assert.equal(calls, 2);
  assert.equal(h.messages[0].details.agentId, "repaired-reviewer");
  const before = await fs.readdir(path.join(getAgentDir(), "agents"));
  const bad = harness(async () => response({ ...base, tools: ["Browser"] }));
  await createAgentFromDescription(bad.pi, bad.ctx, "检查登录代码");
  assert.equal(bad.messages.length, 0);
  assert.ok(bad.notices.some((text) => text.includes("未通过校验")));
  assert.deepEqual(await fs.readdir(path.join(getAgentDir(), "agents")), before);
});

test("非法路径、系统设备名、未知工具字段和不存在的模型被拒绝", () => {
  const h = harness();
  for (const change of [{ id: "../escape" }, { id: "con" }, { id: "general" }, { tools: ["mcp"] }, { hooks: {} }, { thinking: "magic" }, { model: "missing/model" }, { maxConcurrent: 0 }]) {
    assert.throws(() => parseAgentDraft(JSON.stringify({ ...base, ...change }), h.ctx));
  }
  assert.equal(parseAgentDraft("```json\n" + JSON.stringify(base) + "\n```", h.ctx).id, base.id);
});

test("重名和并发创建自动加后缀，原有角色及内置角色不会被覆盖", async () => {
  const h = harness();
  const directory = path.join(getAgentDir(), "agents");
  await fs.mkdir(directory, { recursive: true });
  const existing = path.join(directory, "collision.md");
  await fs.writeFile(existing, "preserve-original");
  const saved = await Promise.all([saveGeneratedAgent({ ...base, id: "collision" }, h.ctx), saveGeneratedAgent({ ...base, id: "collision" }, h.ctx)]);
  assert.deepEqual(new Set(saved.map((agent) => agent.id)), new Set(["collision-2", "collision-3"]));
  assert.equal(await fs.readFile(existing, "utf8"), "preserve-original");
  assert.equal((await saveGeneratedAgent({ ...base, id: "worker" }, h.ctx)).id, "worker-2");
  assert.equal((await fs.readdir(directory)).some((name) => name.endsWith(".tmp")), false);
});

test("Esc 取消生成，即使模型稍后返回也不保存或显示成功", async () => {
  let resolveModel!: (value: any) => void;
  let requestSignal!: AbortSignal;
  const h = harness(async (_model, _context, options) => { requestSignal = options.signal; return new Promise((resolve) => { resolveModel = resolve; }); });
  const before = await fs.readdir(path.join(getAgentDir(), "agents"));
  let finished = 0;
  h.ctx.ui.custom = (factory: any) => new Promise((resolve) => {
    let component: any;
    component = factory({ requestRender() {} }, { fg: (_: string, text: string) => text }, undefined, (value: any) => { finished++; component.dispose(); resolve(value); });
    component.handleInput("\u001b");
  });
  await createAgentFromDescription(h.pi, h.ctx, "检查登录代码");
  assert.equal(requestSignal.aborted, true);
  resolveModel(response({ ...base, id: "should-not-exist" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, 1);
  assert.equal(h.messages.length, 0);
  assert.deepEqual(await fs.readdir(path.join(getAgentDir(), "agents")), before);
});

test("空输入不发模型请求，服务失败清楚显示，关闭派遣后仍提供自然语言创建指引", async () => {
  let called = 0;
  const h = harness(async () => { called++; throw new Error("fixture provider unavailable"); });
  h.ctx.ui.editor = async () => undefined;
  await createAgentFromDescription(h.pi, h.ctx);
  assert.equal(called, 0);
  await createAgentFromDescription(h.pi, h.ctx, "审查登录");
  assert.equal(called, 1);
  assert.ok(h.notices.some((text) => text.includes("fixture provider unavailable")));
  await writeDeckConfig({ enabled: false });
  const handlers = new Map<string, any>();
  agentDeck({ ...h.pi, on: (name: string, handler: any) => handlers.set(name, handler), registerTool() {}, registerMessageRenderer() {} } as any);
  const result = await handlers.get("before_agent_start")({}, h.ctx);
  assert.match(result.message.content, /agent-authoring.md/);
  assert.match(result.message.content, /派遣已关闭/);
  assert.equal(result.message.display, false);
});
