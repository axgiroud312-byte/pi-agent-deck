import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  initializeRun,
  continueRun,
  launchRunner,
  readRun,
  reconcileRun,
  runDirectory,
  stopRun,
  waitForRun,
} from "../src/runtime.ts";
import { acquireWriterLease, writerLeasePath } from "../src/admission.ts";

function details(runId: string): any {
  return {
    version: 1,
    runId,
    agentId: "windows-test",
    agentName: "Windows 测试 Agent",
    agentSource: "内置",
    objective: "验证进程树停止",
    instruction: "测试",
    status: "运行中",
    model: "test/model",
    thinking: "off",
    tools: [],
    writePermission: false,
    parentSessionId: "test-parent",
    childSessionId: randomUUID(),
    childSessionPath: "test.jsonl",
    startedAt: Date.now(),
    reports: [],
    events: [],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function waitForPid(runId: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const run = await readRun(runId);
    if (run?.runnerPid && run?.childPid) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("等待 Runner PID 超时");
}

test("活动记录没有存活进程时收敛为失联", async (t) => {
  const runId = `test-reconcile-${randomUUID()}`;
  t.after(() => fs.rmSync(runDirectory(runId), { recursive: true, force: true }));
  await initializeRun({ ...details(runId), startedAt: Date.now() - 30_000 }, {
    version: 1,
    cwd: process.cwd(),
    command: process.execPath,
    argsPrefix: ["-e", "process.exit(0)"],
    prompt: "测试",
  }, true);
  const reconciled = await reconcileRun(runId);
  assert.equal(reconciled?.status, "失联");
  assert.ok(reconciled?.events.some((event) => event.text.includes("未发现对应")));
});

test("取消等待不会停止后台 Agent", async (t) => {
  const runId = `test-wait-abort-${randomUUID()}`;
  t.after(() => fs.rmSync(runDirectory(runId), { recursive: true, force: true }));
  await initializeRun(details(runId), {
    version: 1,
    cwd: process.cwd(),
    command: process.execPath,
    argsPrefix: ["-e", "setInterval(() => {}, 1000)"],
    prompt: "测试",
  }, true);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForRun(runId, { signal: controller.signal }), /仍在后台运行/);
  assert.equal((await readRun(runId))?.status, "运行中");
});

test("缺少进程身份时停止写 Agent 不会释放活跃租约", async (t) => {
  const runId = `test-stop-unconfirmed-${randomUUID()}`;
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-stop-unconfirmed-"));
  const admission = await acquireWriterLease(cwd, runId);
  assert.equal(admission.acquired, true);
  if (!admission.acquired) return;
  const runDetails = { ...details(runId), cwd, writePermission: true, writerLease: admission.lease };
  t.after(() => {
    fs.rmSync(runDirectory(runId), { recursive: true, force: true });
    fs.rmSync(writerLeasePath(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  await initializeRun(runDetails, {
    version: 1,
    cwd,
    command: process.execPath,
    argsPrefix: ["-e", "process.exit(0)"],
    prompt: "测试",
    writerLease: admission.lease,
  }, true);
  const stopped = await stopRun(runId);
  assert.equal(stopped.status, "停止未确认");
  assert.equal(fs.existsSync(admission.lease.leasePath), true);
});

test("continue 读取损坏 request 失败时不会占用 writer lease", async (t) => {
  const runId = `test-continue-corrupt-${randomUUID()}`;
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-continue-corrupt-"));
  const runDetails = { ...details(runId), cwd, writePermission: true, status: "等待决定" };
  t.after(() => {
    fs.rmSync(runDirectory(runId), { recursive: true, force: true });
    fs.rmSync(writerLeasePath(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  await initializeRun(runDetails, {
    version: 1,
    cwd,
    command: process.execPath,
    argsPrefix: [],
    prompt: "测试",
  }, true);
  await fs.promises.writeFile(path.join(runDirectory(runId), "request.json"), "{broken", "utf8");
  await assert.rejects(continueRun(runId, "继续"));
  assert.equal(fs.existsSync(writerLeasePath(cwd)), false);
});

test("停止 Runner 会保留产物并收敛为已停止", { skip: process.platform !== "win32" }, async (t) => {
  const runId = `test-stop-${randomUUID()}`;
  const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-stop-"));
  const fake = path.join(temp, "long-child.mjs");
  await fs.promises.writeFile(fake, "setInterval(() => {}, 1000);", "utf8");
  t.after(() => {
    fs.rmSync(runDirectory(runId), { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  });
  await initializeRun(details(runId), {
    version: 1,
    cwd: temp,
    command: process.execPath,
    argsPrefix: [fake],
    prompt: "测试",
  }, true);
  await launchRunner(runId);
  const active = await waitForPid(runId);
  assert.equal(active.status, "运行中");
  const stopped = await stopRun(runId);
  assert.equal(stopped.status, "已停止");
  assert.equal(fs.existsSync(path.join(runDirectory(runId), "request.json")), true);
  assert.equal(fs.existsSync(path.join(runDirectory(runId), "status.json")), true);
});
