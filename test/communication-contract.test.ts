import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import childRuntime from "../src/child-runtime.ts";
import { initializeRun, runDirectory } from "../src/runtime.ts";
import { parseMessageInput, publicTaskResult } from "../src/tool-contract.ts";
import { showAgentPanel } from "../src/ui.ts";

test("SendMessage retains existing fields and parses an optional question reply ID", () => {
  assert.deepEqual(parseMessageInput({ to: "worker", message: "补充说明" }), {
    to: "worker", message: "补充说明", summary: "补充说明", replyTo: undefined,
  });
  assert.deepEqual(parseMessageInput({ to: "worker", message: "保持兼容", summary: "决定", reply_to: "question-1" }), {
    to: "worker", message: "保持兼容", summary: "决定", replyTo: "question-1",
  });
  assert.throws(() => parseMessageInput({ to: "worker", message: "答复", reply_to: "  " }), /reply_to/);
});

function childTools(): Map<string, any> {
  const tools = new Map<string, any>();
  childRuntime({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  return tools;
}

test("agent_question waits for native UI reply inside the same tool call", async () => {
  const tool = childTools().get("agent_question");
  const controller = new AbortController();
  let respond!: (value: string) => void;
  const answer = new Promise<string>((resolve) => { respond = resolve; });
  let inputArgs: any[] = [];
  const execution = tool.execute("call-1", { question: "是否保持兼容？", options: ["保持", "移除"] }, controller.signal, () => {}, {
    ui: { input: (...args: any[]) => { inputArgs = args; return answer; } },
  });
  let settled = false;
  void execution.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(inputArgs[0], "是否保持兼容？");
  assert.match(inputArgs[1], /1\. 保持/);
  assert.equal(inputArgs[2].signal, controller.signal);
  respond("保持兼容");
  const result = await execution;
  assert.match(result.content[0].text, /主 Agent 的答复：保持兼容/);
  assert.equal(result.terminate, undefined);
});

test("blocking agent_report waits for an answer while nonblocking reports remain immediate", async () => {
  const tool = childTools().get("agent_report");
  const controller = new AbortController();
  let requested = 0;
  const ctx = { ui: { input: async () => { requested++; return "采用方案二"; } } };
  const base = { type: "问题", title: "需要选择", summary: "方案如何选？", question: "方案如何选？", options: ["一", "二"] };
  const blocked = await tool.execute("call-2", { ...base, blocking: true }, controller.signal, () => {}, ctx);
  assert.equal(requested, 1);
  assert.match(blocked.content[0].text, /采用方案二/);
  assert.equal(blocked.terminate, undefined);
  const progress = await tool.execute("call-3", { type: "进度", title: "调查中", summary: "继续检查", blocking: false }, controller.signal, () => {}, ctx);
  assert.equal(requested, 1);
  assert.equal(progress.terminate, false);
});

test("aborting a waiting question rejects rather than inventing an answer", async () => {
  const tool = childTools().get("agent_question");
  const controller = new AbortController();
  const execution = tool.execute("call-4", { question: "要继续吗？" }, controller.signal, () => {}, {
    ui: { input: (_question: string, _choices: string, options: { signal: AbortSignal }) => new Promise<undefined>((resolve) => {
      options.signal.addEventListener("abort", () => resolve(undefined), { once: true });
    }) },
  });
  controller.abort(new Error("任务已停止"));
  await assert.rejects(execution, /任务已停止/);
});

test("panel separates answering, stopping and ordinary continuation; public result includes pending question", async () => {
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
      assert.match(component.render(100).join("\n"), /A 回答问题/);
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
  assert.deepEqual(actions, [
    { action: "回答问题", runId, questionId: "question-1" },
    { action: "继续", runId },
    { action: "仅发信息", runId },
    { action: "停止", runId },
  ]);
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
