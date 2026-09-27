import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resultMessage, taskOutput } from "../src/delivery.ts";
import agentDeck from "../src/index.ts";
import { initializeRun, runDirectory, shutdownRuns } from "../src/runtime.ts";
import { createBackgroundDelivery } from "../src/background-delivery.ts";
import { taskToolResult } from "../src/tool-contract.ts";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai";
import { readMessages, recordMessage, submitMessages } from "../src/message-store.ts";

const run: any = {
  version: 2, runId: "test-delivery", turnId: "first", deliveryMode: "background",
  roleId: "scout", agentName: "调查", agentSource: "内置", parentSessionId: "parent",
  objective: "检查登录", instruction: "检查登录", status: "已完成", model: "fixture/model", thinking: "off",
  tools: [], extensions: [], disallowedTools: [], writePermission: false, cwd: process.cwd(),
  childSessionId: "child", childSessionPath: "child.jsonl", startedAt: 1, endedAt: 2, events: [], finalText: "找到原因",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

test("模型可见回执保留任务身份、状态和操作信息，选配中不报告未确定模型", () => {
  for (const status of ["选配中", "运行中", "已完成", "失败", "停止未确认", "已停止"]) {
    const current = { ...run, version: 3, status, instanceName: "login-check", routingPending: status === "选配中" };
    const result = taskToolResult(current, "操作正文", "queued");
    const text = result.content.map((block) => block.text).join("\n");
    assert.match(text, /^agentId: test-delivery$/m);
    assert.match(text, /^name: login-check$/m);
    assert.ok(text.includes(status === "已完成" ? "已返回结果" : status));
    assert.match(text, /queued/);
    assert.ok(text.endsWith("操作正文"));
    if (current.routingPending) assert.ok(!text.includes(current.model));
    else assert.ok(text.includes(current.model));
    assert.equal(result.details.publicResult.agentId, run.runId);
  }
});

test("真实 Pi 消息转换后模型仍可从后台回执寻址，不依赖 details", () => {
  const current = { ...run, status: "运行中", version: 3 };
  const result = taskToolResult(current, "后台执行中");
  const model: any = { id: "model", provider: "fixture", api: "openai-responses", input: ["text"], reasoning: false };
  const messages: any[] = [
    { role: "assistant", content: [{ type: "toolCall", id: "call_receipt", name: "Agent", arguments: { description: "检查", prompt: "检查入口", run_in_background: true } }],
      api: model.api, provider: model.provider, model: model.id, usage: run.usage, stopReason: "toolUse", timestamp: 1 },
    { role: "toolResult", toolCallId: "call_receipt", toolName: "Agent", ...result, isError: false, timestamp: 2 },
  ];
  const converted = convertResponsesMessages(model, normalizeContext({ messages }), new Set(["fixture"]));
  const output = converted.find((item) => item.type === "function_call_output");
  assert.ok(output && "output" in output);
  assert.equal(typeof output.output, "string");
  assert.match(output.output as string, /^agentId: test-delivery$/m);
  assert.ok(!JSON.stringify(output).includes("childSessionPath"), "内部运行记录不应注入模型正文");
});

test("工具终态与后台通知只有一个身份头，保留完整结果和停止失败原因", () => {
  const current = { ...run, version: 3, status: "停止未确认", resourceState: "releasing", failureReason: "CLOSE_ERROR", persistenceError: "SAVE_ERROR", finalText: "x".repeat(30000) + "TAIL" };
  const text = taskToolResult(current, taskOutput(current)).content[0].text;
  assert.equal((text.match(/^agentId:/gm) ?? []).length, 1);
  assert.doesNotMatch(text, /\[Agent test-delivery/);
  assert.ok(text.endsWith(current.finalText));
  const stopped = taskToolResult(current, "停止未确认；请重试。").content[0].text;
  for (const marker of ["CLOSE_ERROR", "SAVE_ERROR", "releasing"]) assert.ok(stopped.includes(marker));
  const notice = resultMessage(current, "parent")!;
  assert.equal((notice.content.match(/^agentId:/gm) ?? []).length, 1);
  assert.doesNotMatch(notice.content, /\[Agent test-delivery/);
  assert.ok(notice.details.evidence.endsWith("TAIL"));
});

test("结果只交给所属会话，执行编号保留在通知元数据", () => {
  const message = resultMessage(run, "parent")!;
  assert.match(message.content, /找到原因/);
  assert.equal(message.details.turnId, "first");
  assert.doesNotMatch(message.content, /turn_id:/);
  assert.equal(resultMessage(run, "other"), undefined);
  assert.notEqual(resultMessage({ ...run, turnId: "second" }, "parent")!.details.deliveryId, message.details.deliveryId);
  assert.equal(resultMessage({ ...run, deliveryMode: "foreground" }, "parent"), undefined);
});

test("通知保留完整证据与可读取的子会话入口", () => {
  const long = resultMessage({ ...run, finalText: "x".repeat(30000) + "TAIL_EVIDENCE", childSessionPath: "C:/fixture/session.jsonl" }, "parent")!;
  assert.ok(long.content.length < 26000);
  assert.match(long.content, /C:\/fixture\/session.jsonl/);
  assert.match(long.details.evidence, /TAIL_EVIDENCE/);
  for (const field of ["failureReason", "persistenceError"] as const) {
    const failed = resultMessage({ ...run, status: "失败", [field]: "x".repeat(30000) + "TAIL_ERROR" }, "parent")!;
    assert.ok(failed.content.length < 26000);
    assert.match(failed.details.evidence, /TAIL_ERROR/);
  }
});

test("问题通知带回答地址，连续问题和最终交付有各自的投递编号", () => {
  const waiting = { ...run, version: 3, status: "等待决定", pendingQuestion: { id: "q1", message: "需要哪种格式？" } };
  const first = resultMessage(waiting, "parent")!;
  assert.match(first.content, /需要哪种格式/);
  assert.match(first.content, /reply_to=q1/);
  const second = resultMessage({ ...waiting, pendingQuestion: { id: "q2", message: "补充目标路径" } }, "parent")!;
  const final = resultMessage({ ...waiting, status: "已完成", pendingQuestion: undefined }, "parent")!;
  assert.equal(new Set([first, second, final].map(x => x.details.deliveryId)).size, 3);
  assert.equal(resultMessage({ ...waiting, deliveryMode: "foreground" }, "parent"), undefined);
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

test("后台通知核对期间切换父会话不会串投，重复结果仍只交付一次", async (t) => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-context-switch", resourceState: "released" },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  t.after(() => shutdownRuns("parent"));
  const messages: unknown[] = [];
  const parent: any = { sessionManager: { getSessionId: () => "parent" }, ui: { setStatus() {} } };
  let context: any = parent;
  const delivery = createBackgroundDelivery({ sendMessage: (message) => { messages.push(message); } }, () => context);
  const first = delivery.notify(current);
  context = { ...parent, sessionManager: { getSessionId: () => "other-parent" } };
  await first;
  assert.equal(messages.length, 0);
  context = parent;
  await Promise.all([delivery.notify(current), delivery.notify(current)]);
  assert.equal(messages.length, 1);
  await delivery.notify({ ...current, turnId: "outdated-turn" });
  assert.equal(messages.length, 1, "旧轮通知不能作为新结果发送");
  context = undefined;
  delivery.reset();
  await delivery.notify(current);
  assert.equal(messages.length, 1, "关闭所属会话后不再发送");
});

test("发送成功仅表示已提交，真实父输入事件才确认消费", async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-consumption", resourceState: "released" },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const messages: any[] = [];
  const ctx: any = { sessionManager: { getSessionId: () => "parent" }, ui: { setStatus() {} } };
  const delivery = createBackgroundDelivery({ sendMessage: message => { messages.push(message); } }, () => ctx);
  await delivery.notify(current);
  let records = await readMessages(current.runId);
  assert.equal(records.length, 1);
  assert.equal(records[0].state, "pending");
  assert.ok(records[0].submittedAt);
  await delivery.consume({ ...messages[0], role: "assistant" }, "parent");
  await delivery.consume({ ...messages[0], role: "custom" }, "other");
  assert.equal((await readMessages(current.runId))[0].state, "pending");
  await delivery.consume({ ...messages[0], role: "custom" }, "parent");
  records = await readMessages(current.runId);
  assert.equal(records[0].state, "consumed");
  assert.equal(records[0].text, taskOutput(current));
});

test("工具与后台争用同一问题交付，登记后只由真实工具输入确认消费", async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-question-gate", status: "等待决定", pendingQuestion: { id: "q-gate", message: "格式？" } },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const messages: any[] = [];
  const ctx: any = { sessionManager: { getSessionId: () => "parent" }, ui: { setStatus() {} } };
  const delivery = createBackgroundDelivery({ sendMessage: message => { messages.push(message); } }, () => ctx);
  const gate = delivery.acquire(current.runId);
  const pending = delivery.notify(current);
  delivery.release(current, gate);
  await pending;
  const deliveryId = await delivery.recordToolResult(current);
  await delivery.notify(current);
  assert.equal(messages.length, 0);
  assert.equal((await readMessages(current.runId))[0].text, "格式？");
  assert.equal((await readMessages(current.runId))[0].state, "pending");
  await delivery.consume({ role: "toolResult", details: { run: current, deliveryId }, content: [] }, "parent");
  assert.equal((await readMessages(current.runId))[0].state, "consumed");
});

test("非活动父会话仍记录消息；恢复只补送未提交结果并核对原会话证据", async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-recovery", resourceState: "released", parentSessionPath: path.join(runDirectory("delivery-recovery"), "parent.jsonl") },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  let ctx: any;
  const messages: any[] = [];
  const delivery = createBackgroundDelivery({ sendMessage: message => { messages.push(message); } }, () => ctx);
  await delivery.notify(current);
  assert.equal(messages.length, 0);
  assert.equal((await readMessages(current.runId))[0].submittedAt, undefined);
  ctx = { sessionManager: { getSessionId: () => "parent" }, ui: { setStatus() {} } };
  await delivery.recover([current]);
  assert.equal(messages.length, 1);
  const warning = await delivery.recover([current]);
  assert.equal(messages.length, 1, "接口已提交但缺消费证据时不盲目重投");
  assert.equal((await readMessages(current.runId))[0].state, "unknown");
  assert.match(warning.join("\n"), /待核实.*messages\.json/);
  await fs.writeFile(current.parentSessionPath!, JSON.stringify({ type: "custom_message", ...messages[0] }) + "\n");
  await delivery.recover([current]);
  assert.equal((await readMessages(current.runId))[0].state, "consumed");
  assert.equal(messages.length, 1);
});

test("普通进度按原编号记录，子消息发送回执不替代接收证据", async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-progress", status: "运行中" },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const messages: any[] = [];
  const ctx: any = { sessionManager: { getSessionId: () => "parent" }, ui: { setStatus() {} } };
  const delivery = createBackgroundDelivery({ sendMessage: message => { messages.push(message); } }, () => ctx);
  await recordMessage(current, "to-child", "检查", "child-message");
  await submitMessages(current.runId, ["child-message"]);
  await delivery.consume({ role: "toolResult", details: { run: current, messageId: "child-message" }, content: [] }, "parent");
  await Promise.all([delivery.progress(current, { id: "progress-message", message: "检查到入口" }), delivery.progress(current, { id: "progress-message", message: "检查到入口" })]);
  assert.equal(messages.length, 1);
  await delivery.consume({ ...messages[0], role: "custom" }, "parent");
  const records = await readMessages(current.runId);
  assert.equal(records.find(record => record.id === "child-message")?.state, "pending");
  assert.equal(records.find(record => record.id === "progress-message")?.state, "consumed");
});

