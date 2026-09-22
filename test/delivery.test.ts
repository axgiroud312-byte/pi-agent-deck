import assert from "node:assert/strict";
import test from "node:test";
import { resultMessage } from "../src/delivery.ts";
import agentDeck from "../src/index.ts";
import { initializeRun } from "../src/runtime.ts";

const run: any = { version: 1, runId: "test-delivery", autoDeliver: true, parentSessionId: "parent", agentName: "调查", objective: "检查登录", status: "已完成", startedAt: 1, endedAt: 2, reports: [], events: [], finalText: "找到原因" };

test("结果只交给所属会话；已排队和持久化回执防止重复；新一轮可交付", () => {
  const message = resultMessage(run, "parent", new Set(), new Set())!;
  assert.match(message.content, /找到原因/);
  const receipt = new Set([message.details.deliveryId]);
  assert.equal(resultMessage(run, "other", new Set(), new Set()), undefined);
  assert.equal(resultMessage(run, "parent", receipt, new Set()), undefined);
  assert.equal(resultMessage(run, "parent", new Set(), receipt), undefined);
  assert.ok(resultMessage({ ...run, attemptStartedAt: 3, endedAt: 4 }, "parent", receipt, new Set()));
  assert.equal(resultMessage({ ...run, autoDeliver: false }, "parent", new Set(), new Set()), undefined);
});

test("真实扩展启动补送结果，重载后按会话回执去重，拒绝跨会话继续", async () => {
  await initializeRun(run, { version: 1, cwd: process.cwd(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true);
  const entries: any[] = [];
  const messages: any[] = [];
  for (let reload = 0; reload < 2; reload++) {
    const handlers = new Map<string, any>();
    const tools = new Map<string, any>();
    const ctx: any = { sessionManager: { getSessionId: () => "parent", getBranch: () => entries }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
    agentDeck({
      on: (name: string, fn: any) => handlers.set(name, fn), registerTool: (tool: any) => tools.set(tool.name, tool),
      registerCommand() {}, registerMessageRenderer() {}, getActiveTools: () => [...tools.keys()], setActiveTools() {},
      sendMessage: (message: any, options: any) => { messages.push({ message, options }); entries.push({ type: "custom_message", ...message }); },
    } as any);
    try {
      await handlers.get("session_start")({}, ctx);
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0].options, { deliverAs: "followUp", triggerTurn: true });
      const other = { ...ctx, sessionManager: { getSessionId: () => "other" } };
      await assert.rejects(tools.get("SendMessage").execute("id", { to: run.runId, message: "继续" }, undefined, undefined, other), /当前会话/);
      await assert.rejects(tools.get("TaskStop").execute("id", { task_id: run.runId }, undefined, undefined, other), /当前会话/);
    } finally { handlers.get("session_shutdown")(); }
  }
});
