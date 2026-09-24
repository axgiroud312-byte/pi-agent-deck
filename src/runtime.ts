import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { RunDetails, RunStatus, WriterLease } from "./types.ts";
import { reserveRunSlot } from "./run-capacity.ts";
import { assertRequestExecutionPolicy, selectExecution, applyExecutionArgs, isReviewRequest, type RoutingPlan, type RoutingDecision } from "./router.mjs";
import { atomicJson, persistCompletion } from "./persistence.mjs";
import { childRuntimeRules } from "./instruction.ts";
import { RpcConnection } from "./rpc-connection.ts";

export interface RunnerRequest {
  version: 1;
  cwd: string;
  command: string;
  argsPrefix: string[];
  prompt: string;
  env?: Record<string, string>;
  writerLease?: WriterLease;
  naturalOutput?: boolean;
  timeoutMs?: number;
  routing?: RoutingPlan;
  routingDecision?: RoutingDecision;
  review?: boolean;
}
export interface PersistedRun extends RunDetails {
  updatedAt: number;
  ownerPid?: number;
  /** Read-only compatibility with old detached task records. */
  runnerPid?: number;
  childPid?: number;
  background?: boolean;
  stopRequested?: boolean;
  attemptStartedAt?: number;
}
export interface RunNotification { kind: "state" | "result"; run: PersistedRun }
type ManagedRun = {
  run: PersistedRun; request: RunnerRequest; rpc?: RpcConnection; ready: boolean;
  busy: boolean; starting?: Promise<void>; abort: AbortController;
  messages: string[]; serial: number; error?: string; final: boolean; interrupted?: boolean;
  liveMessages: any[]; toolCalls: Map<string, { name: string; args: any }>;
  writes: Promise<void>; timer?: NodeJS.Timeout; releaseSlot?: () => void;
};
const owned = new Map<string, ManagedRun>();
const listeners = new Set<(event: RunNotification) => void>();
const TERMINAL = new Set<RunStatus>(["已完成", "失败", "已取消", "已停止", "失联"]);
export const isTerminalStatus = (status: RunStatus): boolean => TERMINAL.has(status);
export function subscribeRunEvents(listener: (event: RunNotification) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function emit(entry: ManagedRun, kind: RunNotification["kind"]): void {
  notify(entry.run, kind);
}
function notify(run: PersistedRun, kind: RunNotification["kind"]): void {
  const notification = { kind, run: structuredClone(run) };
  for (const listener of listeners) listener(notification);
}
function event(entry: ManagedRun, kind: RunDetails["events"][number]["kind"], text: string): void {
  entry.run.events = [...entry.run.events, { at: Date.now(), kind, text }].slice(-200);
}
function save(entry: ManagedRun): Promise<void> {
  entry.run.updatedAt = Date.now();
  entry.run.queuedMessageCount = entry.messages.length;
  const snapshot = structuredClone(entry.run);
  entry.writes = entry.writes.catch(() => {}).then(() => writeJsonAtomic(statusPath(snapshot.runId), snapshot));
  void entry.writes.catch(() => {});
  emit(entry, "state");
  return entry.writes;
}
function manage(run: PersistedRun, request: RunnerRequest): ManagedRun {
  const entry: ManagedRun = { run, request, ready: false, busy: false, abort: new AbortController(), messages: [], serial: 0, final: false, liveMessages: [], toolCalls: new Map(), writes: Promise.resolve() };
  owned.set(run.runId, entry);
  return entry;
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
  const release = isTerminalStatus(details.status) ? undefined : reserveRunSlot(details.parentSessionId, details.runId);
  try {
    const directory = runDirectory(details.runId);
    await fs.promises.mkdir(directory, { recursive: true });
    const persisted: PersistedRun = { ...details, cwd: details.cwd || request.cwd, background, ownerPid: process.pid, attemptStartedAt: details.startedAt, updatedAt: Date.now() };
    await writeJsonAtomic(path.join(directory, "request.json"), request);
    await writeJsonAtomic(path.join(directory, "status.json"), persisted);
    await registerParent(details);
    const entry = manage(persisted, request);
    entry.releaseSlot = release;
    return persisted;
  } catch (error) { release?.(); throw error; }
}

export async function readRun(runId: string, strict = false): Promise<PersistedRun | undefined> {
  const live = owned.get(runId);
  if (live) return structuredClone(live.run);
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

function rpcArgs(args: string[]): string[] {
  const output: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") { i++; continue; }
    if (args[i] === "--print" || args[i] === "-p") continue;
    output.push(args[i]);
  }
  return [...output, "--mode", "rpc"];
}

async function finish(entry: ManagedRun, status: RunStatus, error?: string): Promise<void> {
  if (!entry.busy) return;
  entry.busy = false;
  entry.ready = false;
  clearTimeout(entry.timer);
  const endedAt = Date.now();
  entry.run.pendingQuestion = undefined;
  entry.run.currentAction = "正在保存结果并释放进程";
  if (error) { entry.run.failureReason = error; entry.run.stderr = error; event(entry, "错误", error); }
  entry.run.writerLease = undefined;
  entry.run.resourceState = entry.rpc ? "releasing" : "released";
  try {
    await persistCompletion(runDirectory(entry.run.runId), { ...entry.run, status, endedAt, currentAction: undefined });
    await save(entry);
  } catch (failure) {
    entry.run.persistenceError = `结果保存失败：${String(failure)}`;
    event(entry, "错误", entry.run.persistenceError);
  } finally {
    const rpc = entry.rpc;
    if (rpc) {
      if (!entry.abort.signal.aborted) {
        try {
          const queue = await rpc.request("clear_queue");
          entry.messages.push(...(queue?.steering ?? []), ...(queue?.followUp ?? []));
        } catch { /* The execution outcome records RPC failures. */ }
      }
      await rpc.close();
      if (entry.rpc === rpc) entry.rpc = undefined;
    }
    entry.run.childPid = undefined;
    entry.run.resourceState = "released";
    entry.run.status = status;
    entry.run.endedAt = endedAt;
    entry.run.currentAction = undefined;
    entry.releaseSlot?.();
    entry.releaseSlot = undefined;
  }
  try { await save(entry); }
  catch (failure) {
    entry.run.persistenceError = `状态保存失败：${String(failure)}`;
    event(entry, "错误", entry.run.persistenceError);
  }
  notify(entry.run, "result");
}

function inTask<T>(runId: string, action: () => Promise<T>): Promise<T> {
  return withFileMutationQueue(`${runDirectory(runId)}/input`, action);
}

function handleEvent(entry: ManagedRun, data: any): void {
  if (data.type === "extension_ui_request") {
    if (["input", "select", "confirm", "editor"].includes(data.method)) void entry.rpc?.reply(data.id).catch(() => {});
    return;
  }
  if (entry.busy && !entry.abort.signal.aborted && data.message && ["message_start", "message_update", "message_end"].includes(data.type)) {
    const message = structuredClone(data.message);
    const index = entry.liveMessages.findIndex((item) => item.role === message.role && item.timestamp === message.timestamp && item.toolCallId === message.toolCallId);
    if (index < 0) entry.liveMessages.push(message); else entry.liveMessages[index] = message;
    entry.liveMessages = entry.liveMessages.slice(-200);
  }
  if (!entry.busy || entry.abort.signal.aborted) return;
  if (["agent_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_settled"].includes(data.type)) entry.serial++;
  if (data.type === "tool_execution_start") {
    entry.run.currentAction = `${data.toolName}${data.args?.path ? ` ${data.args.path}` : ""}`;
    entry.toolCalls.set(data.toolCallId, { name: data.toolName, args: data.args });
    event(entry, "工具", entry.run.currentAction!);
    void save(entry);
  } else if (data.type === "tool_execution_end") {
    const call = entry.toolCalls.get(data.toolCallId);
    if (call && !data.isError && ["write", "edit", "bash"].includes(call.name)) {
      const evidence = call.name === "bash" ? `命令返回：${call.args?.command ?? ""}（详见子会话工具输出）` : `文件写入：${call.args?.path ?? ""}`;
      entry.run.toolEvidence = [...(entry.run.toolEvidence ?? []), evidence].slice(-100);
    }
    entry.toolCalls.delete(data.toolCallId);
    if (data.toolName === "agent_report" && !data.isError && data.result?.details?.taskResult) {
      entry.run.result = data.result.details.taskResult;
      entry.run.finalText = entry.run.result!.summary;
      entry.final = true;
    }
    void save(entry);
  } else if (data.type === "message_end" && data.message?.role === "assistant") {
    const message = data.message;
    const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    if (text) entry.run.finalText = text;
    if (message.stopReason === "stop" && text?.trim() && entry.request.naturalOutput) entry.final = true;
    // Pi may retry a failed request automatically; only the last assistant outcome matters.
    entry.error = ["error", "aborted"].includes(message.stopReason) ? message.errorMessage ?? "模型执行未完成" : undefined;
    entry.interrupted = message.stopReason === "aborted";
    if (message.usage) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) entry.run.usage[key] += message.usage[key] ?? 0;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) entry.run.usage.cost[key] += message.usage.cost?.[key] ?? 0;
    }
    void save(entry);
  } else if (data.type === "agent_settled") {
    const turnId = entry.run.turnId;
    const rpc = entry.rpc;
    // Finish and input share one short control queue. Closing an old process
    // must finish before a new execution can acquire this task's session.
    void inTask(entry.run.runId, async () => {
      if (!rpc || entry.rpc !== rpc || !entry.busy || entry.abort.signal.aborted || entry.run.turnId !== turnId) return;
      const serial = entry.serial;
      const state = await rpc.request("get_state");
      if (!entry.busy || entry.abort.signal.aborted || entry.run.turnId !== turnId || entry.serial !== serial || state?.isStreaming || state?.isCompacting) return;
      const error = entry.error ?? (!entry.final ? "子 Agent 未返回最终结果" : undefined);
      await finish(entry, entry.interrupted ? "已停止" : error ? "失败" : "已完成", error);
    }).catch((error) => failExecution(entry, turnId, error));
  }
}

