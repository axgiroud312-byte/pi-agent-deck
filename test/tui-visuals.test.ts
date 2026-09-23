import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initializeRun, runDirectory } from "../src/runtime.ts";
import { showAgentPanel } from "../src/ui.ts";
import { panelHeight, renderFleet } from "../src/presentation.ts";
import { editAgentConfig, editGlobalConfig, selectAgentTools } from "../src/config-editor.ts";
import { parseAgentDefinition } from "../src/agents.ts";
import { readDeckConfig, writeDeckConfig, DEFAULT_CONFIG } from "../src/config.ts";
import { selectMenu } from "../src/menu.ts";
import { chooseRenderedMenu } from "./menu-harness.ts";

const theme: any = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
async function runs(statuses: string[], objective = "任务") {
  const parent = randomUUID();
  const values: any[] = [];
  for (let index = 0; index < statuses.length; index++) {
    const run = { version: 1, runId: `${parent}-${index}`, agentId: "fixture", agentName: `角色 ${index}`, objective: `${objective} ${index}`, instruction: "按描述调查，并提供证据。", status: statuses[index], parentSessionId: parent, model: "fixture/model", startedAt: Date.now() - 125000, reports: [], events: [], currentAction: "正在读取任务文件", finalText: "## 结论\n\n**已检查**\n\n- 给出建议\n- 需要验证" };
    values.push(await initializeRun(run as any, { version: 1, cwd: getAgentDir(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true));
  }
  return { parent, values };
}
async function withPanel(parent: string, callback: (component: any, terminal: { rows: number }, actions: any[]) => Promise<void> | void) {
  const terminal = { rows: 24 };
  const actions: any[] = [];
  const ctx: any = { mode: "tui", sessionManager: { getSessionId: () => parent }, ui: { custom: async (factory: any) => {
    const component = factory({ terminal, requestRender() {} }, theme, undefined, (action: any) => actions.push(action));
    try { await callback(component, terminal, actions); } finally { component.dispose(); }
    return { action: "关闭" };
  } } };
  await showAgentPanel(ctx);
}

test("面板准确区分运行、排队、等答复和停止，主界面计数一致", async () => {
  const f = await runs(["运行中", "排队中", "排队中", "等待决定", "停止中", "失败"]);
  await withPanel(f.parent, (component) => {
    const output = component.render(110).join("\n");
    assert.match(output, /运行 1 · 排队 2 · 等答复 1 · 停止中 1 · 异常 1/);
    const fleet = renderFleet(f.values, 110, 24, theme).join("\n");
    assert.match(fleet, /运行 1 · 排队 2 · 等答复 1/);
    assert.match(fleet, /另有 2 项/);
  });
});

test("长中文任务名不挤掉状态和耗时，窄宽终端都不越界", async () => {
  const f = await runs(["运行中"], "检查非常长的中文登录任务名称".repeat(25));
  await withPanel(f.parent, (component) => {
    for (const width of [1, 10, 40, 60, 80, 140]) {
      const lines = component.render(width);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
      if (width >= 40) assert.ok(lines.some((line: string) => /运行中\s+02:\d\d/.test(line)));
    }
    component.handleInput("\r");
    for (const width of [40, 80, 140]) {
      const lines = component.render(width);
      assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
      assert.ok(lines.some((line: string) => /运行中 · 02:\d\d/.test(line)));
    }
  });
});

test("选配状态、最终组合、回退原因与耗时在实际面板中可读", async () => {
  const f = await runs(["选配中"]);
  const pending = { ...f.values[0], routingPending: true, thinking: "medium" };
  await fs.writeFile(path.join(runDirectory(pending.runId), "status.json"), JSON.stringify(pending));
  const fleet = renderFleet([pending], 110, 24, theme).join("\n");
  assert.match(fleet, /选配 1/); assert.match(fleet, /模型待选配/);
  assert.doesNotMatch(fleet, /上限/);
  await withPanel(f.parent, (component) => {
    component.handleInput("\r"); component.handleInput("1");
    assert.match(component.render(110).join("\n"), /模型：待选配/);
    component.handleInput("c");
  });
  const chosen = { ...pending, routingPending: false, status: "已完成", model: "openai-codex/gpt-6-sol", thinking: "high",
    routing: { model: "openai-codex/gpt-6-sol", thinking: "high", mode: "fallback", elapsedMs: 15000, reason: "Jev 选配超时，使用合规回退配置。" } };
  await fs.writeFile(path.join(runDirectory(chosen.runId), "status.json"), JSON.stringify(chosen));
  await withPanel(f.parent, (component, terminal) => {
    terminal.rows = 40;
    component.handleInput("\r"); component.handleInput("1");
    const view = component.render(110).join("\n");
    assert.match(view, /gpt-6-sol/); assert.match(view, /思考强度：high/);
    assert.match(view, /已回退/); assert.match(view, /15000 ms/); assert.match(view, /超时/);
    for (const width of [1, 10, 40, 80]) assert.ok(component.render(width).every((line: string) => visibleWidth(line) <= width));
  });
});

test("面板随终端高度扩大，分页与首尾键选择任务", async () => {
  const f = await runs(Array(15).fill("运行中"));
  await withPanel(f.parent, (component, terminal, actions) => {
    terminal.rows = 16;
    const small = component.render(90);
    assert.ok(small.length <= panelHeight(16));
    terminal.rows = 44;
    const large = component.render(90);
    assert.ok(large.length <= panelHeight(44));
    assert.ok(large.filter((line: string) => /运行中\s+02:/.test(line)).length > small.filter((line: string) => /运行中\s+02:/.test(line)).length);
    component.handleInput("\u001b[F");
    assert.match(component.render(90).join("\n"), /显示 .*15 \/ 15/);
    component.handleInput("c");
    assert.equal(actions.at(-1).action, "继续");
    component.handleInput("\u001b[H");
    assert.match(component.render(90).join("\n"), /显示 1–/);
  });
});

test("实时日志跟随新增内容，上翻后停留原位，End 恢复跟随", async () => {
  const f = await runs(["运行中"]);
  const file = path.join(runDirectory(f.values[0].runId), "events.jsonl");
  const event = (index: number) => JSON.stringify({ at: 1700000000000 + index, kind: "工具", text: `事件 ${String(index).padStart(4, "0")}` }) + "\n";
  await fs.writeFile(file, Array.from({ length: 40 }, (_, index) => event(index)).join(""));
  await withPanel(f.parent, async (component) => {
    component.handleInput("\r");
    let text = component.render(90).join("\n");
    assert.match(text, /事件 0039/);
    assert.doesNotMatch(text, /事件 0000/);
    assert.match(text, /跟随最新/);
    await fs.appendFile(file, event(40));
    assert.match(component.render(90).join("\n"), /事件 0040/);
    component.handleInput("\u001b[A");
    const paused = component.render(90).filter((line: string) => line.includes("事件"));
    await fs.appendFile(file, event(41));
    assert.deepEqual(component.render(90).filter((line: string) => line.includes("事件")), paused);
    assert.match(component.render(90).join("\n"), /已暂停跟随/);
    component.handleInput("\u001b[F");
    assert.match(component.render(90).join("\n"), /事件 0041/);
    assert.match(component.render(90).join("\n"), /跟随最新/);
  });
});

test("近期日志截取有标识，结果渲染 Markdown，空面板可进入新建和配置", async () => {
  const f = await runs(["运行中"]);
  const file = path.join(runDirectory(f.values[0].runId), "events.jsonl");
  await fs.writeFile(file, Array.from({ length: 1800 }, (_, index) => JSON.stringify({ at: 1700000000000 + index, kind: "工具", text: `记录 ${index} ${"x".repeat(100)}` }) + "\n").join(""));
  await withPanel(f.parent, (component) => {
    component.handleInput("\r");
    assert.match(component.render(90).join("\n"), /近期日志/);
    component.handleInput("3");
    const result = component.render(90).join("\n");
    assert.match(result, /已检查/);
    assert.doesNotMatch(result, /\*\*已检查\*\*/);
  });
  await withPanel(randomUUID(), (component, _terminal, actions) => {
    assert.match(component.render(80).join("\n"), /描述并创建/);
    component.handleInput("n"); component.handleInput("g");
    assert.deepEqual(actions, [{ action: "创建" }, { action: "配置" }]);
  });
});

function settingsContext(steps: Array<string | undefined>, inputs: Array<string | undefined> = []) {
  const notices: string[] = [];
  const hooks = { onChoice: async (_step: string | undefined) => {} };
  const ctx: any = {
    mode: "tui", model: { id: "model-a" },
    modelRegistry: { getAvailable: () => [{ provider: "fixture", id: "model-b", name: "模型 B" }] },
    ui: {
      custom: async (factory: any) => {
        let result: any;
        const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, undefined, (value: any) => { result = value; });
        const step = steps.shift();
        chooseRenderedMenu(component, step);
        await hooks.onChoice(step);
        return result;
      },
      input: async () => inputs.shift(), notify: (text: string) => notices.push(text),
    },
  };
  return { ctx, notices, hooks };
}
async function role() {
  const file = path.join(getAgentDir(), "agents", `${randomUUID()}.md`);
  const text = '---\nname: 审查员\ndescription: 仔细审查\ntools: [read, grep]\ndisallowedTools: [bash]\nwritePermission: false\nmodel: inherit\ntimeoutMs: 0\nmaxConcurrent: 2\n---\n保留这段提示词。\n';
  await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text);
  return { file, text, agent: parseAgentDefinition(text, file, "用户") };
}