test("同一上下文对象切换父会话时撤销未发送的提交标记", async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-reused-context", status: "运行中" },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const messages: any[] = [];
  let checks = 0;
  let restored = false;
  const ctx: any = { sessionManager: { getSessionId: () => restored || ++checks === 1 ? "parent" : "other" }, ui: { setStatus() {} } };
  const delivery = createBackgroundDelivery({ sendMessage: message => { messages.push(message); } }, () => ctx);
  await delivery.progress(current, { id: "switch-progress", message: "已找到入口" });
  assert.equal(messages.length, 0);
  const [record] = await readMessages(current.runId);
  assert.equal(record.state, "pending");
  assert.equal(record.submittedAt, undefined, "确定没有调用发送接口的消息仍可安全投递");
  restored = true;
  await delivery.recover([current]);
  assert.equal(messages.length, 1);
});

test("gate 释放发生在提交回退期间，重投等待旧尝试结束后继续", { timeout: 3000 }, async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-gate-wakeup", resourceState: "released" },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const messages: any[] = [];
  let received!: () => void;
  const sent = new Promise<void>(resolve => { received = resolve; });
  let checks = 0;
  let gate: ReturnType<ReturnType<typeof createBackgroundDelivery>["acquire"]>;
  const ctx: any = { sessionManager: { getSessionId: () => "parent" }, ui: { setStatus() {} } };
  const delivery = createBackgroundDelivery({ sendMessage: message => { messages.push(message); received(); } }, () => {
    checks++;
    // Acquire after the pre-submit context check, then release while its
    // rollback yields. This models a failed competing resume returning control.
    if (checks === 3) queueMicrotask(() => { gate = delivery.acquire(current.runId); });
    if (checks === 4) queueMicrotask(() => delivery.discard(current.runId, gate));
    return ctx;
  });
  await delivery.notify(current);
  await sent;
  assert.equal(messages.length, 1);
  const [record] = await readMessages(current.runId);
  assert.equal(record.state, "pending");
  assert.ok(record.submittedAt);
  await delivery.notify(current);
  assert.equal(messages.length, 1);
});

