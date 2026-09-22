import assert from "node:assert/strict";
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeRun, readRun, runDirectory, statusPath, writeJsonAtomic } from "../src/runtime.ts";
import { waitForRunGroup } from "../src/wait-policy.ts";

function details(runId: string, status: "运行中" | "等待决定"): any {
  return {
    version: 1,
    runId,
    agentId: "wait-test",
    agentName: `等待测试 ${runId}`,
    agentSource: "内置",
    objective: "验证批次等待策略",
    instruction: "测试",
    acceptanceCriteria: ["返回 attention"],
    status,
    model: "test/model",
    thinking: "off",
    tools: [],
    writePermission: false,
    parentSessionId: "wait-parent",
    childSessionId: randomUUID(),
    childSessionPath: "wait.jsonl",
    cwd: process.cwd(),
    startedAt: Date.now(),
    reports: [],
    events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

async function create(runId: string, status: "运行中" | "等待决定") {
  const run = await initializeRun(details(runId, status), {
    version: 1,
    cwd: process.cwd(),
    command: process.execPath,
    argsPrefix: [],
    prompt: "测试",
  }, true);
  if (status !== "运行中") await writeJsonAtomic(statusPath(runId), { ...run, status, updatedAt: Date.now() });
  return (await readRun(runId))!;
}

test("一个运行等待决定时不会被长跑兄弟扣住", async (t) => {
  const runningId = `test-wait-running-${randomUUID()}`;
  const attentionId = `test-wait-attention-${randomUUID()}`;
  t.after(() => {
    fs.rmSync(runDirectory(runningId), { recursive: true, force: true });
    fs.rmSync(runDirectory(attentionId), { recursive: true, force: true });
  });
  const running = await create(runningId, "运行中");
  const attention = await create(attentionId, "等待决定");
  const started = Date.now();
  const result = await waitForRunGroup([running, attention], { timeoutMs: 5000, pollMs: 10 });
  assert.equal(result.reason, "attention");
  assert.ok(Date.now() - started < 1000);
  assert.equal(result.runs.find((run) => run.runId === runningId)?.status, "运行中");
});

test("取消批次等待不会修改运行状态", async (t) => {
  const runId = `test-wait-group-abort-${randomUUID()}`;
  t.after(() => fs.rmSync(runDirectory(runId), { recursive: true, force: true }));
  const run = await create(runId, "运行中");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForRunGroup([run], { signal: controller.signal }), /仍在运行/);
  assert.equal((await readRun(runId))?.status, "运行中");
});