test("全局菜单编辑 Jev 开关和时限，保存仅更新修改字段，取消不落盘", async () => {
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
  const h = settingsContext(["Jev 自动选配", "关闭", "默认时限", "自定义分钟数", "保存并返回"], ["15"]);
  let changes = 0;
  await editGlobalConfig(h.ctx, () => changes++);
  assert.deepEqual(readDeckConfig(), { ...DEFAULT_CONFIG, timeoutMs: 900000, routing: { ...DEFAULT_CONFIG.routing, enabled: false } });
  assert.equal(changes, 1);
  const cancelled = settingsContext(["Jev 自动选配", "开启", "返回，不保存"]);
  await editGlobalConfig(cancelled.ctx, () => changes++);
  assert.equal(readDeckConfig().routing.enabled, false);
  assert.equal(changes, 1);
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
});

test("角色菜单选择模型和思考强度，保留其他权限、时限和提示词", async () => {
  const f = await role();
  const h = settingsContext(["模型", "fixture", "模型 B", "思考强度", "高 ·", "保存并返回"]);
  h.ctx.modelRegistry.getAvailable = () => [{ provider: "fixture", id: "model-b", name: "模型 B" }, { provider: "fixture", id: "gpt-6-astra", name: "Astra" }];
  const menu = h.ctx.ui.custom;
  let checkedModelMenu = false;
  h.ctx.ui.custom = (factory: any) => menu((...args: any[]) => {
    const component = factory(...args);
    const rendered = component.render(100).join("\n");
    if (rendered.includes("选择 fixture 模型")) {
      checkedModelMenu = true;
      assert.match(rendered, /模型 B/);
      assert.doesNotMatch(rendered, /Astra|gpt-6-astra/);
    }
    return component;
  });
  await editAgentConfig(h.ctx, f.agent);
  assert.equal(checkedModelMenu, true);
  const saved = parseAgentDefinition(await fs.readFile(f.file, "utf8"), f.file, "用户");
  assert.equal(saved.model, "fixture/model-b"); assert.equal(saved.thinking, "high");
  assert.equal(saved.writePermission, false); assert.deepEqual(saved.disallowedTools, ["bash"]);
  assert.equal(saved.timeoutMs, 0); assert.equal("maxConcurrent" in saved, false); assert.equal(saved.systemPrompt, "保留这段提示词。");
});

