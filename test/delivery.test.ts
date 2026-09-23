import assert from "node:assert/strict";
import test from "node:test";
import { labelHistoricalMessage, resultMessage, taskOutput } from "../src/delivery.ts";
import agentDeck from "../src/index.ts";
import { initializeRun } from "../src/runtime.ts";

const run: any = { version: 1, runId: "test-delivery", turnId: "first", autoDeliver: true, parentSessionId: "parent", agentName: "调查", objective: "检查登录", status: "已完成", startedAt: 1, endedAt: 2, reports: [], events: [], finalText: "找到原因" };

test("结果只交给所属会话，并标明结果的执行编号", () => {
  const message = resultMessage(run, "parent")!;
  assert.match(message.content, /找到原因/);
  assert.match(message.content, /turn_id: first/);
  assert.equal(resultMessage(run, "other"), undefined);
  assert.notEqual(resultMessage({ ...run, turnId: "second" }, "parent")!.details.deliveryId, message.details.deliveryId);
  assert.equal(resultMessage({ ...run, autoDeliver: false }, "parent"), undefined);
});

test("排队旧结果和已回答的问题标为历史，不修改保存的原消息", () => {
  const message = resultMessage(run, "parent")!;
  const current = { ...run, turnId: "second", status: "运行中", finalText: undefined };
  const labeled = labelHistoricalMessage(message, current);
  assert.match(String(labeled.content), /历史通知/);
  assert.match(String(labeled.content), /当前任务状态：运行中/);
  assert.doesNotMatch(message.content, /历史通知/);
  assert.equal(labelHistoricalMessage(message, run), message);
  const question = { ...run, status: "等待决定", pendingQuestion: { id: "q1", turnId: "first", question: "选哪个？", options: ["A", "B"] } };
  const asked = resultMessage(question, "parent")!;
  assert.match(asked.content, /reply_to: q1/);
  assert.match(String(labelHistoricalMessage(asked, { ...run, status: "运行中" }).content), /历史通知/);
});

test("最终文本不会被同一轮已经回答的旧问题报告替代", () => {
  const completed = { ...run, reports: [{ type: "问题", blocking: true, summary: "旧问题", question: "旧问题", evidence: [], tests: [], risks: [] }] };
  assert.equal(taskOutput(completed), "找到原因");
});

test("重载不补送旧结果或重放旧任务；当前会话边界仍有效", async () => {
  await initializeRun(run, { version: 1, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const messages: any[] = [];
  const ctx: any = { sessionManager: { getSessionId: () => "parent", getBranch: () => [] }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
  agentDeck({
    on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {}, registerMessageRenderer() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {},
    sendMessage: (message: any) => messages.push(message),
  } as any);
  try {
    await handlers.get("session_start")({}, ctx);
    assert.equal(messages.length, 0);
    const other = { ...ctx, sessionManager: { getSessionId: () => "other" } };
    await assert.rejects(tools.get("SendMessage").execute("id", { to: run.runId, message: "继续" }, undefined, undefined, other), /当前会话/);
    await assert.rejects(tools.get("TaskStop").execute("id", { task_id: run.runId }, undefined, undefined, other), /当前会话/);
    const previous = resultMessage(run, "parent")!;
    const result = await handlers.get("context")({ messages: [{ role: "custom", ...previous, details: { ...previous.details, turnId: "old" } }] });
    assert.match(String(result.messages[0].content), /历史通知/);
  } finally { await handlers.get("session_shutdown")(); }
});
