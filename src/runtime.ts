import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { acquireWriterLease, releaseWriterLease, listWriterLeases, type WriterLease } from "./admission.ts";
import { AGENT_DECK_VERSION, CHILD_RUNTIME_PROTOCOL_VERSION } from "./version.ts";
import type { RunDetails, RunStatus } from "./types.ts";
import { assertRequestExecutionPolicy, type RoutingPlan, type RoutingDecision } from "./router.mjs";
import { reserveCapacity } from "./capacity.ts";
import { atomicJson, withDiskLock, persistCompletion, readCompletions, releaseCapacity, type CapacityLease } from "./persistence.mjs";
import { messagePreview } from "./tool-contract.ts";

export interface RunnerRequest {
  version: 1;
  cwd: string;
  command: string;
  argsPrefix: string[];
  prompt: string;
  inboxPath?: string;
  env?: Record<string, string>;
  writerLease?: WriterLease;
  naturalOutput?: boolean;
  timeoutMs?: number;
  routing?: RoutingPlan;
  routingDecision?: RoutingDecision;
  review?: boolean;
  capacityLease?: CapacityLease;
  followUpBatch?: { id: string; messageIds: string[]; resumed: PersistedRun };
}

export interface PersistedRun extends RunDetails {
  updatedAt: number;
  runnerPid?: number;
  childPid?: number;
  background?: boolean;
  stopRequested?: boolean;
  attemptStartedAt?: number;
  capacityLease?: CapacityLease;
  followUpBatchId?: string;
  policyBlocked?: boolean;
}

const TERMINAL = new Set<RunStatus>(["已完成", "失败", "已取消", "已停止", "失联"] as RunStatus[]);

export function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL.has(status);
}

export interface InboxEvent {
  version: 1;
  eventId: string;
  runId: string;
  parentSessionId: string;
  status: RunStatus;
  agentName: string;
  objective: string;
  at: number;
}

export function inboxPath(): string {
  return path.join(getAgentDir(), "agent-deck", "inbox.jsonl");
}

function inboxAckPath(): string {
  return path.join(getAgentDir(), "agent-deck", "inbox-ack.json");
}

export async function readInbox(parentSessionId?: string, unreadOnly = false): Promise<Array<InboxEvent & { consumed: boolean }>> {
  let events: InboxEvent[] = [];
  try {
    events = (await fs.promises.readFile(inboxPath(), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as InboxEvent);
  } catch { /* 尚无收件箱 */ }
  let consumedIds = new Set<string>();
  try {
    const parsed = JSON.parse(await fs.promises.readFile(inboxAckPath(), "utf8")) as { eventIds?: string[] };
    consumedIds = new Set(parsed.eventIds ?? []);
  } catch { /* 尚无确认记录 */ }
  return events
    .filter((event) => !parentSessionId || event.parentSessionId === parentSessionId)
    .map((event) => ({ ...event, consumed: consumedIds.has(event.eventId) }))
    .filter((event) => !unreadOnly || !event.consumed);
}

export async function appendInboxEvent(run: PersistedRun): Promise<void> {
  const at = run.endedAt ?? Date.now();
  const event: InboxEvent = {
    version: 1,
    eventId: `${run.runId}:${at}:${run.status}`,
    runId: run.runId,
    parentSessionId: run.parentSessionId,
    status: run.status,
    agentName: run.agentName,
    objective: run.objective,
    at,
  };
  const file = inboxPath();
  await withFileMutationQueue(file, async () => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.appendFile(file, `${JSON.stringify(event)}\n`, "utf8");
  });
}

export async function acknowledgeInbox(runIds: string[]): Promise<void> {
  const wanted = new Set(runIds);
  const events = await readInbox();
  let existing: string[] = [];
  try {
    const parsed = JSON.parse(await fs.promises.readFile(inboxAckPath(), "utf8")) as { eventIds?: string[] };
    existing = parsed.eventIds ?? [];
  } catch { /* 尚无确认记录 */ }
  const eventIds = [...new Set([...existing, ...events.filter((event) => wanted.has(event.runId)).map((event) => event.eventId)])];
  await writeJsonAtomic(inboxAckPath(), { version: 1, updatedAt: Date.now(), eventIds });
}

