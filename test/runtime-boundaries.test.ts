import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { adaptStoredRun, initializeRun, launchRunner, listRuns, readRun, reconcileRun, resumeRun, runDirectory, sendToRun, shutdownRuns, statusPath, subscribeRunEvents, stopRun, waitForRunTurn, writeJsonAtomic } from "../src/runtime.ts";
import agentDeck from "../src/index.ts";
import { readCompletions, withDiskLock } from "../src/persistence.mjs";
import { RpcConnection } from "../src/rpc-connection.ts";

const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

async function until<T>(read: () => Promise<T | undefined | false>, label: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待${label}超时`);
}

test("创建者在写 owner 前退出留下的空锁会在宽限期后恢复", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-empty-lock-"));
  const lock = path.join(root, "task.lock");
  await fs.mkdir(lock);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(lock, old, old);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let entered = false;
  await withDiskLock(lock, async () => { entered = true; });
  assert.equal(entered, true);
  await assert.rejects(fs.access(lock), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});

test("崩溃遗留的 recovery 锁可恢复，存活 owner 的 recovery 锁不会被误删", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "deck-recovery-lock-"));
  const lock = path.join(root, "task.lock");
  const recovery = `${lock}.recovery`;
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await fs.mkdir(recovery);
  const old = new Date(Date.now() - 5000);
  await fs.utimes(recovery, old, old);
  let recovered = false;
  await withDiskLock(lock, async () => { recovered = true; });
  assert.equal(recovered, true);
  await assert.rejects(fs.access(recovery), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  await fs.mkdir(recovery);
  await fs.writeFile(path.join(recovery, "owner.json"), JSON.stringify({ pid: process.pid, token: "live-recovery" }));
  let entered = false;
  const waiting = withDiskLock(lock, async () => { entered = true; });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(entered, false);
  assert.equal(JSON.parse(await fs.readFile(path.join(recovery, "owner.json"), "utf8")).token, "live-recovery");
  await fs.rm(recovery, { recursive: true, force: true });
  await waiting;
  assert.equal(entered, true);
});

test("v1 历史记录由集中适配器只读映射；启动核对不批量改写，未知版本明确拒绝", async (t) => {
  const id = `legacy-${randomUUID()}`;
  const raw: any = {
    version: 1, runId: id, agentId: "legacy-role", agentName: "旧角色", agentSource: "用户",
    objective: "旧任务", instruction: "旧任务", status: "等待决定", model: "legacy/model", thinking: "off",
    tools: ["read"], writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: "legacy.jsonl",
    cwd: process.cwd(), startedAt: 1, updatedAt: 2, events: [], usage,
    pendingQuestion: { id: "q1", turnId: "old-turn", question: "旧问题？", options: ["A"] },
    writerLease: { version: 1, runId: id, ownerToken: "old", cwd: process.cwd(), leasePath: "old", createdAt: 1 },
    reports: [{ type: "问题", title: "旧问题", summary: "等待", blocking: true }],
  };
  const adapted = adaptStoredRun(raw);
  assert.equal(adapted.roleId, "legacy-role");
  assert.equal(adapted.legacy?.pendingQuestion?.id, "q1");
  assert.equal(adapted.legacy?.writerLease?.ownerToken, "old");
  assert.equal(adapted.legacy?.reports?.[0].blocking, true);
  assert.equal("agentId" in adapted, false);
  assert.equal("pendingQuestion" in adapted, false);
  assert.equal(raw.agentId, "legacy-role", "适配不能修改调用方原对象");
  const oldConfigOnly = structuredClone(raw);
  oldConfigOnly.version = 2;
  oldConfigOnly.roleId = oldConfigOnly.agentId;
  delete oldConfigOnly.agentId;
  delete oldConfigOnly.tools;
  oldConfigOnly.effectiveConfig = { tools: ["read"], disallowedTools: ["write"], extensions: ["./legacy-extension.ts"] };
  const migratedConfig = adaptStoredRun(oldConfigOnly);
  assert.deepEqual(migratedConfig.tools, ["read"]);
  assert.deepEqual(migratedConfig.disallowedTools, ["write"]);
  assert.deepEqual(migratedConfig.extensions, ["./legacy-extension.ts"]);
  assert.equal("effectiveConfig" in migratedConfig, false, "旧配置只迁移到直接字段，不保留第二套对象");
  assert.throws(() => adaptStoredRun({ ...raw, version: 99 }), /不支持的任务记录版本/);

  const directory = runDirectory(id);
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const source = `${JSON.stringify(raw, null, 2)}\n`;
  await fs.writeFile(statusPath(id), source);
  const observed = await reconcileRun(id);
  assert.equal(observed?.version, 1);
  assert.equal(await fs.readFile(statusPath(id), "utf8"), source, "启动核对不得写回 v1 历史文件");
});

test("父会话索引不会永久吞掉未知版本；修复记录后可重新发现", async (t) => {
  const id = `unknown-${randomUUID()}`, parent = `parent-${id}`;
  const directory = runDirectory(id);
  await fs.mkdir(directory, { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base: any = {
    version: 99, runId: id, roleId: "future", agentName: "future", agentSource: "用户",
    objective: "future", instruction: "future", status: "已完成", model: "fake/model", thinking: "off",
    tools: [], writePermission: false, parentSessionId: parent, childSessionId: id, childSessionPath: "future.jsonl",
    cwd: process.cwd(), startedAt: 1, endedAt: 2, updatedAt: 2, events: [], usage,
  };
  await writeJsonAtomic(statusPath(id), base);
  await assert.rejects(listRuns(50, parent), /不支持的任务记录版本|无法索引任务记录/);
  await writeJsonAtomic(statusPath(id), { ...base, version: 2 });
  assert.ok((await listRuns(50, parent)).some((run) => run.runId === id));
});

test("未归属且进程已死的任务会清 PID、标 released 并保存完成事实", async (t) => {
  for (const mode of ["stop", "reconcile"] as const) {
    const id = `dead-${mode}-${randomUUID()}`;
    const directory = runDirectory(id);
    const raw: any = {
      version: 3, runId: id, roleId: "worker", agentName: "dead", agentSource: "内置",
      objective: "dead", instruction: "dead", status: "运行中", resourceState: "running",
      model: "fake/model", thinking: "off", tools: [], disallowedTools: [], extensions: [], parentSessionId: id,
      childSessionId: id, childSessionPath: "dead.jsonl", cwd: process.cwd(), childPid: 2147483000,
      startedAt: 1, updatedAt: 2, events: [], usage,
    };
    await fs.mkdir(directory, { recursive: true });
    await writeJsonAtomic(statusPath(id), raw);
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const finished = mode === "stop" ? await stopRun(id, "panel-stop") : (await reconcileRun(id))!;
    assert.equal(finished.status, mode === "stop" ? "已停止" : "失联");
    assert.equal(finished.resourceState, "released");
    assert.equal(finished.childPid, undefined);
    assert.equal(finished.legacy?.writePermission, undefined);
    const history = await readCompletions(directory);
    assert.equal(history.length, 1);
    assert.equal(history[0].resourceState, "released");
  }
});

test("子进程尚未启动时，存活 ownerPid 阻止其他运行时误判失联或接管", async (t) => {
  const id = `live-owner-${randomUUID()}`;
  const directory = runDirectory(id);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-live-owner-"));
  const raw: any = {
    version: 2, runId: id, roleId: "scout", agentName: "live owner", agentSource: "内置",
    objective: "starting", instruction: "starting", status: "选配中", resourceState: "starting",
    model: "fake/model", thinking: "off", tools: [], disallowedTools: [], extensions: [],
    effectiveConfig: { tools: [], disallowedTools: [], extensions: [], writePermission: false },
    writePermission: false, parentSessionId: id, childSessionId: id,
    childSessionPath: path.join(cwd, "session.jsonl"), cwd, ownerPid: process.pid,
    startedAt: Date.now(), updatedAt: Date.now(), events: [], usage,
  };
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomic(statusPath(id), raw);
  await writeJsonAtomic(path.join(directory, "request.json"), {
    version: 2, cwd, command: process.execPath, argsPrefix: [], prompt: "starting",
  });
  t.after(async () => {
    await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  const reconciled = await reconcileRun(id);
  assert.equal(reconciled?.status, "选配中");
  assert.equal(reconciled?.resourceState, "starting");
  assert.equal(reconciled?.ownerPid, process.pid);
  await assert.rejects(sendToRun(id, "不得接管"), /另一个 Pi 进程运行/);
  await assert.rejects(stopRun(id), /另一个 Pi 进程管理/);
  const unchanged = await readRun(id, true);
  assert.equal(unchanged?.status, "选配中");
  assert.equal(unchanged?.ownerPid, process.pid);
});

test("异常终态记录仍有存活 childPid 时不能假装已经释放", async (t) => {
  const id = `terminal-live-child-${randomUUID()}`;
  const directory = runDirectory(id);
  const raw: any = {
    version: 2, runId: id, roleId: "worker", agentName: "live child", agentSource: "内置",
    objective: "terminal", instruction: "terminal", status: "已完成", resourceState: "released",
    model: "fake/model", thinking: "off", tools: [], disallowedTools: [], extensions: [],
    effectiveConfig: { tools: [], disallowedTools: [], extensions: [], writePermission: false },
    writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: "session.jsonl",
    cwd: process.cwd(), childPid: process.pid, startedAt: 1, endedAt: 2, updatedAt: 2, events: [], usage,
  };
  await fs.mkdir(directory, { recursive: true });
  await writeJsonAtomic(statusPath(id), raw);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const reconciled = await reconcileRun(id);
  assert.equal(reconciled?.childPid, process.pid);
  await assert.rejects(stopRun(id), /另一个 Pi 进程管理/);
  assert.equal((await readRun(id, true))?.childPid, process.pid);
});

test("空闲 SendMessage 只更新进程内邮箱，不改写 v1 或持久化幽灵计数", async (t) => {
  const id = `legacy-mail-${randomUUID()}`;
  const directory = runDirectory(id), cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-legacy-mail-"));
  const raw: any = {
    version: 1, runId: id, agentId: "legacy-role", agentName: "旧角色", agentSource: "用户",
    objective: "旧任务", instruction: "旧任务", status: "等待决定", model: "fake/model", thinking: "off",
    tools: [], writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: path.join(cwd, "session.jsonl"),
    cwd, startedAt: 1, updatedAt: 2, events: [], usage,
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(statusPath(id), `${JSON.stringify(raw, null, 2)}\n`);
  await fs.writeFile(path.join(directory, "request.json"), JSON.stringify({ version: 1, cwd, command: process.execPath, argsPrefix: [], prompt: "old" }));
  const source = await fs.readFile(statusPath(id), "utf8");
  t.after(async () => { await shutdownRuns(id); await fs.rm(directory, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const sent = await sendToRun(id, "仅在本进程暂存");
  assert.equal(sent.delivery, "deferred");
  assert.equal(sent.run.queuedMessageCount, 1);
  assert.equal(await fs.readFile(statusPath(id), "utf8"), source);
  await shutdownRuns(id);
  assert.equal((await readRun(id, true))?.queuedMessageCount, undefined);
  assert.equal(await fs.readFile(statusPath(id), "utf8"), source);
});

test("v1 已结束任务暂存消息后 TaskStop 仍不改写历史记录", async (t) => {
  const id = `legacy-terminal-${randomUUID()}`;
  const directory = runDirectory(id), cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-legacy-terminal-"));
  const raw: any = {
    version: 1, runId: id, agentId: "legacy-role", agentName: "旧角色", agentSource: "用户",
    objective: "旧任务", instruction: "旧任务", status: "已完成", model: "fake/model", thinking: "off",
    tools: [], writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: path.join(cwd, "session.jsonl"),
    cwd, startedAt: 1, endedAt: 2, updatedAt: 2, finalText: "旧结果", events: [], usage,
  };
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(statusPath(id), `${JSON.stringify(raw, null, 2)}\n`);
  await fs.writeFile(path.join(directory, "request.json"), JSON.stringify({ version: 1, cwd, command: process.execPath, argsPrefix: [], prompt: "old" }));
  const source = await fs.readFile(statusPath(id), "utf8");
  t.after(async () => { await shutdownRuns(id); await fs.rm(directory, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  assert.equal((await sendToRun(id, "仅暂存")).delivery, "deferred");
  const stopped = await stopRun(id);
  assert.equal(stopped.status, "已完成");
  assert.equal(stopped.queuedMessageCount, 0);
  assert.equal(await fs.readFile(statusPath(id), "utf8"), source);
});
async function fixture(t: any, tools: string[] = [], prompt = "plain", timeoutMs?: number) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-boundary-"));
  const id = `boundary-${randomUUID()}`, parent = id;
  const script = path.join(cwd, "rpc.mjs");
  await fs.writeFile(script, String.raw`import readline from "node:readline";
const send=x=>process.stdout.write(JSON.stringify(x)+"\n");
let lateExtension=false;
readline.createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line);
if(q.type==="clear_queue"&&lateExtension)return setTimeout(()=>{send({type:"extension_error",error:{message:"LATE_EXTENSION_DURING_CLOSE"}});send({type:"response",id:q.id,success:true,data:{}});},60);
send({type:"response",id:q.id,success:true,data:q.type==="get_state"?{isStreaming:false}:{}});
if(q.type==="prompt"&&q.message!=="HOLD")setTimeout(()=>{if(q.message==="extension-error-then-text")send({type:"extension_error",error:{message:"BROKEN_EXTENSION_AFTER_START"}});if(q.message==="late-extension")lateExtension=true;if(q.message!=="silent"){const text=q.message==="blocked"?"我做不到：需要主 Agent 决定":q.message==="empty"?"":"PARTIAL_TEXT";send({type:"message_end",message:{role:"assistant",stopReason:q.message==="error"?"error":"stop",errorMessage:q.message==="error"?"MODEL_ERROR":undefined,content:text?[{type:"text",text}]:[]}});}send({type:"agent_settled"});},30);
});`);
  const session = path.join(cwd, "session.jsonl");
  await fs.writeFile(session, JSON.stringify({ type: "session", id, version: 3 }) + "\n");
  await initializeRun({ version: 3, runId: id, roleId: "fixture", agentName: "fixture", agentSource: "内置", objective: "fixture", instruction: "fixture", status: "运行中", model: "fake/model", thinking: "off", tools, disallowedTools: [], extensions: [], parentSessionId: parent, childSessionId: id, childSessionPath: session, cwd, startedAt: Date.now(), events: [], usage } as any,
    { version: 3, cwd, command: process.execPath, argsPrefix: [script, "--tools", tools.join(",")], prompt, timeoutMs }, true);
  t.after(async () => { await shutdownRuns(parent); await fs.rm(runDirectory(id), { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  return { id, parent, cwd };
}

async function settled(id: string) {
  for (let i = 0; i < 400; i++) { const run = await readRun(id); if (run?.resourceState === "released" && ["失败", "已完成", "已停止"].includes(run.status)) return run; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error("timeout");
}
test("launch 首次保存失败：同一调用返回失败结果，不再抛错或重复后台通知", async t => {
  const { id } = await fixture(t);
  const file = statusPath(id); await fs.unlink(file); await fs.mkdir(file);
  const notices: any[] = []; const off = subscribeRunEvents(e => { if (e.kind === "result" && e.run.runId === id) notices.push(e.run); });
  t.after(off);
  assert.equal(await launchRunner(id), 0);
  const run = (await readRun(id))!;
  assert.equal(run.status, "失败"); assert.equal(run.resourceState, "released");
  assert.equal(run.childPid, undefined);
  assert.match(run.failureReason ?? "", /EISDIR|EPERM|directory/i);
  assert.ok(run.persistenceError); assert.equal(notices.length, 0);
  await fs.rmdir(file);
});
test("resume 首次保存失败也由同一调用返回已收口结果并释放进程", async t => {
  const { id } = await fixture(t);
  await launchRunner(id); await settled(id);
  const file = statusPath(id);
  const originalRename = fs.rename;
  fs.rename = async (from, to) => {
    if (path.resolve(String(to)) === path.resolve(file)) throw Object.assign(new Error("STATUS_RENAME_FAILURE"), { code: "EACCES" });
    return originalRename(from, to);
  };
  try {
    const returned = await resumeRun(id, "again");
    const run = (await readRun(id))!;
    assert.equal(returned.turnId, run.turnId);
    assert.equal(run.status, "失败"); assert.equal(run.resourceState, "released");
  } finally { fs.rename = originalRename; }
});

test("owned 终态记录损坏后 resume 严格拒绝且不覆盖磁盘", async t => {
  const { id } = await fixture(t);
  await launchRunner(id); await settled(id);
  const file = statusPath(id);
  const broken = '{"version":99,"runId":"future"}\n';
  await fs.writeFile(file, broken);
  await assert.rejects(resumeRun(id, "不得覆盖"), /不支持的任务记录版本|无法读取任务记录/);
  assert.equal(await fs.readFile(file, "utf8"), broken);
  assert.equal((await readRun(id))?.childPid, undefined);
});
test("close 异常不能假释放，保留 PID 及失败提示，TaskStop 可再次清理", async t => {
  const { id } = await fixture(t, [], "HOLD");
  await launchRunner(id);
  for (let i = 0; i < 100 && !(await readRun(id))?.childPid; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const pid = (await readRun(id))!.childPid!;
  assert.ok(pid);
  const original = RpcConnection.prototype.close;
  let attempts = 0;
  RpcConnection.prototype.close = function () { if (++attempts === 1) return Promise.reject(new Error("CLOSE_INJECTED")); return original.call(this); };
  try {
    const unconfirmed = await stopRun(id, "tool-stop");
    assert.equal(unconfirmed.status, "停止未确认");
    assert.notEqual(unconfirmed.resourceState, "released");
    assert.equal(unconfirmed.childPid, pid);
    assert.match(unconfirmed.failureReason ?? "", /CLOSE_INJECTED/);
    assert.equal((await readCompletions(runDirectory(id))).length, 0, "未确认清理不能发布已释放的历史快照");
    await assert.rejects(resumeRun(id, "again"), /运行|释放|停止/);
    const stopped = await stopRun(id, "tool-stop");
    assert.equal(stopped.status, "已停止"); assert.equal(stopped.resourceState, "released");
    assert.equal(stopped.childPid, undefined);
    const history = (await readCompletions(runDirectory(id))).at(-1)!;
    assert.equal(history.resourceState, "released");
    assert.match(history.failureReason ?? "", /CLOSE_INJECTED/);
  } finally { RpcConnection.prototype.close = original; }
});

test("后台结束清理失败后 TaskStop 重试保留原交付，不重复后台唤醒", async t => {
  const { id } = await fixture(t, [], "blocked");
  const notices: any[] = [];
  const off = subscribeRunEvents(e => { if (e.kind === "result" && e.run.runId === id) notices.push(e.run); });
  t.after(off);
  const original = RpcConnection.prototype.close;
  let attempts = 0;
  RpcConnection.prototype.close = function () { return ++attempts === 1 ? Promise.reject(new Error("CLOSE_BACKGROUND")) : original.call(this); };
  try {
    await launchRunner(id);
    for (let i = 0; i < 400 && (await readRun(id))?.status !== "停止未确认"; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await readRun(id))?.status, "停止未确认");
    const recovered = await stopRun(id, "tool-stop");
    assert.equal(recovered.status, "已完成");
    assert.equal(recovered.finalText, "我做不到：需要主 Agent 决定");
    assert.equal(recovered.resourceState, "released");
    assert.equal(notices.at(-1)?.completionSource, "tool-stop");
    assert.equal(notices.filter(n => n.completionSource === "execution").length, 1);
  } finally { RpcConnection.prototype.close = original; }
});

test("终态可见前完成历史保存，避免已释放观察者读到缺失快照", async t => {
  const { id } = await fixture(t);
  const original = fs.rename;
  let unblock!: () => void, writing!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const reached = new Promise<void>(resolve => { writing = resolve; });
  fs.rename = async (from, to) => {
    if (String(to).includes(id) && path.basename(path.dirname(String(to))) === "results") { writing(); await gate; }
    return original(from, to);
  };
  try {
    await launchRunner(id);
    await Promise.race([reached, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("history write timeout")), 10000); timer.unref(); })]);
    assert.notEqual((await readRun(id))?.status, "已完成");
    unblock();
    const run = await settled(id);
    assert.equal((await readCompletions(runDirectory(id))).at(-1)?.turnId, run.turnId);
  } finally { unblock(); fs.rename = original; }
});

test("前台 waiter 必须等最终 status 落盘，不能抢先看到 released 终态", async t => {
  const { id } = await fixture(t);
  const original = fs.rename;
  let unblock!: () => void, reached!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const terminalWrite = new Promise<void>(resolve => { reached = resolve; });
  let blocked = false;
  fs.rename = async (from, to) => {
    if (!blocked && String(to) === statusPath(id)) {
      const candidate = JSON.parse(await fs.readFile(from, "utf8"));
      if (candidate.status === "已完成" && candidate.resourceState === "released") {
        blocked = true; reached(); await gate;
      }
    }
    return original(from, to);
  };
  try {
    await launchRunner(id);
    const turnId = (await readRun(id))!.turnId!;
    let returned = false;
    const waiting = waitForRunTurn(id, turnId, { pollMs: 5 }).then((run) => { returned = true; return run; });
    await Promise.race([terminalWrite, new Promise((_, reject) => setTimeout(() => reject(Error("terminal status write timeout")), 10_000))]);
    assert.equal(returned, false);
    assert.notEqual((await readRun(id))?.status, "已完成");
    unblock();
    const run = await waiting;
    assert.equal(run.status, "已完成");
    assert.equal(run.resourceState, "released");
  } finally { unblock(); fs.rename = original; }
});

test("最终 status 写失败时保留文本与 persistenceError，并明确记为运行失败", async t => {
  const { id } = await fixture(t);
  const original = fs.rename;
  let injected = false;
  fs.rename = async (from, to) => {
    if (!injected && String(to) === statusPath(id)) {
      const candidate = JSON.parse(await fs.readFile(from, "utf8"));
      if (candidate.status === "已完成" && candidate.resourceState === "released") {
        injected = true;
        throw Object.assign(new Error("FINAL_STATUS_INJECTED"), { code: "EIO" });
      }
    }
    return original(from, to);
  };
  let firstTurn = "";
  try {
    await launchRunner(id);
    const current = (await readRun(id))!;
    const run = await waitForRunTurn(id, current.turnId!, { pollMs: 5 });
    firstTurn = run.turnId!;
    assert.equal(run.status, "失败");
    assert.equal(run.finalText, "PARTIAL_TEXT");
    assert.match(run.persistenceError ?? "", /FINAL_STATUS_INJECTED/);
    assert.match((await readRun(id, true))?.persistenceError ?? "", /FINAL_STATUS_INJECTED/);
  } finally { fs.rename = original; }
  const resumed = await resumeRun(id, "again");
  await waitForRunTurn(id, resumed.turnId!, { pollMs: 5 });
  const firstHistory = (await readCompletions(runDirectory(id))).find((item: any) => item.turnId === firstTurn);
  assert.equal(firstHistory?.status, "失败");
  assert.match(firstHistory?.persistenceError ?? "", /FINAL_STATUS_INJECTED/, "下一轮覆盖当前状态后，旧轮仍须保留保存错误");
  assert.equal((await readCompletions(runDirectory(id))).filter((item: any) => item.turnId === firstTurn).length, 1, "同一执行轮次只能有一个最终结果记录");
});

test("RpcConnection 强制结束后确认有界；未确认时明确失败而非永久等待", async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-close-timeout-"));
  const script = path.join(cwd, "stubborn.mjs");
  await fs.writeFile(script, "process.stdin.resume(); setInterval(() => {}, 1000);\n");
  const connection = new RpcConnection(process.execPath, [script], cwd, undefined, () => {}, () => {}, {
    gracefulMs: 10, taskkillMs: 1000, confirmMs: 20,
  });
  const realClosed = connection.closed;
  Object.defineProperty(connection, "closed", { value: new Promise<void>(() => {}), configurable: true });
  t.after(async () => {
    connection.child.kill("SIGKILL");
    await Promise.race([realClosed, new Promise(resolve => setTimeout(resolve, 2000))]);
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const started = Date.now();
  await assert.rejects(connection.close(), /退出未确认|TaskStop/);
  assert.ok(Date.now() - started < 2500, "close 必须在配置的边界内失败");
});

test("主动停止保持停止状态，不依赖终报协议", async t => {
  const { id } = await fixture(t, [], "HOLD");
  await launchRunner(id);
  const stopped = await stopRun(id, "panel-stop");
  assert.equal(stopped.status, "已停止");
});

test("后台终态唤醒一次，TaskStop 工具回执、shutdown 不重复唤醒", async t => {
  const { id, parent } = await fixture(t);
  const handlers = new Map<string, any>(), sent: any[] = [];
  agentDeck({ on: (name: string, fn: any) => handlers.set(name, fn), registerTool() {}, registerCommand() {}, registerMessageRenderer() {}, getActiveTools: () => [], setActiveTools() {}, sendMessage: (message: any, options: any) => sent.push({ message, options }) } as any);
  const ctx: any = { sessionManager: { getSessionId: () => parent }, ui: { setStatus() {}, setWidget() {}, notify() {}, theme: { fg: (_: string, text: string) => text } } };
  await handlers.get("session_start")({}, ctx);
  const guidance = await handlers.get("before_agent_start")({}, { ...ctx, cwd: path.dirname(import.meta.url), isProjectTrusted: () => false });
  assert.equal(guidance, undefined, "编排目录通过 Agent 工具描述提供，不再注入隐藏系统消息");
  t.after(async () => handlers.get("session_shutdown")());
  await launchRunner(id); const first = await settled(id);
  for (let i = 0; i < 100 && sent.length < 1; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sent.length, 1); assert.equal(sent[0].options.triggerTurn, true);
  await resumeRun(id, "HOLD");
  await stopRun(id, "tool-stop"); assert.equal(sent.length, 1);
  await resumeRun(id, "HOLD");
  await handlers.get("session_shutdown")(); assert.equal(sent.length, 1);
  assert.notEqual(first.turnId, (await readRun(id))?.turnId);
});

test("正常 settled 即 completed；做不到、空文本和无 message_end 都不做语义验收", async t => {
  for (const prompt of ["plain", "blocked", "empty", "silent", "error"] as const) {
    const { id } = await fixture(t, [], prompt);
    await launchRunner(id);
    const run = await settled(id);
    assert.equal(run.status, prompt === "error" ? "失败" : "已完成");
    if (prompt === "plain") assert.equal(run.finalText, "PARTIAL_TEXT");
    if (prompt === "blocked") assert.equal(run.finalText, "我做不到：需要主 Agent 决定");
    if (prompt === "empty") assert.equal(run.finalText, "");
    if (prompt === "silent") assert.equal(run.finalText, undefined);
    if (prompt === "error") assert.match(run.failureReason ?? "", /MODEL_ERROR/);
    const history = await readCompletions(runDirectory(id));
    assert.equal(history.at(-1)?.status, run.status);
    assert.equal(history.at(-1)?.finalText, run.finalText);
  }
});

test("扩展错误不会被随后正常文本和 settled 覆盖", async t => {
  const { id } = await fixture(t, [], "extension-error-then-text");
  await launchRunner(id);
  const run = await settled(id);
  assert.equal(run.status, "失败");
  assert.equal(run.finalText, "PARTIAL_TEXT");
  assert.match(run.failureReason ?? "", /BROKEN_EXTENSION_AFTER_START/);
  assert.equal(run.resourceState, "released");
});

test("settled 后清理期间迟到的扩展错误仍把正常文本轮次记为失败", async t => {
  const { id } = await fixture(t, [], "late-extension");
  await launchRunner(id);
  const run = await settled(id);
  assert.equal(run.status, "失败");
  assert.equal(run.finalText, "PARTIAL_TEXT");
  assert.match(run.failureReason ?? "", /LATE_EXTENSION_DURING_CLOSE/);
});

test("v2 生效配置只在明确 resume 时迁移为 v3 直接字段", async t => {
  const { id, parent } = await fixture(t, [], "plain");
  await launchRunner(id);
  await settled(id);
  await shutdownRuns(parent);

  const statusFile = statusPath(id);
  const old = JSON.parse(await fs.readFile(statusFile, "utf8"));
  old.version = 2;
  old.status = "等待决定";
  old.effectiveConfig = { tools: [], disallowedTools: ["write"], extensions: [] };
  delete old.tools;
  delete old.disallowedTools;
  delete old.extensions;
  await writeJsonAtomic(statusFile, old);
  const requestFile = path.join(runDirectory(id), "request.json");
  const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
  request.version = 2;
  request.argsPrefix.push("--exclude-tools", "write");
  await writeJsonAtomic(requestFile, request);

  const source = await fs.readFile(statusFile, "utf8");
  const reconciled = await reconcileRun(id);
  assert.equal(reconciled?.version, 2);
  assert.equal(await fs.readFile(statusFile, "utf8"), source, "启动核对不得写回 v2 历史文件");

  const resumed = await resumeRun(id, "plain", undefined, false, old.turnId ?? null);
  assert.equal(resumed.version, 3);
  assert.deepEqual(resumed.tools, [], "显式空 allowlist 在 resume 后仍必须是空数组");
  assert.deepEqual(resumed.disallowedTools, ["write"]);
  const completed = await settled(id);
  assert.equal(completed.status, "已完成");
  const migrated = JSON.parse(await fs.readFile(statusFile, "utf8"));
  assert.equal(migrated.version, 3);
  assert.equal("effectiveConfig" in migrated, false);
});

test("无 turnId 的旧轮次发出的迟到停止不能中止已经 resume 的新轮", async t => {
  const { id, parent } = await fixture(t, [], "plain");
  await launchRunner(id);
  await settled(id);
  await shutdownRuns(parent);

  const statusFile = statusPath(id);
  const legacy = JSON.parse(await fs.readFile(statusFile, "utf8"));
  legacy.version = 1;
  legacy.agentId = legacy.roleId;
  delete legacy.roleId;
  delete legacy.turnId;
  await writeJsonAtomic(statusFile, legacy);
  const requestFile = path.join(runDirectory(id), "request.json");
  const request = JSON.parse(await fs.readFile(requestFile, "utf8"));
  request.version = 1;
  await writeJsonAtomic(requestFile, request);

  const resumed = await resumeRun(id, "HOLD", undefined, false, null);
  assert.ok(resumed.turnId);
  await assert.rejects(stopRun(id, "panel-stop", null), /其他执行轮次/);
  const current = (await readRun(id))!;
  assert.equal(current.turnId, resumed.turnId);
  assert.equal(current.status, "运行中");
  await stopRun(id, "panel-stop", resumed.turnId);
});

test("旧版按 status 命名的完成记录在 resume 时不复制成第二份历史", async t => {
  const { id, parent } = await fixture(t, [], "plain");
  await launchRunner(id);
  const first = await settled(id);
  await shutdownRuns(parent);
  const results = path.join(runDirectory(id), "results");
  await fs.rm(results, { recursive: true, force: true });
  await fs.mkdir(results, { recursive: true });
  const legacyId = `${first.runId}:${first.turnId ?? first.attemptStartedAt ?? first.startedAt}:${first.endedAt}:${first.status}`;
  const legacyFile = path.join(results, `${createHash("sha256").update(legacyId).digest("hex")}.json`);
  await fs.writeFile(legacyFile, JSON.stringify(first));
  const resumed = await resumeRun(id, "plain", undefined, false, first.turnId ?? null);
  await waitForRunTurn(id, resumed.turnId!, { pollMs: 5 });
  const history = await readCompletions(runDirectory(id));
  assert.equal(history.filter((item: any) => item.turnId === first.turnId).length, 1);
  assert.equal(history.filter((item: any) => item.turnId === resumed.turnId).length, 1);
});

test("两个 Pi 进程同时 resume 同一任务时只有一个能取得执行权", async t => {
  const { id, parent, cwd } = await fixture(t, [], "plain");
  await launchRunner(id);
  const original = await settled(id);
  await shutdownRuns(parent);

  const helper = path.join(cwd, "resume-worker.mjs");
  const barrier = path.join(cwd, "resume-go");
  const runtimeUrl = pathToFileURL(path.resolve("src/runtime.ts")).href;
  await fs.writeFile(helper, `import fs from "node:fs/promises";\nconst delay=ms=>new Promise(r=>setTimeout(r,ms));\nconst [id,expectedTurnId,ready,barrier,startDelay,result]=process.argv.slice(2);\nconst {resumeRun,readRun,shutdownRuns}=await import(${JSON.stringify(runtimeUrl)});\nawait fs.writeFile(ready,String(process.pid));\nwhile(true){try{await fs.access(barrier);break}catch{await delay(10)}}\nawait delay(Number(startDelay));\ntry{const run=await resumeRun(id,"plain",undefined,false,expectedTurnId);await fs.writeFile(result,JSON.stringify({ok:true,pid:process.pid,turnId:run.turnId}));while(true){const current=await readRun(id);if(current?.resourceState==="released")break;await delay(10)}await shutdownRuns(id);}catch(error){await fs.writeFile(result,JSON.stringify({ok:false,pid:process.pid,error:String(error)}));}\n`);
  const workers = [0, 1].map((index) => {
    const ready = path.join(cwd, `worker-${index}.ready`);
    const result = path.join(cwd, `worker-${index}.json`);
    const child = spawn(process.execPath, ["--import", "tsx", helper, id, original.turnId!, ready, barrier, String(index * 200), result], {
      cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    return { child, ready, result, stderr: () => stderr };
  });
  t.after(async () => {
    for (const worker of workers) if (worker.child.exitCode === null) worker.child.kill();
  });
  await until(async () => {
    const ready = await Promise.all(workers.map((worker) => fs.access(worker.ready).then(() => true, () => false)));
    return ready.every(Boolean) ? true : undefined;
  }, "两个独立 Pi 控制进程就绪");
  await fs.writeFile(barrier, "1");
  const outcomes = await until<Array<{ ok: boolean; pid: number; turnId?: string; error?: string }>>(async () => {
    const values = await Promise.all(workers.map((worker) => fs.readFile(worker.result, "utf8").then(JSON.parse, () => undefined)));
    return values.every(Boolean) ? values as Array<{ ok: boolean; pid: number; turnId?: string; error?: string }> : undefined;
  }, "并发 resume 结果");
  assert.equal(outcomes.filter((item) => item.ok).length, 1);
  assert.equal(outcomes.filter((item) => !item.ok).length, 1);
  assert.match(outcomes.find((item) => !item.ok)?.error ?? "", /其他执行轮次/);
  const winner = outcomes.find((item) => item.ok)!;
  await Promise.all(workers.map(({ child, stderr }) => new Promise<void>((resolve, reject) => {
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`resume worker exited ${code}: ${stderr()}`)));
    if (child.exitCode !== null) child.exitCode === 0 ? resolve() : reject(new Error(`resume worker exited ${child.exitCode}: ${stderr()}`));
  })));
  const durable = JSON.parse(await fs.readFile(statusPath(id), "utf8"));
  assert.equal(durable.turnId, winner.turnId);
  assert.equal(durable.status, "已完成");
  assert.equal(durable.resourceState, "released");
});

test("旧执行轮次的迟到超时回调不能中止已 resume 的新轮", async t => {
  const originalSetTimeout = globalThis.setTimeout;
  const timeoutCallbacks: Array<() => void> = [];
  globalThis.setTimeout = ((callback: (...args: any[]) => void, ms?: number, ...args: any[]) => {
    if (ms === 12_345) {
      timeoutCallbacks.push(() => callback(...args));
      return originalSetTimeout(() => {}, 60_000);
    }
    return originalSetTimeout(callback, ms, ...args);
  }) as typeof setTimeout;
  t.after(() => { globalThis.setTimeout = originalSetTimeout; });

  const { id } = await fixture(t, [], "plain", 12_345);
  await launchRunner(id);
  const first = await settled(id);
  assert.equal(timeoutCallbacks.length, 1);
  const resumed = await resumeRun(id, "HOLD");
  assert.notEqual(resumed.turnId, first.turnId);
  timeoutCallbacks[0]();
  await new Promise((resolve) => originalSetTimeout(resolve, 80));
  const current = (await readRun(id))!;
  assert.equal(current.turnId, resumed.turnId);
  assert.equal(current.status, "运行中");
  await stopRun(id);
});