function failExecution(entry: ManagedRun, turnId: string | undefined, error: unknown): void {
  void inTask(entry.run.runId, async () => {
    if (entry.busy && !entry.abort.signal.aborted && entry.run.turnId === turnId) await finish(entry, "失败", error instanceof Error ? error.message : String(error));
  }).catch((failure) => { event(entry, "错误", String(failure)); });
}

function beginTurn(entry: ManagedRun): void {
  entry.releaseSlot = reserveRunSlot(entry.run.parentSessionId, entry.run.runId);
  entry.abort = new AbortController();
  entry.busy = true;
  // The previous process has exited; this turn has not submitted its first prompt.
  entry.ready = false;
  entry.final = false;
  entry.error = undefined;
  entry.interrupted = false;
  entry.liveMessages = [];
  entry.toolCalls.clear();
  Object.assign(entry.run, {
    turnId: randomUUID(), pendingQuestion: undefined, ownerPid: process.pid,
    resourceState: "starting",
    status: entry.request.routing && !entry.request.routingDecision && !entry.request.routing.immediate ? "选配中" : "运行中",
    attemptStartedAt: Date.now(), endedAt: undefined, exitCode: undefined, stderr: undefined,
    finalText: undefined, result: undefined, failureReason: undefined, persistenceError: undefined, toolEvidence: [], reports: [], events: [], stopRequested: false, currentAction: "正在启动",
  });
}

