import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { acquireWriterLease, releaseWriterLease, type WriterLease } from "./admission.ts";
import type { RunDetails, RunStatus } from "./types.ts";
import { assertRequestExecutionPolicy, selectExecution, applyExecutionArgs, isReviewRequest, type RoutingPlan, type RoutingDecision } from "./router.mjs";
import { atomicJson, persistCompletion } from "./persistence.mjs";
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
export interface RunNotification { kind: "state" | "progress" | "question" | "result"; run: PersistedRun }
type ManagedRun = {
  run: PersistedRun; request: RunnerRequest; rpc?: RpcConnection; ready: boolean;
  busy: boolean; starting?: Promise<void>; abort: AbortController;
  messages: string[]; serial: number; error?: string; final: boolean;
  questionTool?: { id: string; question: string; options: string[] };
  writes: Promise<void>; timer?: NodeJS.Timeout; writerWait?: NodeJS.Timeout;
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
  const snapshot = structuredClone(entry.run);
  entry.writes = entry.writes.then(() => writeJsonAtomic(statusPath(snapshot.runId), snapshot));
  void entry.writes.catch(() => {});
  emit(entry, "state");
  return entry.writes;
}
function manage(run: PersistedRun, request: RunnerRequest): ManagedRun {
  const entry: ManagedRun = { run, request, ready: false, busy: false, abort: new AbortController(), messages: [], serial: 0, final: false, writes: Promise.resolve() };
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
  const directory = runDirectory(details.runId);
  await fs.promises.mkdir(directory, { recursive: true });
  const persisted: PersistedRun = { ...details, cwd: details.cwd || request.cwd, background, ownerPid: process.pid, attemptStartedAt: details.startedAt, updatedAt: Date.now() };
  await writeJsonAtomic(path.join(directory, "request.json"), request);
  await writeJsonAtomic(path.join(directory, "status.json"), persisted);
  await registerParent(details);
  manage(persisted, request);
  return persisted;
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
  clearTimeout(entry.timer);
  clearTimeout(entry.writerWait);
  entry.run.status = status;
  entry.run.endedAt = Date.now();
  entry.run.pendingQuestion = undefined;
  entry.run.currentAction = undefined;
  if (error) { entry.run.stderr = error; event(entry, "错误", error); }
  const lease = entry.run.writerLease;
  entry.run.writerLease = undefined;
  const saved = save(entry);
  const snapshot = structuredClone(entry.run);
  if (lease) await releaseWriterLease(lease);
  await saved;
  await persistCompletion(runDirectory(snapshot.runId), snapshot);
  notify(snapshot, "result");
  // Only this process's explicitly dispatched tasks may be waiting for a writer.
  for (const queued of owned.values()) {
    if (queued.run.status === "排队中" && !queued.starting && !queued.abort.signal.aborted) void launchRunner(queued.run.runId);
  }
}

function handleEvent(entry: ManagedRun, data: any): void {
  if (data.type === "extension_ui_request") {
    if (["input", "select", "confirm", "editor"].includes(data.method)) {
      if (!entry.busy || entry.abort.signal.aborted || !entry.questionTool) {
        void entry.rpc?.reply(data.id).catch(() => {});
        return;
      }
      entry.run.pendingQuestion = { id: data.id, turnId: entry.run.turnId!, question: entry.questionTool.question, options: entry.questionTool.options };
      entry.run.status = "等待决定";
      entry.run.currentAction = "等待主 Agent 回答问题";
      void save(entry);
      emit(entry, "question");
    }
    return;
  }
  if (!entry.busy || entry.abort.signal.aborted) return;
  if (["agent_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_settled"].includes(data.type)) entry.serial++;
  if (data.type === "tool_execution_start") {
    entry.run.currentAction = `${data.toolName}${data.args?.path ? ` ${data.args.path}` : ""}`;
    if (data.toolName === "agent_question" || (data.toolName === "agent_report" && data.args?.type === "问题" && data.args?.blocking)) {
      entry.questionTool = { id: data.toolCallId, question: data.args.question ?? data.args.summary, options: data.args.options ?? [] };
    }
    event(entry, "工具", entry.run.currentAction!);
    void save(entry);
  } else if (data.type === "tool_execution_end") {
    if (entry.questionTool?.id === data.toolCallId) {
      entry.questionTool = undefined;
      entry.run.pendingQuestion = undefined;
      entry.run.status = "运行中";
    }
    if (["agent_report", "agent_question"].includes(data.toolName) && !data.isError && data.result?.details) {
      const report = data.result.details;
      entry.run.reports.push(report);
      if (report.type === "最终") entry.final = true;
      if (!report.blocking && report.type !== "最终") emit(entry, "progress");
    }
    void save(entry);
  } else if (data.type === "message_end" && data.message?.role === "assistant") {
    const message = data.message;
    const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    if (text) entry.run.finalText = text;
    if (message.stopReason === "stop" && text?.trim() && entry.request.naturalOutput) entry.final = true;
    // Pi may retry a failed request automatically; only the last assistant outcome matters.
    entry.error = ["error", "aborted"].includes(message.stopReason) ? message.errorMessage ?? "模型执行未完成" : undefined;
    if (message.usage) {
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) entry.run.usage[key] += message.usage[key] ?? 0;
      for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) entry.run.usage.cost[key] += message.usage.cost?.[key] ?? 0;
    }
    void save(entry);
  } else if (data.type === "agent_settled") {
    const serial = entry.serial;
    const turnId = entry.run.turnId;
    // A prompt racing with completion can already have started work in Pi.
    // Never let the earlier settled event mark that work complete.
    void entry.rpc?.request("get_state").then(async (state) => {
      if (!entry.busy || entry.abort.signal.aborted || entry.run.turnId !== turnId || entry.serial !== serial || state?.isStreaming) return;
      const error = entry.error ?? (!entry.final ? "子 Agent 未返回最终结果" : undefined);
      await finish(entry, error ? "失败" : "已完成", error);
    }).catch((error) => { if (entry.busy && !entry.abort.signal.aborted) void finish(entry, "失败", String(error)); });
  }
}

