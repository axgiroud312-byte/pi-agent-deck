import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  addressedMessage, consumeMessages, inputMessageIds, messageIds, messagesPath,
  readMessages, reconcileMessages, recordMessage, settleMessages, submitMessages,
} from "../src/message-store.ts";
import { runDirectory } from "../src/run-store.ts";
import type { PersistedRun } from "../src/types.ts";

function task(): Pick<PersistedRun, "runId" | "turnId"> {
  return { runId: `message-store-${randomUUID()}`, turnId: "turn-1" };
}

function nativeSession(runId: string, name: string): SessionManager {
  const session = SessionManager.create(process.cwd(), path.join(runDirectory(runId), name));
  session.appendMessage(fauxAssistantMessage("原生会话已保存"));
  return session;
}

test("消息正文与状态持久化，提交回执只证明提交且读取不泄漏可变引用", async () => {
  const run = task();
  assert.deepEqual(await readMessages(run.runId), []);
  const message = await recordMessage(run, "to-child", "补充检查 Windows 路径");
  assert.equal(message.state, "pending");
  assert.equal(message.submittedAt, undefined);
  assert.equal(message.turnId, "turn-1");
  assert.ok(message.createdAt > 0);
  assert.deepEqual(JSON.parse(await fs.readFile(messagesPath(run.runId), "utf8")), [message]);
  message.text = "调用方修改";
  assert.equal((await readMessages(run.runId))[0].text, "补充检查 Windows 路径");
  await submitMessages(run.runId, [message.id], "turn-2");
  const submitted = (await readMessages(run.runId))[0];
  assert.equal(submitted.state, "pending", "提交不等于接收方已消费");
  assert.equal(submitted.turnId, "turn-2");
  assert.ok(submitted.submittedAt);
  await consumeMessages(run.runId, "to-child", [message.id]);
  const consumed = (await readMessages(run.runId))[0];
  assert.equal(consumed.state, "consumed");
  assert.ok(consumed.submittedAt);
});

test("相同正文的两次请求使用不同编号，同一编号重试只保留一条", async () => {
  const run = task();
  const first = await recordMessage(run, "to-child", "继续检查");
  const second = await recordMessage(run, "to-child", "继续检查");
  assert.notEqual(first.id, second.id);
  assert.deepEqual(await recordMessage(run, "to-child", "继续检查", first.id), first);
  await assert.rejects(recordMessage(run, "to-child", "另一项要求", first.id), /消息编号/);
  await assert.rejects(recordMessage(run, "to-parent", "继续检查", first.id), /消息编号/);
  assert.equal((await readMessages(run.runId)).length, 2);
  await consumeMessages(run.runId, "to-child", [first.id]);
  assert.deepEqual((await readMessages(run.runId)).map(record => record.state), ["consumed", "pending"]);
});

test("消息编号从输入证据提取，assistant 或其他角色引用编号不算消费", () => {
  const id = randomUUID();
  const content = [{ type: "text", text: addressedMessage(id, "补充要求") }];
  assert.deepEqual(messageIds(content[0].text), [id]);
  for (const role of ["assistant", "system", "bashExecution", undefined]) {
    assert.deepEqual(inputMessageIds({ role, content, details: { messageId: id, deliveryId: id } }), []);
  }
  assert.deepEqual(inputMessageIds({ role: "user", content }), [id]);
  assert.deepEqual(inputMessageIds({ role: "toolResult", content: [{ type: "image", data: "ignored" }], details: { messageId: id } }), [id]);
  assert.deepEqual(inputMessageIds({ role: "custom", content: "任务完成", details: { deliveryId: "task:turn:completion" } }), ["task:turn:completion"]);
});

test("恢复原生 user 和 toolResult 消费证据，未找到证据的已提交消息标为待核实", async () => {
  const taskId = task();
  const child = nativeSession(taskId.runId, "child-session");
  const input = await recordMessage(taskId, "to-child", "补充要求");
  const answer = await recordMessage(taskId, "to-child", "选择 JSON");
  const lost = await recordMessage(taskId, "to-child", "发送后进程退出");
  const notSubmitted = await recordMessage(taskId, "to-child", "等待接收入口");
  const quoted = await recordMessage(taskId, "to-child", "只被 assistant 引用");
  await submitMessages(taskId.runId, [input.id, answer.id, lost.id, quoted.id]);
  child.appendMessage({ role: "user", content: [{ type: "text", text: addressedMessage(input.id, input.text) }], timestamp: Date.now() });
  child.appendMessage({ role: "toolResult", toolCallId: "question-call", toolName: "SendMessage", content: [{ type: "text", text: `主 Agent 回答：\n${addressedMessage(answer.id, answer.text)}` }], isError: false, timestamp: Date.now() });
  child.appendMessage(fauxAssistantMessage(addressedMessage(quoted.id, "我提到了这个编号")));
  await fs.appendFile(child.getSessionFile()!, '\n{"type":"message","message":');
  const run = { ...taskId, childSessionPath: child.getSessionFile()! } as PersistedRun;
  await reconcileMessages(run, "to-child");
  const records = new Map((await readMessages(taskId.runId)).map(record => [record.id, record]));
  assert.equal(records.get(input.id)?.state, "consumed");
  assert.equal(records.get(answer.id)?.state, "consumed");
  for (const id of [lost.id, quoted.id]) {
    assert.equal(records.get(id)?.state, "unknown");
    assert.match(records.get(id)?.reason ?? "", /未找到消费证据/);
  }
  assert.equal(records.get(notSubmitted.id)?.state, "pending");
  assert.equal(records.get(notSubmitted.id)?.submittedAt, undefined);
});