export function runsRoot(): string {
  return path.join(getAgentDir(), "agent-deck", "runs");
}

export function runDirectory(runId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("无效的任务编号");
  return path.join(runsRoot(), runId);
}

export function statusPath(runId: string): string {
  return path.join(runDirectory(runId), "status.json");
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await withFileMutationQueue(filePath, () => atomicJson(filePath, value));
}

function parentIndex(parent: string): string {
  return path.join(getAgentDir(), "agent-deck", "parents", createHash("sha256").update(parent).digest("hex"));
}
async function registerParent(run: RunDetails): Promise<void> {
  const directory = parentIndex(run.parentSessionId);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, run.runId), "");
}

export async function initializeRun(details: RunDetails, request: RunnerRequest, background: boolean): Promise<PersistedRun> {
  const directory = runDirectory(details.runId);
  await fs.promises.mkdir(directory, { recursive: true });
  const persisted: PersistedRun = { ...details, background, attemptStartedAt: details.startedAt, updatedAt: Date.now() };
  await writeJsonAtomic(path.join(directory, "request.json"), request);
  await writeJsonAtomic(path.join(directory, "status.json"), persisted);
  await registerParent(details);
  return persisted;
}

export async function readRun(runId: string, strict = false): Promise<PersistedRun | undefined> {
  try {
    const file = statusPath(runId);
    const stat = await fs.promises.stat(file);
    const cached = runCache.get(file);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return structuredClone(cached.run);
    const run = JSON.parse(await fs.promises.readFile(file, "utf8")) as PersistedRun;
    run.acceptanceCriteria ??= [];
    run.cwd ??= "";
    run.reports = (run.reports ?? []).map((report) => ({
      ...report,
      acceptanceCriteria: report.acceptanceCriteria ?? [],
      evidence: report.evidence ?? [],
      completed: report.completed ?? [],
      deliverables: report.deliverables ?? [],
      filesRead: report.filesRead ?? [],
      filesChanged: report.filesChanged ?? [],
      fileChanges: report.fileChanges ?? [],
      designDecisions: report.designDecisions ?? [],
      commands: report.commands ?? [],
      tests: report.tests ?? [],
      risks: report.risks ?? [],
      unknowns: report.unknowns ?? [],
      downstreamNotes: report.downstreamNotes ?? [],
      recommendations: report.recommendations ?? [],
      options: report.options ?? [],
      blocking: report.blocking ?? false,
    }));
    if (runCache.size >= 500) runCache.delete(runCache.keys().next().value!);
    runCache.set(file, { mtime: stat.mtimeMs, size: stat.size, run: structuredClone(run) });
    return run;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`无法读取任务记录 ${runId}，请先修复记录：${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

const runCache = new Map<string, { mtime: number; size: number; run: PersistedRun }>();

export async function listRuns(limit = 50, parentSessionId?: string, strict = false): Promise<PersistedRun[]> {
  try {
    let ids: string[];
    if (parentSessionId) {
      const index = parentIndex(parentSessionId);
      try { await fs.promises.access(path.join(index, ".indexed")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Migration scans foreign parents too. Only this parent's indexed records are strict.
        const all = await listRuns(Number.MAX_SAFE_INTEGER);
        for (const run of all.filter((run) => run.parentSessionId === parentSessionId)) await registerParent(run);
        await fs.promises.mkdir(index, { recursive: true });
        await fs.promises.writeFile(path.join(index, ".indexed"), "1");
      }
      ids = (await fs.promises.readdir(index)).filter((name) => !name.startsWith("."));
    } else ids = (await fs.promises.readdir(runsRoot(), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const runs = (await Promise.all(ids.map((id) => readRun(id, strict))))
      .filter((item): item is PersistedRun => Boolean(item) && (!parentSessionId || item?.parentSessionId === parentSessionId));
    return runs.sort((a, b) => (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt)).slice(0, limit);
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}

function nodeExecutable(): string {
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|node\.exe)$/.test(executable) ? process.execPath : "node";
}

async function withRunControl<T>(runId: string, action: () => Promise<T>): Promise<T> {
  return withFileMutationQueue(`${runDirectory(runId)}/control`, async () => {
    const lock = path.join(runDirectory(runId), "control.lock");
    let handle;
    try { handle = await fs.promises.open(lock, "wx"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner: number;
      try { owner = Number(await fs.promises.readFile(lock, "utf8")); } catch { throw new Error("任务正在更新，请稍后重试。"); }
      const stat = await fs.promises.stat(lock);
      if (isProcessAlive(owner) || Date.now() - stat.mtimeMs < 15_000) throw new Error("任务正在更新，请稍后重试。");
      await fs.promises.unlink(lock);
      handle = await fs.promises.open(lock, "wx");
    }
    try {
      await handle.writeFile(String(process.pid));
      return await action();
    } finally { await handle.close(); await fs.promises.unlink(lock); }
  });
}

export async function launchRunner(runId: string): Promise<number> {
  return withRunControl(runId, () => launchRunnerUnlocked(runId));
}

async function launchRunnerUnlocked(runId: string): Promise<number> {
  await recoverPreparedFollowUp(runId);
  const run = await readRun(runId);
  if (!run) throw new Error("找不到任务");
  if (isTerminalStatus(run.status) || run.stopRequested || run.status === "停止中" || run.status === "停止未确认" || run.status === "等待决定") return 0;
  if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) return run.runnerPid ?? run.childPid!;
  const requestFile = path.join(runDirectory(runId), "request.json");
  const request = JSON.parse(await fs.promises.readFile(requestFile, "utf8")) as RunnerRequest;
  try { assertRequestExecutionPolicy(request, run); }
  catch (error) {
    // Old queued work must reach a durable terminal state instead of retrying forever.
    if (run.writerLease) await releaseWriterLease(run.writerLease);
    await releaseCapacity(request.capacityLease);
    const failed = { ...run, policyBlocked: true, status: "失败" as const, endedAt: Date.now(), updatedAt: Date.now(), currentAction: undefined, stderr: String(error) };
    await persistCompletion(runDirectory(runId), failed);
    await writeJsonAtomic(statusPath(runId), failed);
    return 0;
  }
  // A resumed request can contain an already-released lease. Never reuse it blindly.
  if (request.capacityLease) await releaseCapacity(request.capacityLease);
  const capacity = await reserveCapacity(runId, run.agentId);
  if (!capacity.lease) {
    await writeJsonAtomic(statusPath(runId), { ...run, status: "排队中", currentAction: capacity.reason, updatedAt: Date.now() });
    return 0;
  }
  request.capacityLease = capacity.lease;
  let lease = run.writerLease;
  if (lease) {
    const current = listWriterLeases().find((item) => item.lease?.ownerToken === lease?.ownerToken);
    if (!current) lease = undefined;
  }
  try {
  if (run.writePermission && !lease) {
    let admission = await acquireWriterLease(run.cwd, runId);
    if (!admission.acquired && admission.existing?.runId) {
      const owner = await readRun(admission.existing.runId);
      if (owner?.writerLease && owner.writerLease.ownerToken === admission.existing.ownerToken
        && (owner.runnerPid || owner.childPid)
        && !isProcessAlive(owner.runnerPid) && !isProcessAlive(owner.childPid)
        && Date.now() - (owner.attemptStartedAt ?? owner.startedAt) >= 15_000) {
        await releaseWriterLease(owner.writerLease);
        admission = await acquireWriterLease(run.cwd, runId);
      }
    }
    if (!admission.acquired) {
      await releaseCapacity(capacity.lease);
      await writeJsonAtomic(statusPath(runId), { ...run, status: "排队中", currentAction: "等待同一工作区的写任务结束", updatedAt: Date.now() });
      return 0;
    }
    lease = admission.lease;
    request.writerLease = lease;
  }
  try {
    await writeJsonAtomic(requestFile, request);
    const selecting = request.routing && !request.routingDecision && !request.routing.immediate;
    await writeJsonAtomic(statusPath(runId), { ...run, writerLease: lease, capacityLease: capacity.lease, status: selecting ? "选配中" : "运行中", attemptStartedAt: Date.now(), updatedAt: Date.now(), currentAction: selecting ? "Jev 正在选择模型与思考强度" : "正在启动" });
  } catch (error) { if (lease) await releaseWriterLease(lease); throw error; }
  const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.mjs");
  const child = spawn(nodeExecutable(), [runnerPath, "--run-dir", runDirectory(runId)], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  try {
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
    if (!child.pid) throw new Error("无法启动 Agent Runner");
    // Keep the per-task control lock until the runner has recorded its identity.
    const readyBy = Date.now() + 5000;
    while (Date.now() < readyBy) {
      const current = await readRun(runId);
      if (current?.runnerPid === child.pid) return child.pid;
      if (child.exitCode !== null) throw new Error("Agent Runner 在启动确认前退出");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const current = await readRun(runId);
    await writeJsonAtomic(statusPath(runId), { ...current, runnerPid: child.pid, currentAction: "Runner 启动确认延迟" });
    return child.pid;
  } catch (error) {
    if (lease) await releaseWriterLease(lease);
    const failed = { ...run, status: "失败" as const, endedAt: Date.now(), updatedAt: Date.now(), currentAction: undefined, stderr: String(error) };
    await writeJsonAtomic(statusPath(runId), failed);
    await persistCompletion(runDirectory(runId), failed);
    throw error;
  }
  } catch (error) { await releaseCapacity(capacity.lease); throw error; }
}

export async function waitForRun(
  runId: string,
  options: {
    signal?: AbortSignal;
    onUpdate?: (run: PersistedRun) => void;
    pollMs?: number;
    stopOnAbort?: boolean;
  } = {},
): Promise<PersistedRun> {
  let lastUpdated = -1;
  while (true) {
    if (options.signal?.aborted) {
      if (options.stopOnAbort) {
        await stopRun(runId);
        const stopped = await readRun(runId);
        if (stopped) return stopped;
      }
      throw new Error(`已取消等待；Agent ${runId} 仍在后台运行`);
    }
    const run = await readRun(runId);
    if (!run) throw new Error(`运行状态丢失：${runId}`);
    if (run.updatedAt !== lastUpdated) {
      lastUpdated = run.updatedAt;
      options.onUpdate?.(run);
    }
    if (isTerminalStatus(run.status) || run.status === "等待决定") return run;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 150));
  }
}

function isProcessAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopRun(runId: string): Promise<PersistedRun> {
  return withRunControl(runId, () => withDiskLock(path.join(runDirectory(runId), "spawn.lock"), () => stopRunUnlocked(runId)));
}

async function stopRunUnlocked(runId: string): Promise<PersistedRun> {
  await recoverPreparedFollowUp(runId);
  const run = await readRun(runId);
  if (!run) throw new Error(`找不到运行：${runId}`);
  await fs.promises.rm(path.join(runDirectory(runId), "follow-up.json"), { force: true });
  if (isTerminalStatus(run.status)) return run;
  await fs.promises.writeFile(path.join(runDirectory(runId), "stop-requested"), "1");
  if (run.status === "排队中" || run.status === "等待决定") {
    const stopped = { ...run, status: "已取消" as const, endedAt: Date.now(), updatedAt: Date.now(), currentAction: undefined };
    await writeJsonAtomic(statusPath(runId), stopped);
    await persistCompletion(runDirectory(runId), stopped);
    await releaseCapacity(run.capacityLease);
    return stopped;
  }
  const stopping: PersistedRun = { ...run, status: "停止中", stopRequested: true, updatedAt: Date.now() } as PersistedRun;
  await writeJsonAtomic(statusPath(runId), stopping);
  const pid = isProcessAlive(run.runnerPid) ? run.runnerPid : run.childPid;
  let killAttempted = false;
  let killSucceeded = true;
  if (pid && isProcessAlive(pid)) {
    killAttempted = true;
    if (process.platform === "win32") {
      killSucceeded = await new Promise<boolean>((resolve) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("close", (code) => resolve(code === 0));
        killer.on("error", () => resolve(false));
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try { process.kill(pid, "SIGTERM"); } catch { killSucceeded = false; }
      }
    }
  }
  if (killAttempted && killSucceeded) {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid))) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const hasProcessIdentity = Boolean(run.runnerPid || run.childPid);
  const processTreeConfirmedDead = hasProcessIdentity
    && (!killAttempted || killSucceeded)
    && !isProcessAlive(run.runnerPid)
    && !isProcessAlive(run.childPid);
  const leaseReleased = run.writerLease && processTreeConfirmedDead
    ? await releaseWriterLease(run.writerLease)
    : false;
  const finalStatus: RunStatus = processTreeConfirmedDead ? "已停止" : "停止未确认";
  const stopped: PersistedRun = {
    ...(await readRun(runId) ?? stopping),
    status: finalStatus,
    stopRequested: true,
    ...(processTreeConfirmedDead ? { endedAt: Date.now(), currentAction: undefined } : { currentAction: "无法确认 Runner 和子进程已经退出；writer 租约保持占用" }),
    updatedAt: Date.now(),
    ...(leaseReleased ? { writerLease: undefined } : {}),
  } as PersistedRun;
  await writeJsonAtomic(statusPath(runId), stopped);
  await persistCompletion(runDirectory(runId), stopped);
  if (processTreeConfirmedDead) await releaseCapacity(run.capacityLease);
  await appendInboxEvent(stopped);
  return stopped;
}

export async function continueRun(runId: string, answer: string): Promise<PersistedRun> {
  return (await sendToRun(runId, answer)).run;
}

interface QueuedMessage { id: string; message: string; summary: string; at: number }
async function pendingMessages(runId: string): Promise<QueuedMessage[]> {
  const file = path.join(runDirectory(runId), "follow-up.json");
  try {
    const items: Array<string | QueuedMessage> = JSON.parse(await fs.promises.readFile(file, "utf8"));
    if (!Array.isArray(items)) throw new Error("任务消息队列格式无效。");
    let migrated = false;
    const messages = items.map((item) => {
      if (typeof item === "string") { migrated = true; return { id: randomUUID(), message: item, summary: messagePreview(item), at: 0 }; }
      if (!item || typeof item.message !== "string" || typeof item.summary !== "string") throw new Error("任务消息队列格式无效。");
      if (typeof item.id !== "string" || !item.id) { migrated = true; return { ...item, id: randomUUID() }; }
      return item;
    });
    // Legacy entries must acquire durable IDs before an attempt can reference them.
    if (migrated) await writeJsonAtomic(file, messages);
    const run = await readRun(runId);
    const request = JSON.parse(await fs.promises.readFile(path.join(runDirectory(runId), "request.json"), "utf8")) as RunnerRequest;
    const consumed = new Set(request.followUpBatch?.id === run?.followUpBatchId ? request.followUpBatch?.messageIds : []);
    return messages.filter((message) => !consumed.has(message.id));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Called under the task control lock. request.json is the durable resume transaction. */
async function recoverPreparedFollowUp(runId: string): Promise<boolean> {
  const run = await readRun(runId);
  if (!run) return false;
  const request = JSON.parse(await fs.promises.readFile(path.join(runDirectory(runId), "request.json"), "utf8")) as RunnerRequest;
  const batch = request.followUpBatch;
  if (!batch) return false;
  if (run.followUpBatchId === batch.id) return false;
  if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) throw new Error("上一次执行尚未完全退出，请稍后继续。");
  await writeJsonAtomic(statusPath(runId), batch.resumed);
  return true;
}

export async function sendToRun(runId: string, answer: string, summary = messagePreview(answer)): Promise<{ run: PersistedRun; delivery: "queued" | "resumed" }> {
  if (!answer.trim()) throw new Error("请提供补充要求。");
  return withRunControl(runId, async () => {
    if (await recoverPreparedFollowUp(runId)) await launchRunnerUnlocked(runId);
    const run = await readRun(runId);
    if (!run) throw new Error("找不到任务");
    const file = path.join(runDirectory(runId), "follow-up.json");
    const pending = await pendingMessages(runId);
    const messages = [...pending, { id: randomUUID(), message: answer, summary: messagePreview(summary), at: Date.now() }];
    if (run.status === "运行中" || run.status === "排队中" || run.status === "选配中") {
      await writeJsonAtomic(file, messages);
      return { run: { ...run, currentAction: "补充要求已排队，当前执行结束后继续" }, delivery: "queued" };
    }
    // A just-finished task may still have older queued messages. Keep their original order.
    const resumed = await resumeRun(runId, messages);
    return { run: resumed, delivery: "resumed" };
  });
}

async function resumeRun(runId: string, messages: QueuedMessage[]): Promise<PersistedRun> {
  const directory = runDirectory(runId);
  const run = await readRun(runId);
  if (!run) throw new Error(`找不到运行：${runId}`);
  if (run.status !== "等待决定" && !isTerminalStatus(run.status)) throw new Error(`任务目前不能继续：${run.status}`);
  if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) throw new Error("上一次执行尚未完全退出，请稍后继续。");
  const request = JSON.parse(await fs.promises.readFile(path.join(directory, "request.json"), "utf8")) as RunnerRequest;
  assertRequestExecutionPolicy(request, run);
  // Remove any previously consumed entries before replacing their durable receipt.
  await writeJsonAtomic(path.join(directory, "follow-up.json"), messages);
  await persistCompletion(directory, run);
  await releaseCapacity(run.capacityLease);
  if (run.writerLease) await releaseWriterLease(run.writerLease);
  const writerLease = undefined;
  if (run.writePermission && !run.cwd) throw new Error("旧任务缺少工作目录，不能继续。");
  request.prompt = [
    "# 主会话的补充要求",
    "",
    messages.map((message) => message.message).join("\n\n"),
    "",
    "在原会话上下文中处理这次补充要求，遵守原有约束。完成后直接返回结论、证据和未完成事项。",
  ].join("\n");
  const attemptStartedAt = Date.now();
  const runtimeAckPath = request.env?.PI_AGENT_DECK_RUNTIME_ACK_PATH ?? path.join(directory, "runtime-ack.json");
  request.env = {
    ...(request.env ?? {}),
    PI_AGENT_DECK_RUNTIME_ACK_PATH: runtimeAckPath,
    PI_AGENT_DECK_RUNTIME_ACK_TOKEN: randomUUID(),
    PI_AGENT_DECK_PROTOCOL_VERSION: String(CHILD_RUNTIME_PROTOCOL_VERSION),
    PI_AGENT_DECK_EXTENSION_VERSION: AGENT_DECK_VERSION,
  };
  request.writerLease = writerLease;
  request.capacityLease = undefined;
  const resumed: PersistedRun = {
    ...run,
    writerLease,
    capacityLease: undefined,
    autoDeliver: true,
    attemptStartedAt,
    // If the parent exits before launch, the normal queue scheduler can restart this attempt.
    status: "排队中",
    followUpBatchId: randomUUID(),
    currentAction: "正在处理主会话补充要求",
    endedAt: undefined,
    exitCode: undefined,
    stderr: undefined,
    runnerPid: undefined,
    childPid: undefined,
    stopRequested: false,
    reports: [],
    finalText: undefined,
    updatedAt: Date.now(),
    events: [...run.events, { at: Date.now(), kind: "状态" as const, text: `主会话补充：${messagePreview(messages.map((message) => message.summary).join("；"))}` }].slice(-200),
  };
  request.followUpBatch = { id: resumed.followUpBatchId!, messageIds: messages.map((message) => message.id), resumed };
  await fs.promises.rm(runtimeAckPath, { force: true });
  await fs.promises.rm(path.join(directory, "stop-requested"), { force: true });
  await writeJsonAtomic(path.join(directory, "request.json"), request);
  await writeJsonAtomic(statusPath(runId), resumed);
  await launchRunnerUnlocked(runId);
  // Queue cleanup is optional: the committed batch prevents replay even if unlink fails.
  try { await fs.promises.unlink(path.join(directory, "follow-up.json")); } catch { /* durable receipt remains */ }
  return (await readRun(runId)) ?? resumed;
}

export async function reconcileRun(runId: string): Promise<PersistedRun | undefined> {
  const run = await readRun(runId);
  if (!run) return undefined;
  const active = new Set<RunStatus>(["等待批准", "选配中", "运行中", "停止中", "停止未确认"] as RunStatus[]);
  if (!active.has(run.status) || isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) return run;
  if (Date.now() - (run.attemptStartedAt ?? run.startedAt) < 15_000) return run;
  const completed = (await readCompletions(runDirectory(runId))).reverse().find((result) => (result.attemptStartedAt ?? result.startedAt) === (run.attemptStartedAt ?? run.startedAt));
  if (completed) {
    const restored = { ...run, ...completed, currentAction: undefined, updatedAt: Date.now() };
    await writeJsonAtomic(statusPath(runId), restored);
    await releaseCapacity(run.capacityLease);
    return restored;
  }
  const lost: PersistedRun = {
    ...run,
    status: "失联",
    endedAt: Date.now(),
    updatedAt: Date.now(),
    currentAction: undefined,
    events: [...run.events, { at: Date.now(), kind: "错误" as const, text: "Pi 启动时未发现对应的 Runner 或子进程" }].slice(-200),
  };
  await writeJsonAtomic(statusPath(runId), lost);
  await persistCompletion(runDirectory(runId), lost);
  await releaseCapacity(run.capacityLease);
  await appendInboxEvent(lost);
  return lost;
}

/** Recover a prepared attempt, or consume a new batch exactly once. */
export async function startFollowUp(runId: string): Promise<boolean> {
  try { await fs.promises.access(path.join(runDirectory(runId), "follow-up.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  return withRunControl(runId, async () => {
    if (await recoverPreparedFollowUp(runId)) { await launchRunnerUnlocked(runId); return true; }
    const run = await readRun(runId);
    if (!run || (!isTerminalStatus(run.status) && run.status !== "等待决定")) return false;
    if (run.policyBlocked) return false;
    if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) return false;
    const pending = await pendingMessages(runId);
    if (!pending.length) return false;
    try { await resumeRun(runId, pending); }
    catch (error) {
      if ((error as { code?: string }).code === "MODEL_POLICY") await writeJsonAtomic(statusPath(runId), {
        ...run, policyBlocked: true, updatedAt: Date.now(),
        events: [...run.events, { at: Date.now(), kind: "错误", text: `补充任务已暂停：${String(error)}` }].slice(-200),
      });
      throw error;
    }
    return true;
  });
}

export async function reconcileRuns(): Promise<PersistedRun[]> {
  const runs = await listRuns(200);
  for (const run of runs) await reconcileRun(run.runId);
  return listRuns(50);
}