function beginTurn(entry: ManagedRun): void {
  clearTimeout(entry.writerWait);
  entry.abort = new AbortController();
  entry.busy = true;
  // An idle RPC is alive, but this turn's first prompt has not been submitted yet.
  entry.ready = false;
  entry.final = false;
  entry.error = undefined;
  entry.questionTool = undefined;
  Object.assign(entry.run, {
    turnId: randomUUID(), pendingQuestion: undefined, ownerPid: process.pid,
    status: entry.request.routing && !entry.request.routingDecision && !entry.request.routing.immediate ? "选配中" : "运行中",
    attemptStartedAt: Date.now(), endedAt: undefined, exitCode: undefined, stderr: undefined,
    finalText: undefined, reports: [], events: [], stopRequested: false, currentAction: "正在启动",
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
    if (entry.run.writePermission && !entry.run.writerLease) {
      const admission = await acquireWriterLease(request.cwd, entry.run.runId);
      if (cancelled()) { if (admission.acquired) await releaseWriterLease(admission.lease); return; }
      if (!admission.acquired) {
        entry.run.status = "排队中";
        entry.run.currentAction = "等待同一工作区的写任务结束";
        await save(entry);
        // Existing writer admission can be released by another Pi process too.
        // This only retries admission; messages never travel through disk polling.
        entry.writerWait = setTimeout(() => { void launchRunner(entry.run.runId); }, 500);
        entry.writerWait.unref();
        return;
      }
      entry.run.writerLease = admission.lease;
    }
    entry.run.status = "运行中";
    await save(entry);
    await writeJsonAtomic(path.join(runDirectory(entry.run.runId), "request.json"), request);
    if (cancelled()) return;
    if (!entry.rpc) {
      entry.ready = false;
      entry.rpc = new RpcConnection(request.command, rpcArgs(request.argsPrefix), request.cwd, request.env,
        (data) => handleEvent(entry, data), (error) => {
          entry.ready = false;
          entry.rpc = undefined;
          entry.run.childPid = undefined;
          if (entry.busy && !entry.abort.signal.aborted) void finish(entry, "失败", error.message);
          else void save(entry);
        });
      entry.run.childPid = entry.rpc.child.pid;
      await save(entry);
      await entry.rpc.request("get_state");
      await entry.rpc.request("set_steering_mode", { mode: "all" });
    }
    if (cancelled()) return;
    entry.ready = true;
    const prompt = [request.prompt, ...entry.messages.splice(0)].join("\n\n");
    entry.run.currentAction = "子 Agent 正在执行";
    if (request.timeoutMs && request.timeoutMs > 0) entry.timer = setTimeout(() => {
      void stopOwned(entry, "失败", "任务执行超时；可以在原会话手动继续。");
    }, request.timeoutMs);
    await entry.rpc.request("prompt", { message: prompt });
  } catch (error) {
    if (cancelled()) return;
    if (entry.rpc) { const rpc = entry.rpc; entry.rpc = undefined; entry.ready = false; await rpc.close(); }
    entry.run.childPid = undefined;
    await finish(entry, "失败", error instanceof Error ? error.message : String(error));
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
  const entry = owned.get(runId);
  // Reloading never replays detached requests or an old follow-up.json.
  if (!entry || entry.abort.signal.aborted || isTerminalStatus(entry.run.status)) return 0;
  if (!entry.busy) { beginTurn(entry); await save(entry); }
  if (!entry.starting && (!entry.ready || entry.run.status === "排队中")) {
    startExecution(entry);
  }
  return entry.rpc?.child.pid ?? 0;
}

export async function sendToRun(runId: string, message: string, _summary?: string, replyTo?: string): Promise<{ run: PersistedRun; delivery: "queued" | "resumed" }> {
  if (!message.trim()) throw new Error("请提供补充要求。");
  return withFileMutationQueue(`${runDirectory(runId)}/input`, async () => {
    let entry = owned.get(runId);
    if (entry && (entry.run.status === "停止中" || entry.run.status === "停止未确认" || (entry.busy && entry.abort.signal.aborted))) throw new Error("任务正在停止，暂不接受消息；停止完成后可在原会话继续。");
    if (replyTo) {
      const question = entry?.run.pendingQuestion;
      if (!entry?.rpc || !question || question.id !== replyTo || question.turnId !== entry.run.turnId || !entry.busy || entry.abort.signal.aborted) throw new Error("问题不存在、已经回答或已经失效；请使用当前任务的待答问题 ID。");
      entry.run.pendingQuestion = undefined;
      entry.run.status = "运行中";
      await entry.rpc.reply(replyTo, message);
      await save(entry);
      return { run: structuredClone(entry.run), delivery: "queued" };
    }
    if (entry?.busy) {
      // Invalidate any in-flight idle snapshot before Pi emits this input's events.
      entry.serial++;
      try {
        if (!entry.ready || entry.run.status === "排队中") entry.messages.push(message);
        else if (entry.run.pendingQuestion) await entry.rpc!.request("steer", { message });
        else await entry.rpc!.request("prompt", { message, streamingBehavior: "steer" });
      } catch (error) {
        // A rejected preflight must not suppress the completion of earlier work.
        if (entry.rpc && entry.ready) handleEvent(entry, { type: "agent_settled" });
        throw error;
      }
      return { run: structuredClone(entry.run), delivery: "queued" };
    }
    if (!entry) {
      const run = await readRun(runId, true);
      if (!run) throw new Error("找不到任务");
      if (isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid)) throw new Error("旧任务仍由另一个 Pi 进程运行，请等待它结束后再继续。");
      const previous = JSON.parse(await fs.promises.readFile(path.join(runDirectory(runId), "request.json"), "utf8")) as RunnerRequest;
      const request: RunnerRequest = { version: 1, cwd: previous.cwd, command: previous.command, argsPrefix: previous.argsPrefix, prompt: message, env: previous.env, naturalOutput: previous.naturalOutput, timeoutMs: previous.timeoutMs, routing: previous.routing, routingDecision: previous.routingDecision, review: previous.review };
      assertRequestExecutionPolicy(request, run);
      entry = manage({ ...run, writerLease: undefined, runnerPid: undefined, childPid: undefined }, request);
    }
    assertRequestExecutionPolicy(entry.request, entry.run);
    await persistCompletion(runDirectory(runId), entry.run);
    entry.request.prompt = message;
    beginTurn(entry);
    await save(entry);
    startExecution(entry);
    return { run: structuredClone(entry.run), delivery: "resumed" };
  });
}

async function stopOwned(entry: ManagedRun, status: RunStatus = "已停止", error?: string): Promise<PersistedRun> {
  const wasBusy = entry.busy || !isTerminalStatus(entry.run.status);
  if (wasBusy && !entry.busy) entry.busy = true;
  if (entry.run.status === "排队中" && status === "已停止") status = "已取消";
  entry.abort.abort();
  entry.ready = false;
  entry.messages = [];
  clearTimeout(entry.timer);
  clearTimeout(entry.writerWait);
  entry.run.stopRequested = true;
  if (wasBusy) entry.run.status = "停止中";
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
  entry.run.pendingQuestion = undefined;
  if (wasBusy) await finish(entry, status, error);
  else await save(entry);
  return structuredClone(entry.run);
}

export async function stopRun(runId: string): Promise<PersistedRun> {
  return withFileMutationQueue(`${runDirectory(runId)}/input`, async () => {
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
    await entry.writes;
    owned.delete(entry.run.runId);
  }));
}

export async function continueRun(runId: string, message: string): Promise<PersistedRun> {
  return (await sendToRun(runId, message)).run;
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
