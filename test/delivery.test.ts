import assert from "node:assert/strict";
import test from "node:test";
import { labelHistoricalMessage, resultMessage, taskOutput } from "../src/delivery.ts";
import agentDeck from "../src/index.ts";
import { initializeRun } from "../src/runtime.ts";

const run: any = {
  version: 2, runId: "test-delivery", turnId: "first", deliveryMode: "background",
  roleId: "scout", agentName: "调查", agentSource: "内置", parentSessionId: "parent",
  objective: "检查登录", instruction: "检查登录", status: "已完成", model: "fixture/model", thinking: "off",
  tools: [], extensions: [], disallowedTools: [], writePermission: false, cwd: process.cwd(),
  childSessionId: "child", childSessionPath: "child.jsonl", startedAt: 1, endedAt: 2, events: [], finalText: "找到原因",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

test("结果只交给所属会话，执行编号保留在通知元数据", () => {
  const message = resultMessage(run, "parent")!;
  assert.match(message.content, /找到原因/);
  assert.equal(message.details.turnId, "first");
  assert.doesNotMatch(message.content, /turn_id:/);
  assert.equal(resultMessage(run, "other"), undefined);
  assert.notEqual(resultMessage({ ...run, turnId: "second" }, "parent")!.details.deliveryId, message.details.deliveryId);
  assert.equal(resultMessage({ ...run, deliveryMode: "foreground" }, "parent"), undefined);
});

test("排队旧结果和已回答的问题标为历史，不修改保存的原消息", () => {
  const message = resultMessage(run, "parent")!;
  const current = { ...run, turnId: "second", status: "运行中", finalText: undefined };
  const labeled = labelHistoricalMessage(message, current);
  assert.match(String(labeled.content), /历史通知/);
  assert.match(String(labeled.content), /当前任务状态：运行中/);
  assert.doesNotMatch(message.content, /历史通知/);
  assert.equal(labelHistoricalMessage(message, run), message);
  const question = { ...run, version: 1, status: "等待决定", legacy: { pendingQuestion: { id: "q1", turnId: "first", question: "选哪个？", options: ["A", "B"] } } };
  const asked = resultMessage(question, "parent")!;
  assert.doesNotMatch(asked.content, /Agent\(\{resume:/);
  assert.match(String(labelHistoricalMessage(asked, { ...run, status: "运行中" }).content), /历史通知/);
});

test("旧通知上下文保留完整失败证据但不带旧续接指令，原消息不变", () => {
  const old = { ...run, status: "失败", failureReason: "ROOT_CAUSE", persistenceError: "DISK_ERROR", events: [{ at: 2, kind: "错误", text: "EXTRA_ERROR" }], finalText: "PARTIAL_ARTIFACT", resultCompleteness: "执行失败" };
  const message = resultMessage(old, "parent")!;
  const current = { ...run, turnId: "new", status: "运行中" };
  const projection = labelHistoricalMessage(message, current);
  for (const marker of ["ROOT_CAUSE", "DISK_ERROR", "EXTRA_ERROR", "PARTIAL_ARTIFACT"]) assert.match(String(projection.content), new RegExp(marker));
  assert.doesNotMatch(String(projection.content), /Agent\(\{resume:/);
  const legacy = { ...message, details: { ...message.details, evidence: undefined }, content: `${message.content}\n\n同一任务返工请明确调用 Agent({resume: "old", prompt: "本次要求"})；新目标请新建任务。` };
  assert.doesNotMatch(String(labelHistoricalMessage(legacy, current).content), /Agent\(\{resume:/);
  assert.match(legacy.content, /Agent\(\{resume:/);
});

test("0.11 旧问题及文本块投影去插件生成的 SendMessage/reply_to 尾部，保留证据块", () => {
  const current = { ...run, turnId: "new", status: "运行中" };
  const tail = "\n\nSendMessage 的 to 使用 test-delivery。回答此问题必须填写 reply_to: q-old；普通补充不填写 reply_to，不能解除等待。";
  const legacy: any = { content: `Agent 任务结果\nagentId: test-delivery\nturn_id: first\n本次执行状态：等待决定\n\n问题证据：FILE_A\nERROR_LOG${tail}`, details: { taskId: run.runId, turnId: "first", questionId: "q-old" } };
  const text = String(labelHistoricalMessage(legacy, current).content);
  assert.match(text, /FILE_A/); assert.match(text, /ERROR_LOG/);
  assert.doesNotMatch(text, /SendMessage 的 to|reply_to: q-old/);
  const blocks = { ...legacy, content: [{ type: "text", text: legacy.content.slice(0, 50) }, { type: "text", text: legacy.content.slice(50) }] };
  const projected = labelHistoricalMessage(blocks, current).content as unknown;
  assert.match(JSON.stringify(projected), /FILE_A|ERROR_LOG/);
  assert.doesNotMatch(JSON.stringify(projected), /reply_to: q-old|SendMessage 的 to/);
  assert.match(JSON.stringify(blocks.content), /reply_to: q-old/);
});

test("同一turn清理状态已改变，旧停止未确认通知也不是当前待办", () => {
  const old = resultMessage({ ...run, status: "停止未确认", resourceState: "releasing", failureReason: "CLOSE_ERROR" }, "parent")!;
  const projected = labelHistoricalMessage(old, { ...run, resourceState: "released" });
  assert.match(String(projected.content), /历史通知/);
  assert.match(String(projected.content), /CLOSE_ERROR/);
  assert.match(taskOutput({ ...run, failureReason: "RECOVERED_CLOSE_ERROR" }), /RECOVERED_CLOSE_ERROR/);
});

test("历史投影保留非文本附件；模型摘要有边界但完整证据仍保存", () => {
  const image = { type: "image", data: "evidence-image", mimeType: "image/png" };
  const current = { ...run, turnId: "next" };
  const old = { ...resultMessage(run, "parent")!, content: [{ type: "text", text: "ARTIFACT" }, image] };
  const projection = labelHistoricalMessage(old, current);
  assert.ok(Array.isArray(projection.content));
  assert.deepEqual((projection.content as any[]).at(-1), image);
  const long = resultMessage({ ...run, finalText: "x".repeat(30000) + "TAIL_EVIDENCE", childSessionPath: "C:/fixture/session.jsonl" }, "parent")!;
  assert.ok(long.content.length < 26000);
  assert.match(long.content, /完整.*证据|完整.*结果/);
  assert.match(long.details.evidence, /TAIL_EVIDENCE/);
  const history = labelHistoricalMessage(long, current);
  assert.ok(String(history.content).length < 26000);
  assert.equal(history.details.evidence, long.details.evidence);
});

test("v3 当前最终文本不会被旧问题或旧最终报告替代", () => {
  const completed = { ...run, version: 3, legacy: { reports: [
    { type: "问题", blocking: true, summary: "旧问题", question: "旧问题", evidence: [], tests: [], risks: [] },
    { type: "最终", blocking: false, summary: "OLD_FINAL_REPORT", evidence: [], tests: [], risks: [] },
  ] } };
  assert.match(taskOutput(completed), /找到原因/);
  assert.doesNotMatch(taskOutput(completed), /旧问题|OLD_FINAL_REPORT/);
  const currentMessage = resultMessage({ ...completed, legacy: { ...completed.legacy, pendingQuestion: { id: "old-question", turnId: "old-turn", question: "旧问题", options: [] } } }, "parent")!;
  assert.equal(currentMessage.details.questionId, undefined);
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