test("工具勾选真实按键交互，确认后权限与选择一致，Esc 取消不写文件", async () => {
  const f = await role();
  const h = settingsContext(["工具", "保存并返回"]);
  const menu = h.ctx.ui.custom;
  h.ctx.ui.custom = async (factory: any) => {
    let result: string[] | undefined;
    const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, undefined, (value: any) => { result = value; });
    if (!component.render(80).join("\n").includes("选择工具")) return menu(factory);
    assert.match(component.render(80).join("\n"), /\[✓\] 读取文件/);
    for (let i = 0; i < 4; i++) component.handleInput("\u001b[B");
    component.handleInput(" "); component.handleInput("\r");
    assert.ok(component.render(40).every((line: string) => visibleWidth(line) <= 40));
    return result;
  };
  await editAgentConfig(h.ctx, f.agent);
  const saved = parseAgentDefinition(await fs.readFile(f.file, "utf8"), f.file, "用户");
  assert.equal(saved.writePermission, true); assert.ok(saved.tools?.includes("edit"));
  assert.deepEqual(saved.disallowedTools, []);
  h.ctx.ui.custom = async (factory: any) => { let result: any = "pending"; const component = factory({ requestRender() {} }, theme, undefined, (value: any) => { result = value; }); component.handleInput(" "); component.handleInput("\u001b"); return result; };
  assert.equal(await selectAgentTools(h.ctx, ["read"]), undefined);
});

