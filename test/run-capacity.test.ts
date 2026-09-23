import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { activeRunCount } from "../src/run-capacity.ts";
import { initializeRun, readRun, runDirectory, sendToRun, shutdownRuns, stopRun, launchRunner } from "../src/runtime.ts";

function fixture(parent: string, status = "运行中") {
  const id = `capacity-${randomUUID()}`;
  const cwd = getAgentDir();
  const details: any = { version: 1, runId: id, agentId: "fixture", agentName: "fixture", agentSource: "内置", objective: "fixture", instruction: "fixture",
    acceptanceCriteria: [], status, model: "fake/model", thinking: "off", tools: [], writePermission: false, parentSessionId: parent,
    childSessionId: id, childSessionPath: path.join(cwd, `${id}.jsonl`), cwd, startedAt: Date.now(), reports: [], events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  const request: any = { version: 1, cwd, command: "missing-deck-executable", argsPrefix: [], prompt: "fixture", naturalOutput: true };
  return { details, request, id };
}

test("并发创建原子占位 8；第 9 个不创建记录；父会话隔离；停止释放", async (t) => {
  const parent = randomUUID(), other = randomUUID();
  t.after(async () => { await shutdownRuns(parent); await shutdownRuns(other); });
  const runs = Array.from({ length: 9 }, () => fixture(parent));
  const result = await Promise.allSettled(runs.map(({ details, request }) => initializeRun(details, request, true)));
  assert.equal(result.filter((item) => item.status === "fulfilled").length, 8);
  assert.equal(activeRunCount(parent), 8);
  assert.match(String((result[8] as PromiseRejectedResult).reason), /8\/8.*未排队/);
  assert.equal(await readRun(runs[8].id), undefined);
  await assert.rejects(fs.access(runDirectory(runs[8].id)));
  const foreign = fixture(other);
  await initializeRun(foreign.details, foreign.request, true);
  assert.equal(activeRunCount(other), 1);
  const originalTurn = (await readRun(runs[0].id))?.turnId;
  await sendToRun(runs[0].id, "创建中补充", undefined, undefined, "QueueOnly");
  assert.equal((await readRun(runs[0].id))?.turnId, originalTurn);
  assert.equal(activeRunCount(parent), 8);
  await stopRun(runs[0].id);
  assert.equal(activeRunCount(parent), 7);
  await initializeRun(runs[8].details, runs[8].request, true);
  assert.equal(activeRunCount(parent), 8);
});

test("空闲 QueueOnly 不占位；TriggerTurn 满额拒绝且保留邮箱；清理不重放", async (t) => {
  const parent = randomUUID();
  t.after(() => shutdownRuns(parent));
  const idle = fixture(parent, "已完成");
  await initializeRun(idle.details, idle.request, true);
  const holders = Array.from({ length: 8 }, () => fixture(parent, "等待决定"));
  await Promise.all(holders.map(({ details, request }) => initializeRun(details, request, true)));
  assert.equal((await sendToRun(idle.id, "仅供参考", undefined, undefined, "QueueOnly")).delivery, "deferred");
  await assert.rejects(sendToRun(idle.id, "继续"), /8\/8/);
  assert.equal((await readRun(idle.id))?.queuedMessageCount, 1);
  assert.equal((await readRun(idle.id))?.status, "已完成");
  await stopRun(idle.id);
  assert.equal((await readRun(idle.id))?.queuedMessageCount, 0);
  assert.equal(activeRunCount(parent), 8);
});

test("初始化写入失败及子进程启动失败都释放占位", async (t) => {
  const parent = randomUUID();
  t.after(() => shutdownRuns(parent));
  const broken = fixture(parent);
  await fs.mkdir(runDirectory(broken.id), { recursive: true });
  await fs.mkdir(path.join(runDirectory(broken.id), "request.json"));
  await assert.rejects(initializeRun(broken.details, broken.request, true));
  assert.equal(activeRunCount(parent), 0);
  const missing = fixture(parent);
  await initializeRun(missing.details, missing.request, true);
  await launchRunner(missing.id);
  for (let i = 0; i < 200 && activeRunCount(parent); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(activeRunCount(parent), 0);
  assert.equal((await readRun(missing.id))?.status, "失败");
  assert.equal((await readRun(missing.id))?.resourceState, "released");
});