async function execute(entry: ManagedRun): Promise<void> {
  const turnId = entry.run.turnId;
  const cancelled = () => entry.abort.signal.aborted || entry.run.turnId !== turnId;
  try {
    const request = entry.request;
    request.review = isReviewRequest(request, entry.run);
    assertRequestExecutionPolicy(request, entry.run);
    if (request.routing && !request.routingDecision) {
      request.routing.state.review = request.review;
      const decision = await selectExecution(request.routing, { signal: entry.abort.signal });
      if (cancelled()) return;
      request.routingDecision = decision;
      request.argsPrefix = applyExecutionArgs(request.argsPrefix, decision);
      Object.assign(entry.run, { model: decision.model, thinking: decision.thinking, routing: decision, routingPending: false });
    }
    if (cancelled()) return;
    assertRequestExecutionPolicy(request, entry.run);
    entry.run.status = "运行中";
    await save(entry);
    await writeJsonAtomic(path.join(runDirectory(entry.run.runId), "request.json"), request);
    if (cancelled()) return;
    if (!entry.rpc) {
      entry.ready = false;
      const rpc = new RpcConnection(request.command, rpcArgs(request.argsPrefix), request.cwd, request.env,
        (data) => { if (entry.rpc === rpc && entry.run.turnId === turnId) handleEvent(entry, data); },
        (error) => failExecution(entry, turnId, error));
      entry.rpc = rpc;
      entry.run.resourceState = "running";
      entry.run.childPid = entry.rpc.child.pid;
      await save(entry);
      await entry.rpc.request("get_state");
      if (cancelled()) return;
      await entry.rpc.request("set_steering_mode", { mode: "all" });
    }
    if (cancelled()) return;
    entry.ready = true;
    const prompt = [request.prompt, ...entry.messages.splice(0)].join("\n\n");
    void save(entry);
    entry.run.currentAction = "子 Agent 正在执行";
    if (request.timeoutMs && request.timeoutMs > 0) entry.timer = setTimeout(() => {
      entry.abort.abort();
      entry.run.status = "停止中";
      void inTask(entry.run.runId, () => stopOwned(entry, "失败", "任务执行超时；可以在原会话手动继续。"));
    }, request.timeoutMs);
    await entry.rpc.request("prompt", { message: prompt });
  } catch (error) {
    if (cancelled()) return;
    failExecution(entry, turnId, error);
  }
}

