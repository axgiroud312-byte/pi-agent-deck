import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { persistCompletion, readCompletions } from "../src/persistence.mjs";
import { resultMessage } from "../src/delivery.ts";
import type { PersistedRun } from "../src/types.ts";

function completed(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    version: 3, runId: "artifact-task", turnId: "turn-1", roleId: "worker", agentName: "实施", agentSource: "内置",
    parentSessionId: "parent", childSessionId: "child", childSessionPath: "child.jsonl", cwd: process.cwd(),
    objective: "检查完整交付", instruction: "检查完整交付", status: "已完成", model: "fixture/model", thinking: "off",
    deliveryMode: "background", startedAt: 1, endedAt: 2, updatedAt: 2, events: [], finalText: "完整交付",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}

async function fixture(t: { after: (fn: () => Promise<unknown>) => void }): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-deck-artifacts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function resultPath(directory: string, run: PersistedRun): string {
  const id = `${run.runId}:${run.turnId ?? run.attemptStartedAt ?? run.startedAt}`;
  return path.join(directory, "results", `${createHash("sha256").update(id).digest("hex")}.json`);
}

test("完整报告原文保存长文本尾部，通知截断预览后仍带绝对文件路径", async (t) => {
  const directory = await fixture(t);
  const run = completed({ finalText: "正文\n".repeat(10000) + "最后修正：TAIL_EVIDENCE" });
  await persistCompletion(directory, run);
  assert.ok(run.reportPath && path.isAbsolute(run.reportPath));
  assert.equal(run.reportPath, resultPath(directory, run).replace(/\.json$/, ".md"));
  const report = await fs.readFile(run.reportPath, "utf8");
  assert.ok(report.includes(run.finalText!));
  assert.match(report, /最后修正：TAIL_EVIDENCE\n$/);
  const notice = resultMessage(run, "parent")!;
  assert.ok(notice.content.length < 26000);
  assert.ok(notice.content.endsWith(`完整结果文件：${run.reportPath}`));
  assert.equal(notice.details.reportPath, run.reportPath);
  assert.match(notice.details.evidence, /TAIL_EVIDENCE$/);
  assert.equal((await readCompletions(directory))[0].reportPath, run.reportPath);
});

test("短报告通知也含路径，同任务续接的新轮次保留两份独立报告", async (t) => {
  const directory = await fixture(t);
  const first = completed({ finalText: "第一轮验收" });
  await persistCompletion(directory, first);
  const firstReport = await fs.readFile(first.reportPath!, "utf8");
  const next = completed({ turnId: "turn-2", finalText: "第二轮修正", endedAt: 3, reportPath: first.reportPath });
  await persistCompletion(directory, next);
  assert.notEqual(next.reportPath, first.reportPath);
  assert.equal(await fs.readFile(first.reportPath!, "utf8"), firstReport);
  assert.match(await fs.readFile(next.reportPath!, "utf8"), /第二轮修正/);
  assert.equal((await readCompletions(directory)).length, 2);
  assert.ok(resultMessage(next, "parent")!.content.includes(`完整结果文件：${next.reportPath}`));
  const repeat = { ...first, finalText: "之后变化的内存文本", reportPath: undefined };
  await persistCompletion(directory, repeat);
  assert.equal(repeat.reportPath, first.reportPath);
  assert.equal(await fs.readFile(first.reportPath!, "utf8"), firstReport, "已保存的同轮报告不因重复持久化变化");
});

test("失败报告保存完整失败原因、持久化原因和已完成的交付文本", async (t) => {
  const directory = await fixture(t);
  const run = completed({ status: "失败", failureReason: "失败原因\n".repeat(7000) + "TAIL_FAILURE", persistenceError: "之前的状态写入失败", finalText: "已验证的部分结果" });
  await persistCompletion(directory, run);
  const report = await fs.readFile(run.reportPath!, "utf8");
  for (const text of ["运行状态：失败", "TAIL_FAILURE", "之前的状态写入失败", "已验证的部分结果"]) assert.ok(report.includes(text));
});

test("报告保存失败时不保存结果快照或发布旧轮次路径", async (t) => {
  const directory = await fixture(t);
  const run = completed({ reportPath: path.join(directory, "previous-turn.md") });
  const file = resultPath(directory, run);
  await fs.mkdir(file.replace(/\.json$/, ".md"), { recursive: true });
  await assert.rejects(persistCompletion(directory, run));
  assert.equal(run.reportPath, undefined);
  await assert.rejects(fs.access(file));
  assert.equal(resultMessage(run, "parent")!.details.reportPath, undefined);
  assert.doesNotMatch(resultMessage(run, "parent")!.content, /完整结果文件：/);
  assert.ok((await fs.readdir(path.dirname(file))).every((name) => !name.endsWith(".tmp")));
});

test("结果 JSON 保存失败时已写的报告不被宣称为已持久化交付", async (t) => {
  const directory = await fixture(t);
  const run = completed();
  const file = resultPath(directory, run);
  await fs.mkdir(file, { recursive: true });
  await assert.rejects(persistCompletion(directory, run, { overwrite: true }));
  assert.equal(run.reportPath, undefined);
  assert.match(await fs.readFile(file.replace(/\.json$/, ".md"), "utf8"), /完整交付/);
  assert.equal(resultMessage(run, "parent")!.details.reportPath, undefined);
});

test("旧 JSON 结果可以读取，显式持久化补齐报告时使用历史原文", async (t) => {
  const directory = await fixture(t);
  const run = completed({ finalText: "历史原文" });
  const file = resultPath(directory, run);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(run));
  assert.equal((await readCompletions(directory))[0].reportPath, undefined);
  run.finalText = "后来的内存文本";
  await persistCompletion(directory, run);
  const report = await fs.readFile(run.reportPath!, "utf8");
  assert.match(report, /历史原文/);
  assert.doesNotMatch(report, /后来的内存文本/);
  assert.equal((await readCompletions(directory))[0].reportPath, run.reportPath);
});