test("角色配置在别处被修改时不会覆盖；原始编辑入口仍可保存", async () => {
  const f = await role();
  const h = settingsContext(["思考强度", "高 ·", "保存并返回", "返回，不保存"]);
  h.hooks.onChoice = async (step) => { if (step === "保存并返回") await fs.writeFile(f.file, f.text + "外部新增内容。\n"); };
  await editAgentConfig(h.ctx, f.agent);
  assert.match(await fs.readFile(f.file, "utf8"), /外部新增内容/);
  assert.ok(h.notices.some((text) => text.includes("其他地方修改")));
  const current = parseAgentDefinition(await fs.readFile(f.file, "utf8"), f.file, "用户");
  h.ctx.ui.editor = async () => f.text.replace("仔细审查", "审查并提供证据");
  await editAgentConfig(h.ctx, current, true);
  assert.match(await fs.readFile(f.file, "utf8"), /审查并提供证据/);
});

test("长选择菜单随窗口缩放滚动，保留选中项，支持翻页和首尾导航", async () => {
  const terminal = { rows: 16 };
  const choices = Array.from({ length: 100 }, (_, index) => ({ value: index, label: `模型 ${index} · ${"很长的模型名称".repeat(20)}` }));
  const ctx: any = { ui: { custom: async (factory: any) => {
    let result: any;
    const component = factory({ terminal, requestRender() {} }, theme, undefined, (value: any) => { result = value; });
    const small = component.render(70);
    assert.ok(small.length <= panelHeight(terminal.rows));
    assert.ok(small.every((line: string) => visibleWidth(line) <= 70));
    assert.match(small.join("\n"), /› 模型 50/);
    component.handleInput("\u001b[6~");
    assert.match(component.render(70).join("\n"), /› 模型 57/);
    terminal.rows = 40;
    assert.ok(component.render(70).length > small.length);
    component.handleInput("\u001b[F");
    assert.match(component.render(70).join("\n"), /100 \/ 100/);
    component.handleInput("\r"); assert.equal(result, 99);
    component.handleInput("\u001b[H"); component.handleInput("\r"); assert.equal(result, 0);
    component.handleInput("\u001b"); assert.equal(result, undefined);
    return result;
  } } };
  await selectMenu(ctx, "选择模型", choices, 50);
});