function startExecution(entry: ManagedRun): void {
  const starting = execute(entry);
  entry.starting = starting;
  void starting.catch((error) => { event(entry, "错误", String(error)); }).finally(() => {
    if (entry.starting === starting) entry.starting = undefined;
  });
}

/** Retained internal name; execution is now owned by the calling Pi process. */
export async function launchRunner(runId: string): Promise<number> {
  return inTask(runId, async () => {
    const entry = owned.get(runId);
    // Reloading never replays detached requests or an old follow-up.json.
    if (!entry || entry.abort.signal.aborted || isTerminalStatus(entry.run.status)) return 0;
    if (!entry.busy) { beginTurn(entry); await save(entry); }
    if (!entry.starting && !entry.ready) {
      startExecution(entry);
    }
    return entry.rpc?.child.pid ?? 0;
  });
}

async function obtainIdleRun(runId: string): Promise<ManagedRun> {
  const live = owned.get(runId);
  if (live) return live;
  const run = await readRun(runId, true);
  if (!run) throw new Error("找不到任务");
  if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) throw new Error("旧任务仍由另一个 Pi 进程运行，请等待它结束后再继续。");
  const request = JSON.parse(await fs.promises.readFile(path.join(runDirectory(runId), "request.json"), "utf8")) as RunnerRequest;
  return manage({ ...run, status: isTerminalStatus(run.status) ? run.status : "已停止", pendingQuestion: undefined, writerLease: undefined, runnerPid: undefined, childPid: undefined, resourceState: "released", queuedMessageCount: 0 }, request);
}

