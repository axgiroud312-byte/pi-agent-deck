import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  initializeRun,
  launchRunner,
  readRun,
  runDirectory,
  sendToRun,
  shutdownRuns,
  stopRun,
  waitForRun,
  writeJsonAtomic,
} from "../src/runtime.ts";
import { writerLeasePath } from "../src/admission.ts";

function details(runId: string, cwd: string, overrides: Record<string, unknown> = {}): any {
  return {
    version: 1,
    runId,
    agentId: "windows-test",
    agentName: "Windows 测试 Agent",
    agentSource: "内置",
    objective: "验证主 Pi 直接管理子进程",
    instruction: "测试",
    acceptanceCriteria: [],
    status: "运行中",
    model: "test/model",
    thinking: "off",
    tools: [],
    writePermission: false,
    cwd,
    parentSessionId: `parent-${runId}`,
    childSessionId: randomUUID(),
    childSessionPath: path.join(cwd, "child.jsonl"),
    startedAt: Date.now(),
    reports: [],
    events: [],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...overrides,
  };
}

async function until<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待${label}超时`);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function rpcFixture(t: any, prompt = "HOLD"): Promise<{ runId: string; cwd: string; parentSessionId: string }> {
  const runId = `test-runtime-${randomUUID()}`;
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-runtime-"));
  const script = path.join(cwd, "fake-rpc-child.mjs");
  await fs.promises.writeFile(script, `
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") return send({ type: "response", id: request.id, command: request.type, success: true, data: { isStreaming: false } });
  if (request.type === "set_steering_mode" || request.type === "clear_queue" || request.type === "abort") return send({ type: "response", id: request.id, command: request.type, success: true, data: {} });
  if (request.type === "prompt") {
    turn += 1;
    send({ type: "response", id: request.id, command: request.type, success: true, data: {} });
    if (String(request.message).includes("HOLD")) return;
    setTimeout(() => {
      send({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "TURN_" + turn + ":" + request.message }] } });
      send({ type: "agent_settled" });
    }, 30);
  }
});
lines.on("close", () => process.exit(0));
`, "utf8");
  const run = details(runId, cwd);
  await initializeRun(run, {
    version: 1,
    cwd,
    command: process.execPath,
    argsPrefix: [script],
    prompt,
    naturalOutput: true,
  }, true);
  t.after(async () => {
    await shutdownRuns(run.parentSessionId);
    await fs.promises.rm(runDirectory(runId), { recursive: true, force: true });
    await fs.promises.rm(cwd, { recursive: true, force: true });
  });
  return { runId, cwd, parentSessionId: run.parentSessionId };
}

test("取消等待不会停止主 Pi 持有的后台子进程", async (t) => {
  const fixture = await rpcFixture(t);
  await launchRunner(fixture.runId);
  const active = await until(async () => {
    const run = await readRun(fixture.runId);
    return run?.childPid && alive(run.childPid) ? run : undefined;
  }, "子进程启动");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(waitForRun(fixture.runId, { signal: controller.signal }), /仍在后台运行/);
  assert.equal((await readRun(fixture.runId))?.status, "运行中");
  assert.equal(alive(active.childPid), true);
});

test("停止任务会结束实际子进程并保留任务记录", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = await rpcFixture(t);
  await launchRunner(fixture.runId);
  const active = await until(async () => {
    const run = await readRun(fixture.runId);
    return run?.childPid && alive(run.childPid) ? run : undefined;
  }, "子进程启动");
  const childPid = active.childPid;
  const stopped = await stopRun(fixture.runId);
  assert.equal(stopped.status, "已停止");
  await until(async () => alive(childPid) ? undefined : true, "子进程停止");
  assert.equal(fs.existsSync(path.join(runDirectory(fixture.runId), "request.json")), true);
  assert.equal(fs.existsSync(path.join(runDirectory(fixture.runId), "status.json")), true);
});

test("旧任务 request 损坏时不会先占用 writer lease", async (t) => {
  const runId = `test-corrupt-request-${randomUUID()}`;
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-corrupt-request-"));
  const directory = runDirectory(runId);
  await fs.promises.mkdir(directory, { recursive: true });
  await writeJsonAtomic(path.join(directory, "status.json"), details(runId, cwd, {
    writePermission: true,
    status: "等待决定",
    ownerPid: undefined,
    childPid: undefined,
    runnerPid: undefined,
    updatedAt: Date.now(),
  }));
  await fs.promises.writeFile(path.join(directory, "request.json"), "{broken", "utf8");
  t.after(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
    await fs.promises.rm(writerLeasePath(cwd), { recursive: true, force: true });
    await fs.promises.rm(cwd, { recursive: true, force: true });
  });

  await assert.rejects(sendToRun(runId, "继续"), /JSON|Unexpected|position|property/i);
  assert.equal(fs.existsSync(writerLeasePath(cwd)), false);
});

test("每轮只公开当前 turn 的结果并复用同一个子会话", async (t) => {
  const fixture = await rpcFixture(t, "FIRST");
  await launchRunner(fixture.runId);
  const first = await until(async () => {
    const run = await readRun(fixture.runId);
    return run?.status === "已完成" ? run : undefined;
  }, "第一轮完成");
  assert.match(first.finalText ?? "", /^TURN_1:FIRST$/);
  const firstTurn = first.turnId;
  const firstSession = first.childSessionId;
  const childPid = first.childPid;
  assert.equal(alive(childPid), true, "单轮完成后子 Pi 应继续等待下一轮输入");

  const resumed = await sendToRun(fixture.runId, "SECOND");
  assert.equal(resumed.delivery, "resumed");
  assert.notEqual(resumed.run.turnId, firstTurn);
  assert.equal(resumed.run.finalText, undefined);
  assert.deepEqual(resumed.run.reports, []);
  const second = await until(async () => {
    const run = await readRun(fixture.runId);
    return run?.status === "已完成" && run.turnId !== firstTurn ? run : undefined;
  }, "第二轮完成");
  assert.match(second.finalText ?? "", /^TURN_2:SECOND$/);
  assert.equal(second.childSessionId, firstSession);
  assert.equal(second.childPid, childPid);
});
