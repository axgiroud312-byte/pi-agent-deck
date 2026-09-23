import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as runtime from "../src/runtime.ts";

const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = path.join(path.dirname(piMain), "bundle", "cli.js");
const providerExtension = fileURLToPath(new URL("./fixtures/rpc-faux-provider.ts", import.meta.url));
const childExtension = fileURLToPath(new URL("../src/child-runtime.ts", import.meta.url));

async function until<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 ${label} 超时`);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function lines(file: string): Promise<any[]> {
  try { return (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function createRun(t: any, prompt: string) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-real-rpc-"));
  const runId = `rpc-integration-${randomUUID()}`;
  const parentSessionId = randomUUID();
  const childSessionId = randomUUID();
  const childManager = SessionManager.create(cwd, undefined, { id: childSessionId });
  childManager.appendSessionInfo(`real RPC fixture ${runId}`);
  const childSessionPath = childManager.getSessionFile();
  assert.ok(childSessionPath);
  const log = path.join(cwd, "provider.jsonl");
  const turnId = randomUUID();
  const startedAt = Date.now();
  const details: any = {
    version: 1, autoDeliver: true, runId, turnId,
    agentId: "scout", agentName: "local RPC fixture", agentSource: "内置",
    objective: prompt, instruction: prompt, acceptanceCriteria: [],
    status: "运行中", model: "deck-local-fixture/scripted", thinking: "off", tools: ["agent_question"],
    writePermission: false, parentSessionId, childSessionId, childSessionPath, cwd, startedAt,
    reports: [], events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const runDir = runtime.runDirectory(runId);
  await fs.mkdir(runDir, { recursive: true });
  await runtime.initializeRun(details, {
    version: 1, cwd, command: process.execPath,
    argsPrefix: [piCli, "--mode", "rpc", "--session", childSessionPath,
      "--model", details.model, "--thinking", details.thinking,
      "--no-extensions", "--extension", providerExtension, "--extension", childExtension,
      "--tools", "agent_question"],
    prompt, naturalOutput: true, timeoutMs: 0,
    env: {
      PI_AGENT_DECK_SIMPLE: "1", PI_AGENT_DECK_RUN_ID: runId,
      PI_AGENT_DECK_FIXTURE_LOG: log,
    },
  } as any, true);
  t.after(async () => {
    try { await runtime.stopRun(runId); } catch { /* already settled */ }
    const shutdown = (runtime as any).shutdownRuns;
    if (typeof shutdown === "function") await shutdown(parentSessionId);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });
  return { runId, parentSessionId, childSessionId, childSessionPath, cwd, log };
}

test("真实 Pi RPC：运行中 steer、原生提问等待、指定答复及原会话续跑", async (t) => {
  const fixture = await createRun(t, "DECK_QUESTION_CASE");
  const subscribe = (runtime as any).subscribeRunEvents;
  assert.equal(typeof subscribe, "function");
  const observed: any[] = [];
  const unsubscribe = subscribe((event: any) => observed.push(event));
  t.after(() => unsubscribe?.());

  await runtime.launchRunner(fixture.runId);
  await until(async () => (await runtime.readRun(fixture.runId))?.childPid || undefined, "真实 Pi 子进程启动");
  await until(async () => (await lines(fixture.log)).some((entry) => entry.type === "provider_call") ? true : undefined, "首个本地模型调用");
  const liveSteer = await runtime.sendToRun(fixture.runId, "DECK_EARLY_STEER");
  assert.equal(liveSteer.delivery, "queued");

  const waiting = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "等待决定" && run.pendingQuestion?.id ? run : undefined;
  }, "原生 extension_ui_request");
  assert.ok(waiting.pendingQuestion?.id);
  assert.ok(alive(waiting.childPid), "原生 UI 等待时子进程应保持存活");
  assert.ok(observed.some((event) => event.kind === "question" && event.run?.pendingQuestion?.id === waiting.pendingQuestion?.id));
  const questionId = waiting.pendingQuestion.id;

  assert.equal((await runtime.sendToRun(fixture.runId, "DECK_ORDINARY_STEER")).delivery, "queued");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const stillWaiting = (await runtime.readRun(fixture.runId))!;
  assert.equal(stillWaiting.status, "等待决定");
  assert.equal(stillWaiting.pendingQuestion?.id, questionId);
  assert.equal((await lines(fixture.log)).filter((item) => item.type === "provider_call").length, 1);

  await runtime.sendToRun(fixture.runId, "同意", undefined, questionId);
  const answered = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" ? run : undefined;
  }, "问题答复后完成");
  assert.match(answered.finalText ?? "", /DECK_ANSWER_DONE 同意/);
  assert.ok((await lines(fixture.log)).some((entry) => entry.type === "provider_call" && String(entry.transcript).includes("DECK_EARLY_STEER")));
  assert.equal(answered.childSessionId, fixture.childSessionId);
  assert.equal(answered.childSessionPath, fixture.childSessionPath);
  const firstTurn = answered.turnId;

  await runtime.sendToRun(fixture.runId, "DECK_CONTINUE_CASE");
  const continued = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.turnId !== firstTurn ? run : undefined;
  }, "原会话续跑");
  assert.match(continued.finalText ?? "", /DECK_CONTINUE_DONE/);
  assert.equal(continued.childSessionId, fixture.childSessionId);
  assert.equal(continued.childSessionPath, fixture.childSessionPath);
});

test("真实 Pi RPC：停止会中断本地模型并清空待发送消息", async (t) => {
  const fixture = await createRun(t, "DECK_STOP_CASE");
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await lines(fixture.log)).some((entry) => entry.type === "provider_call") ? true : undefined, "待中止的本地模型调用");
  await runtime.sendToRun(fixture.runId, "DECK_QUEUED_BEFORE_STOP");
  const stopped = await runtime.stopRun(fixture.runId);
  assert.ok(["已停止", "已取消"].includes(stopped.status));
  await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run && !alive(run.runnerPid) && !alive(run.childPid) ? run : undefined;
  }, "停止进程");
  const calls = (await lines(fixture.log)).filter((entry) => entry.type === "provider_call");
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((entry) => String(entry.transcript).includes("DECK_QUEUED_BEFORE_STOP")));
});
