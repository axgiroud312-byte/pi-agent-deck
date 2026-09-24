import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import childRuntime from "../src/child-runtime.ts";
import { initializeRun, runDirectory } from "../src/runtime.ts";
import { parseAgentInput, parseMessageInput, publicTaskResult } from "../src/tool-contract.ts";
import { showAgentPanel } from "../src/ui.ts";

test("消息参数只保留收件任务、正文与摘要；旧问答参数明确拒绝", () => {
  assert.deepEqual(parseMessageInput({ to: "worker", message: "补充说明" }), { to: "worker", message: "补充说明", summary: "补充说明" });
  assert.throws(() => parseMessageInput({ to: "worker", message: "答复", reply_to: "q" }), /不再接受/);
});

test("子 Agent 只提交最终报告，不注册问题工具或等待用户输入", async () => {
  const tools = new Map<string, any>();
  childRuntime({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  assert.deepEqual([...tools.keys()], ["agent_report"]);
  const report = { outcome: "阻塞", summary: "缺少业务决定", completed: [], evidence: [], checks: [], remaining: ["需要主 Agent 决策"] };
  const result = await tools.get("agent_report").execute("call", report);
  assert.equal(result.terminate, true);
  assert.deepEqual(result.details.taskResult, report);
});

test("只读面板保留旧问题记录，移除答复和续接输入，仅允许明确停止", async () => {
  const parent = randomUUID();
  const runId = `A-${randomUUID()}`;
  const run = await initializeRun({
    version: 1, runId, agentId: "worker", agentName: "工作 Agent", agentSource: "内置", objective: "检查兼容性", instruction: "检查兼容性",
    acceptanceCriteria: [], status: "等待决定", model: "fixture/model", thinking: "off", tools: [], writePermission: false,
    parentSessionId: parent, childSessionId: "child", childSessionPath: "child.jsonl", cwd: getAgentDir(), startedAt: Date.now(),
    reports: [], events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    pendingQuestion: { id: "question-1", turnId: "turn-1", question: "是否保持兼容？", options: ["保持", "移除"] },
  } as any, { version: 1, cwd: getAgentDir(), command: process.execPath, argsPrefix: [], prompt: "fixture" } as any, true);
  assert.deepEqual(publicTaskResult(run, "请回答").pendingQuestion, run.pendingQuestion);
  assert.equal("pendingQuestion" in publicTaskResult({ ...run, pendingQuestion: undefined }, "普通补充"), false);
  const actions: any[] = [];
  const theme: any = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value, bold: (value: string) => value };
  const ctx: any = { mode: "tui", sessionManager: { getSessionId: () => parent }, ui: { custom: async (factory: any) => {
    const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, (action: any) => actions.push(action));
    try {
      assert.doesNotMatch(component.render(100).join("\n"), /A 回答问题|C 继续|M 仅发信息/);
      assert.match(component.render(100).join("\n"), /X 停止/);
      component.handleInput("\r");
      assert.match(component.render(100).join("\n"), /是否保持兼容/);
      component.handleInput("a");
      component.handleInput("c");
      component.handleInput("m");
      component.handleInput("x");
    } finally { component.dispose(); }
    return { action: "关闭" };
  } } };
  await showAgentPanel(ctx);
  assert.deepEqual(actions, [{ action: "停止", runId }]);
});

test("answered question stays historical while current result and events remain visible", async () => {
  const parent = randomUUID();
  const runId = `A-${randomUUID()}`;
  const questionReport = {
    type: "问题", title: "需要决定", summary: "是否保持兼容？", question: "是否保持兼容？", blocking: true,
    acceptanceCriteria: [], evidence: [], completed: [], deliverables: [], filesRead: [], filesChanged: [], fileChanges: [],
    designDecisions: [], commands: [], tests: [], risks: [], unknowns: [], downstreamNotes: [], recommendations: [], options: ["保持", "移除"],
  };
  const run = await initializeRun({
    version: 1, runId, turnId: "turn-new", agentId: "worker", agentName: "工作 Agent", agentSource: "内置",
    objective: "检查兼容性", instruction: "检查兼容性", acceptanceCriteria: [], status: "已完成",
    model: "fixture/model", thinking: "off", tools: [], writePermission: false,
    parentSessionId: parent, childSessionId: "child", childSessionPath: "child.jsonl", cwd: getAgentDir(), startedAt: Date.now(),
    reports: [questionReport], finalText: "FINAL_RESULT_CURRENT_TURN", events: [{ at: Date.now(), kind: "状态", text: "CURRENT_TURN_EVENT" }],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  } as any, { version: 1, cwd: getAgentDir(), command: process.execPath, argsPrefix: [], prompt: "fixture" } as any, true);
  await fs.writeFile(path.join(runDirectory(runId), "events.jsonl"), `${JSON.stringify({ at: Date.now(), kind: "状态", text: "STALE_PREVIOUS_TURN_EVENT" })}\n`);
  const theme: any = { fg: (_name: string, value: string) => value, bg: (_name: string, value: string) => value, bold: (value: string) => value };
  const ctx: any = { mode: "tui", sessionManager: { getSessionId: () => parent }, ui: { custom: async (factory: any) => {
    const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, () => {});
    try {
      const result = component.renderReports(run, 100).join("\n");
      assert.match(result, /FINAL_RESULT_CURRENT_TURN/);
      assert.match(result, /已回答的问题/);
      assert.match(result, /是否保持兼容/);
      const transcript = component.renderTranscript(run, 100).join("\n");
      assert.match(transcript, /CURRENT_TURN_EVENT/);
      assert.doesNotMatch(transcript, /STALE_PREVIOUS_TURN_EVENT/);
    } finally { component.dispose(); }
    return { action: "关闭" };
  } } };
  await showAgentPanel(ctx);
});


test("resume 与创建参数互斥；续接只接收原任务和本轮要求", () => {
  assert.deepEqual(parseAgentInput({ resume: "A-original", prompt: "补齐检查" }), { resume: "A-original", prompt: "补齐检查", description: undefined });
  for (const field of ["model", "subagent_type", "name", "run_in_background"]) {
    assert.throws(() => parseAgentInput({ resume: "A-original", prompt: "检查", [field]: field === "run_in_background" ? true : "x" }), /不能同时指定/);
  }
  assert.throws(() => parseAgentInput({ prompt: "新建缺标题" }), /description/);
  assert.throws(() => parseAgentInput({ resume: "A-original", prompt: " " }), /prompt/);
});
