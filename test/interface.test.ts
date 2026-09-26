import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import agentDeck from "../src/index.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const indexSource = fs.readFileSync(path.join(root, "src/index.ts"), "utf8");
const uiSource = fs.readFileSync(path.join(root, "src/ui.ts"), "utf8");

test("保留兼容面板入口，不注册全局快捷键", () => {
  assert.match(indexSource, /registerCommand\("agent-panel"/);
  assert.doesNotMatch(indexSource, /registerShortcut\(/);
});

test("不暴露子 Session 切换功能", () => {
  assert.doesNotMatch(indexSource, /registerCommand\("agent-session"/);
  assert.doesNotMatch(indexSource, /registerCommand\("agent-back"/);
  assert.doesNotMatch(indexSource, /switchSession\(/);
  assert.doesNotMatch(uiSource, /action: "打开"/);
  assert.doesNotMatch(uiSource, /O 打开/);
});

test("派遣默认执行且面板停靠在输入框上方", () => {
  assert.doesNotMatch(indexSource, /批准派遣子 Agent/);
  assert.doesNotMatch(indexSource, /placement: "belowEditor"/);
  assert.match(uiSource, /anchor: "bottom-center"/);
});

test("启动后只暴露简洁任务工具；空白任务被拒绝", async () => {
  const tools = new Map<string, any>();
  const handlers = new Map<string, any>();
  let active: string[] = [];
  agentDeck({
    registerTool: (tool: any) => { tools.set(tool.name, tool); active.push(tool.name); },
    registerCommand() {}, registerMessageRenderer() {},
    on: (event: string, handler: any) => handlers.set(event, handler),
    getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
  } as any);
  const ctx = { sessionManager: { getSessionId: () => "isolated-interface", getBranch: () => [] }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
  try {
    await handlers.get("session_start")({}, ctx);
    assert.deepEqual(active.sort(), ["Agent", "SendMessage", "TaskStop"]);
    assert.deepEqual([...tools.keys()].sort(), ["Agent", "SendMessage", "TaskStop"]);
    assert.deepEqual(tools.get("Agent").parameters.required, ["prompt"]);
    assert.deepEqual(tools.get("SendMessage").parameters.required, ["to", "message"]);
    assert.deepEqual(tools.get("TaskStop").parameters.required, ["task_id"]);
    for (const tool of tools.values()) assert.equal(tool.parameters.additionalProperties, false);
    assert.deepEqual(Object.keys(tools.get("Agent").parameters.properties), ["description", "prompt", "resume", "subagent_type", "model", "name", "run_in_background"]);
    await assert.rejects(tools.get("Agent").execute("test", { description: "标题", prompt: " " }, undefined, undefined, ctx), /prompt/);
  } finally { handlers.get("session_shutdown")(); }
});

test("Agent 详情提供任务、实时和报告三页", () => {
  assert.match(uiSource, /"任务说明" \| "实时记录" \| "报告"/);
  assert.match(uiSource, /renderInstruction/);
  assert.match(uiSource, /renderTranscript/);
  assert.match(uiSource, /renderReports/);
});