test("扩展工具结果登记与输入消费分开，恢复核对提示进入下一轮主上下文", async () => {
  const current = await initializeRun({ ...run, version: 3, runId: "delivery-tool-hooks", resourceState: "released", deliveryMode: "foreground" },
    { version: 3, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, false);
  const handlers = new Map<string, any>();
  const tools = new Map<string, any>();
  const ctx: any = { sessionManager: { getSessionId: () => "parent", getBranch: () => [] }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
  agentDeck({
    on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand() {}, registerMessageRenderer() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {}, sendMessage() {},
  } as any);
  const result = taskToolResult(current, taskOutput(current));
  const change = await handlers.get("tool_result")({ toolName: "Agent", isError: false, ...result }, ctx);
  assert.ok(change.details.deliveryId);
  assert.equal((await readMessages(current.runId))[0].state, "pending");
  assert.ok((await readMessages(current.runId))[0].submittedAt);
  try {
    await handlers.get("session_start")({}, ctx);
    assert.equal((await readMessages(current.runId))[0].state, "unknown");
    const notice = await handlers.get("before_agent_start")({}, ctx);
    assert.match(notice.message.content, /待核实.*messages\.json/);
    assert.equal(await handlers.get("before_agent_start")({}, ctx), undefined);
    await handlers.get("message_end")({ message: { role: "toolResult", ...result, details: change.details } }, ctx);
    assert.equal((await readMessages(current.runId))[0].state, "consumed");
  } finally { await handlers.get("session_shutdown")(); }
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
    assert.equal(handlers.has("context"), false, "历史消息保持原文，当前状态由新回执说明");
  } finally { await handlers.get("session_shutdown")(); }
});