/** QueueOnly: information never starts a model turn. */
export async function sendToRun(runId: string, message: string, _summary?: string): Promise<{ run: PersistedRun; delivery: "queued" | "deferred" }> {
  if (!message.trim()) throw new Error("请提供补充要求。");
  if (["停止中", "停止未确认"].includes(owned.get(runId)?.run.status ?? "")) throw new Error("任务正在停止，暂不接受消息。");
  return inTask(runId, async () => {
    const entry = await obtainIdleRun(runId);
    if (["停止中", "停止未确认"].includes(entry.run.status) || (entry.busy && entry.abort.signal.aborted)) throw new Error("任务正在停止，暂不接受消息。");
    if (entry.busy || (entry.releaseSlot && !isTerminalStatus(entry.run.status))) {
      if (!entry.ready) entry.messages.push(message);
      else await entry.rpc!.request("steer", { message });
      await save(entry);
      return { run: structuredClone(entry.run), delivery: "queued" };
    }
    entry.messages.push(message);
    await save(entry);
    return { run: structuredClone(entry.run), delivery: "deferred" };
  });
}

/** TriggerTurn: only an explicit resume may start the next execution. */
export async function resumeRun(runId: string, prompt: string, description?: string): Promise<PersistedRun> {
  if (!prompt.trim()) throw new Error("resume 必须提供本次任务要求。");
  return inTask(runId, async () => {
    const entry = await obtainIdleRun(runId);
    if (entry.busy || !isTerminalStatus(entry.run.status) || entry.rpc) throw new Error("任务仍在运行或释放中；补充要求请用 SendMessage，结束后才能 resume。");
    await fs.promises.access(entry.run.childSessionPath).catch(() => { throw new Error("保存的子会话不存在，无法 resume；请明确新建任务。"); });
    let header: any;
    try { header = JSON.parse((await fs.promises.readFile(entry.run.childSessionPath, "utf8")).split(/\r?\n/, 1)[0]); }
    catch { throw new Error("保存的子会话无法读取，不能创建空白替代；请修复会话或明确新建任务。"); }
    if (header?.type !== "session" || typeof header.id !== "string") throw new Error("保存的子会话缺少有效会话头，无法 resume。");
    entry.run.childSessionId = header.id;
    assertRequestExecutionPolicy(entry.request, entry.run);
    const release = reserveRunSlot(entry.run.parentSessionId, runId);
    try {
      await entry.starting;
      await persistCompletion(runDirectory(runId), entry.run);
      const toolsAt = entry.request.argsPrefix.indexOf("--tools");
      if (toolsAt >= 0) {
        const oldTools = entry.request.argsPrefix[toolsAt + 1].split(",");
        const tools = oldTools.filter((tool) => tool !== "agent_question");
        if (oldTools.includes("agent_question") && !tools.includes("agent_report")) tools.push("agent_report");
        entry.request.argsPrefix[toolsAt + 1] = tools.join(",");
        entry.run.tools = tools;
      }
      const systemAt = entry.request.argsPrefix.indexOf("--append-system-prompt");
      if (systemAt >= 0 && path.resolve(entry.request.argsPrefix[systemAt + 1]) === path.join(runDirectory(runId), "SYSTEM.md")) {
        const file = entry.request.argsPrefix[systemAt + 1];
        const old = await fs.promises.readFile(file, "utf8");
        await fs.promises.writeFile(file, old.split("# 统一运行规则")[0] + childRuntimeRules(entry.run.writePermission, entry.run.tools.includes("agent_report")));
      }
      entry.request.prompt = [...entry.messages, prompt].join("\n\n");
      entry.messages = [];
      beginTurn(entry);
      entry.run.instruction = prompt;
      entry.run.objective = prompt.trim().split(/\r?\n/, 1)[0].slice(0, 80);
      entry.run.description = description ?? entry.run.objective;
      entry.run.acceptanceCriteria = [];
      await save(entry);
      startExecution(entry);
      return structuredClone(entry.run);
    } catch (error) {
      release(); entry.releaseSlot = undefined;
      if (entry.busy) await finish(entry, "失败", String(error));
      throw error;
    }
  });
}