test("恢复父会话原生 custom_message 消费结果和进度，按消息方向核对", async () => {
  const taskId = task();
  const parent = nativeSession(taskId.runId, "parent-session");
  const completion = await recordMessage(taskId, "to-parent", "完整结果", `${taskId.runId}:turn-1:completed`);
  const progress = await recordMessage(taskId, "to-parent", "正在验证");
  const wrongDirection = await recordMessage(taskId, "to-child", "另一个方向的消息");
  await submitMessages(taskId.runId, [completion.id, progress.id, wrongDirection.id]);
  parent.appendCustomMessageEntry("agent-task-result", "任务结果", true, { deliveryId: completion.id });
  parent.appendCustomMessageEntry("agent-parent-message", "子 agent 进度", true, { messageId: progress.id });
  parent.appendCustomMessageEntry("unrelated", addressedMessage(wrongDirection.id, "引用另一个方向"), true);
  await reconcileMessages({ ...taskId, parentSessionPath: parent.getSessionFile()! } as PersistedRun, "to-parent");
  const records = new Map((await readMessages(taskId.runId)).map(record => [record.id, record]));
  assert.equal(records.get(completion.id)?.state, "consumed");
  assert.equal(records.get(progress.id)?.state, "consumed");
  assert.equal(records.get(wrongDirection.id)?.state, "pending");
});

test("无原会话时保留不确定性，明确关闭不降级已经消费的消息", async () => {
  const taskId = task();
  const submitted = await recordMessage(taskId, "to-child", "投递过的消息");
  const pending = await recordMessage(taskId, "to-child", "尚未投递");
  const consumed = await recordMessage(taskId, "to-child", "已消费消息");
  await submitMessages(taskId.runId, [submitted.id, consumed.id]);
  await consumeMessages(taskId.runId, "to-child", [consumed.id]);
  await reconcileMessages({ ...taskId, childSessionPath: path.join(runDirectory(taskId.runId), "missing.jsonl") } as PersistedRun, "to-child");
  assert.deepEqual((await readMessages(taskId.runId)).map(record => record.state), ["unknown", "pending", "consumed"]);
  await settleMessages(taskId.runId, "to-child", "closed", "用户停止任务");
  const records = await readMessages(taskId.runId);
  assert.deepEqual(records.map(record => record.state), ["closed", "closed", "consumed"]);
  assert.equal(records.find(record => record.id === pending.id)?.reason, "用户停止任务");
  assert.equal(records.find(record => record.id === consumed.id)?.reason, undefined);
});

test("损坏或格式错误的账本明确报错，新增或状态更新均不覆盖原文件", async () => {
  for (const damaged of ['{"interrupted":', '{"id":"not-an-array"}', '[{"id":"one","text":"x","direction":"wrong","state":"pending"}]']) {
    const run = task();
    const file = messagesPath(run.runId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, damaged);
    await assert.rejects(readMessages(run.runId));
    await assert.rejects(recordMessage(run, "to-child", "新消息"));
    await assert.rejects(submitMessages(run.runId, ["one"]));
    await assert.rejects(consumeMessages(run.runId, "to-child", ["one"]));
    assert.equal(await fs.readFile(file, "utf8"), damaged);
  }
});

test("同任务并发追加和状态更新不丢失消息，也不倒退其他消息状态", async () => {
  const run = task();
  const messages = await Promise.all(Array.from({ length: 24 }, async (_, index) => {
    const record = await recordMessage(run, index % 2 ? "to-parent" : "to-child", `消息 ${index}`);
    await submitMessages(run.runId, [record.id]);
    await consumeMessages(run.runId, record.direction, [record.id]);
    return record;
  }));
  const records = await readMessages(run.runId);
  assert.equal(records.length, 24);
  assert.equal(new Set(records.map(record => record.id)).size, 24);
  assert.deepEqual(new Set(records.map(record => record.id)), new Set(messages.map(record => record.id)));
  assert.ok(records.every(record => record.state === "consumed" && record.submittedAt));
});

test("停止后才找到原生消费证据，可以纠正保守的关闭状态", async () => {
  const run = task();
  const record = await recordMessage(run, "to-child", "退出前已接收");
  await submitMessages(run.runId, [record.id]);
  await settleMessages(run.runId, "to-child", "closed", "停止时未收到消费事件");
  const file = path.join(runDirectory(run.runId), "session.jsonl");
  await fs.writeFile(file, JSON.stringify({ type: "message", message: { role: "user", content: addressedMessage(record.id, record.text) } }) + "\n");
  await reconcileMessages({ ...run, childSessionPath: file } as PersistedRun, "to-child");
  assert.equal((await readMessages(run.runId))[0].state, "consumed");
});