export function liveConversation(runId: string): any[] { return structuredClone(owned.get(runId)?.liveMessages ?? []); }

async function stopOwned(entry: ManagedRun, status: RunStatus = "已停止", error?: string): Promise<PersistedRun> {
  const wasBusy = entry.busy || !isTerminalStatus(entry.run.status);
  if (wasBusy && !entry.busy) entry.busy = true;
  if (entry.run.status === "排队中" && status === "已停止") status = "已取消";
  entry.abort.abort();
  entry.ready = false;
  entry.messages = [];
  clearTimeout(entry.timer);
  entry.run.stopRequested = true;
  entry.run.pendingQuestion = undefined;
  if (wasBusy) { entry.run.status = "停止中"; await save(entry).catch((error) => { entry.run.persistenceError = String(error); }); }
  if (entry.rpc) {
    const rpc = entry.rpc;
    try {
      await rpc.request("clear_queue");
      await rpc.request("abort", {}, 3000);
    } catch { /* Closing the owned process is the final cancellation boundary. */ }
    await rpc.close();
    entry.rpc = undefined;
  }
  entry.ready = false;
  entry.run.childPid = undefined;
  entry.run.resourceState = "released";
  entry.run.pendingQuestion = undefined;
  if (wasBusy) await finish(entry, status, error);
  else await save(entry).catch((error) => { entry.run.persistenceError = String(error); });
  return structuredClone(entry.run);
}

export async function stopRun(runId: string): Promise<PersistedRun> {
  return inTask(runId, async () => {
    const entry = owned.get(runId);
    if (entry) return stopOwned(entry);
    const run = await readRun(runId, true);
    if (!run) throw new Error("找不到任务");
    if (isTerminalStatus(run.status)) return run;
    if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) throw new Error("任务由另一个 Pi 进程管理，请在原 Pi 中停止。");
    const stopped: PersistedRun = { ...run, status: "已停止", pendingQuestion: undefined, endedAt: Date.now(), updatedAt: Date.now() };
    await writeJsonAtomic(statusPath(runId), stopped);
    return stopped;
  });
}

export async function shutdownRuns(parentSessionId?: string): Promise<void> {
  await Promise.all([...owned.values()].filter((entry) => !parentSessionId || entry.run.parentSessionId === parentSessionId).map(async (entry) => {
    await stopRun(entry.run.runId);
    await entry.starting;
    await entry.writes.catch(() => {});
    owned.delete(entry.run.runId);
  }));
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
export async function reconcileRun(runId: string): Promise<PersistedRun | undefined> {
  const run = await readRun(runId);
  if (!run || owned.has(runId) || isTerminalStatus(run.status) || isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) return run;
  const stopped: PersistedRun = { ...run, status: "已停止", pendingQuestion: undefined, currentAction: undefined, updatedAt: Date.now(), endedAt: Date.now() };
  await writeJsonAtomic(statusPath(runId), stopped);
  return stopped;
}
export async function reconcileRuns(parentSessionId?: string): Promise<PersistedRun[]> {
  const runs = await listRuns(Number.MAX_SAFE_INTEGER, parentSessionId);
  for (const run of runs) await reconcileRun(run.runId);
  return listRuns(50, parentSessionId);
}
export async function waitForRun(runId: string, options: { signal?: AbortSignal; onUpdate?: (run: PersistedRun) => void; pollMs?: number; stopOnAbort?: boolean } = {}): Promise<PersistedRun> {
  let updated = -1;
  while (true) {
    if (options.signal?.aborted) {
      if (options.stopOnAbort) return stopRun(runId);
      throw new Error(`已取消等待；Agent ${runId} 仍在后台运行`);
    }
    const run = await readRun(runId);
    if (!run) throw new Error(`找不到任务：${runId}`);
    if (run.updatedAt !== updated) { updated = run.updatedAt; options.onUpdate?.(run); }
    if (isTerminalStatus(run.status) || run.status === "等待决定") return run;
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
}
