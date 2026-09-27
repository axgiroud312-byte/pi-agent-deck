import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { RunDetails, RunStatus, CurrentRunStatus, CurrentExecution, PersistedRun } from "./types.ts";
import { selectExecution, applyExecutionArgs, type RoutingPlan, type RoutingDecision } from "./router.mjs";
import { adaptStoredRun, persistCompletion, withDiskLock } from "./persistence.mjs";
export { adaptStoredRun } from "./persistence.mjs";
import { buildTaskText, childRuntimeRules } from "./instruction.ts";
import { runDirectory, statusPath, writeJsonAtomic, registerParentIdentity, discardStoredRun, readStoredRun, readRunFresh, listStoredRuns } from "./run-store.ts";
export { runsRoot, runDirectory, statusPath, writeJsonAtomic } from "./run-store.ts";
export type { PersistedRun } from "./types.ts";
import { RpcConnection } from "./rpc-connection.ts";
import { parseParentMessage, type ParentMessage } from "./parent-messaging.ts";
import { addressedMessage, consumeMessages, inputMessageIds, messageIds, readMessages, recordMessage, reconcileMessages, settleMessages, submitMessages, type MessageRecord } from "./message-store.ts";

export interface RunnerRequest {
  version: 1 | 2 | 3;
  cwd: string;
  command: string;
  argsPrefix: string[];
  /** Execution input may include queued supplements; RunDetails.instruction is the assignment alone. */
  prompt: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  routing?: RoutingPlan;
  routingDecision?: RoutingDecision;
}
export type RunNotification = { kind: "state" | "result"; run: PersistedRun }
  | { kind: "message"; run: PersistedRun; message: ParentMessage };
type ManagedRun = {
  run: PersistedRun; request: RunnerRequest; rpc?: RpcConnection; ready: boolean;
  busy: boolean; starting?: Promise<void>; abort: AbortController;
  messages: string[]; serial: number; error?: string; extensionError?: string; interrupted?: boolean;
  liveMessages: any[];
  replies: string[];
  writes: Promise<void>; timer?: NodeJS.Timeout;
  pendingCompletion?: { status: CurrentRunStatus; endedAt: number };
  /** Loaded for control access; shutdown preserves untouched historical records. */
  loadedIdle?: boolean;
};
type ExecutingRun = ManagedRun & { run: CurrentExecution };

function requireCurrentExecution(entry: ManagedRun): asserts entry is ExecutingRun {
  const run = entry.run;
  if (run.version !== 3 || !run.turnId || !run.resourceState || !run.deliveryMode
    || ["排队中", "等待批准"].includes(run.status)) {
    throw new Error("执行需要完整的 v3 轮次；历史记录请先明确 resume。");
  }
}
const owned = new Map<string, ManagedRun>();
const listeners = new Set<(event: RunNotification) => void>();
const TERMINAL = new Set<RunStatus>(["已完成", "失败", "已取消", "已停止", "失联"]);
const emptyUsage = () => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
export const isTerminalStatus = (status: RunStatus): boolean => TERMINAL.has(status);
export function subscribeRunEvents(listener: (event: RunNotification) => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function emit(entry: ManagedRun, kind: "state" | "result"): void {
  notify(entry.run, kind);
}
function notify(run: PersistedRun, kind: "state" | "result"): void {
  const notification = { kind, run: structuredClone(run) };
  for (const listener of listeners) listener(notification);
}
function event(entry: ManagedRun, kind: RunDetails["events"][number]["kind"], text: string): void {
  entry.run.events = [...entry.run.events, { at: Date.now(), kind, text }].slice(-200);
}
function queueSnapshot(entry: ManagedRun, run: PersistedRun): Promise<void> {
  // This count only describes the local buffer. messages.json records durable
  // delivery evidence; the Pi queue is reconciled separately on recovery.
  const snapshot = { ...structuredClone(run), queuedMessageCount: 0 };
  entry.writes = entry.writes.catch(() => {}).then(() => writeJsonAtomic(statusPath(snapshot.runId), snapshot));
  void entry.writes.catch(() => {});
  return entry.writes;
}
function save(entry: ManagedRun): Promise<void> {
  entry.run.updatedAt = Date.now();
  entry.run.queuedMessageCount = entry.messages.length;
  const write = queueSnapshot(entry, entry.run);
  emit(entry, "state");
  return write;
}
function manage(run: PersistedRun, request: RunnerRequest, loadedIdle = false): ManagedRun {
  const entry: ManagedRun = { run, request, ready: false, busy: false, abort: new AbortController(), messages: [], serial: 0, liveMessages: [], replies: [], writes: Promise.resolve(), loadedIdle };
  owned.set(run.runId, entry);
  return entry;
}

export async function initializeRun(details: RunDetails, request: RunnerRequest, background: boolean): Promise<PersistedRun> {
  const directory = runDirectory(details.runId);
  await fs.promises.mkdir(directory, { recursive: true });
  const persisted = adaptStoredRun({ ...details, cwd: details.cwd || request.cwd, deliveryMode: background ? "background" : "foreground", ownerPid: process.pid, attemptStartedAt: details.startedAt, updatedAt: Date.now() });
  await writeJsonAtomic(path.join(directory, "request.json"), request);
  await writeJsonAtomic(path.join(directory, "status.json"), persisted);
  await registerParentIdentity(details.parentSessionId, details.runId);
  manage(persisted, request);
  return persisted;
}

/** Remove only artifacts from a creation attempt that never returned a task. */
export async function discardUninitializedRun(runId: string, parentSessionId: string): Promise<void> {
  owned.delete(runId);
  await discardStoredRun(runId, parentSessionId);
}

export async function readRun(runId: string, strict = false): Promise<PersistedRun | undefined> {
  const live = owned.get(runId);
  return live ? structuredClone(live.run) : readStoredRun(runId, strict);
}

export async function listRuns(limit = 50, parentSessionId?: string, strict = Boolean(parentSessionId)): Promise<PersistedRun[]> {
  return listStoredRuns(limit, parentSessionId, strict, readRun);
}

function rpcArgs(args: string[]): string[] {
  const output: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--mode") { i++; continue; }
    if (args[i] === "--print" || args[i] === "-p") continue;
    // Role tools select work capabilities; the child bridge supplies communication.
    if (args[i] === "--tools") {
      output.push(args[i], [...new Set([...args[++i].split(",").filter(Boolean), "SendMessage"])].join(","));
      continue;
    }
    output.push(args[i]);
  }
  return [...output, "--mode", "rpc"];
}

async function finish(entry: ManagedRun, status: CurrentRunStatus, error?: string, notifyResult = true): Promise<void> {
  if (!entry.busy) return;
  // A steer may be accepted just after Pi settled. Drain it while the same
  // session is still owned, before publishing completion or closing its process.
  if (status === "已完成" && entry.rpc && !entry.abort.signal.aborted && !entry.run.stopRequested) {
    const serial = entry.serial;
    const queued = await entry.rpc.request("clear_queue");
    const pending = [...entry.messages, ...(queued?.steering ?? []), ...(queued?.followUp ?? [])];
    entry.messages = [];
    const state = await entry.rpc.request("get_state");
    if (entry.serial !== serial || state?.isStreaming || state?.isCompacting) {
      entry.messages.push(...pending);
      return; // Pi consumed input during the check; its next settled event owns completion.
    }
    if (pending.length) {
      const records = await readMessages(entry.run.runId);
      const consumed = new Set(records.filter(record => record.state === "consumed").map(record => record.id));
      const remaining = pending.filter(text => !messageIds(text).length || !messageIds(text).every(id => consumed.has(id)));
      if (remaining.length) {
        entry.run.currentAction = "继续处理已接受的补充消息";
        await save(entry);
        await submitMessages(entry.run.runId, remaining.flatMap(messageIds), entry.run.turnId);
        await entry.rpc.request("prompt", { message: remaining.join("\n\n") });
        return;
      }
    }
  }
  entry.busy = false;
  entry.ready = false;
  if (entry.run.pendingQuestion) await settleMessages(entry.run.runId, "to-parent", "closed", "本轮执行已结束，澄清问题停止等待。",
    [`${entry.run.runId}:${entry.run.turnId}:question:${entry.run.pendingQuestion.id}`]).catch(failure => {
      entry.run.persistenceError = `问题状态保存失败：${String(failure)}`;
    });
  entry.run.pendingQuestion = undefined;
  clearTimeout(entry.timer);
  const completion = entry.pendingCompletion ?? { status, endedAt: Date.now() };
  entry.pendingCompletion = completion;
  entry.run.completionSource ??= "execution";
  entry.run.currentAction = "正在保存结果并释放进程";
  if (error) { entry.run.failureReason = error; entry.run.stderr = error; event(entry, "错误", error); }
  entry.run.resourceState = entry.rpc ? "releasing" : "released";
  try { await save(entry); }
  catch (failure) { entry.run.persistenceError = [entry.run.persistenceError, `结果保存失败：${String(failure)}`].filter(Boolean).join("；"); event(entry, "错误", entry.run.persistenceError); }
  const rpc = entry.rpc;
  let closeError: unknown;
  if (rpc) {
    try { await rpc.close(); }
    catch (failure) { closeError = failure; }
  }
  if (closeError) {
    const reason = `进程清理未确认：${String(closeError)}`;
    entry.run.failureReason = [entry.run.failureReason, reason].filter(Boolean).join("；");
    event(entry, "错误", reason);
    entry.run.status = "停止未确认";
    entry.run.resourceState = "releasing";
    entry.run.currentAction = "进程清理未确认；请用 TaskStop 重试";
    // Keep the owned RPC and child PID until close confirms exit.
    try { await save(entry); }
    catch (failure) { entry.run.persistenceError = [entry.run.persistenceError, `状态保存失败：${String(failure)}`].filter(Boolean).join("；"); event(entry, "错误", entry.run.persistenceError); }
  } else {
    if (entry.rpc === rpc) entry.rpc = undefined;
    try {
      await reconcileMessages(entry.run, "to-child");
      if (status !== "已完成") {
        const unsent = (await readMessages(entry.run.runId)).filter(record => record.direction === "to-child" && record.state === "pending" && !record.submittedAt).map(record => record.id);
        if (unsent.length) await settleMessages(entry.run.runId, "to-child", "closed", error ?? `本轮执行${status}`, unsent);
      }
    } catch (failure) { entry.run.persistenceError = `消息消费核对失败：${String(failure)}`; }
    const lateExtensionError = entry.extensionError;
    const completed: PersistedRun = {
      ...entry.run,
      status: entry.run.persistenceError || (completion.status === "已完成" && lateExtensionError) ? "失败" : completion.status,
      resourceState: "released",
      ownerPid: undefined,
      childPid: undefined,
      endedAt: completion.endedAt,
      currentAction: undefined,
      updatedAt: Date.now(),
      queuedMessageCount: entry.messages.length,
    };
    if (completion.status === "已完成" && lateExtensionError) {
      completed.failureReason = [completed.failureReason, lateExtensionError].filter(Boolean).join("；");
      completed.stderr = [completed.stderr, lateExtensionError].filter(Boolean).join("；");
    }
    if (completed.persistenceError) {
      completed.failureReason = [completed.failureReason, `持久化失败：${completed.persistenceError}`].filter(Boolean).join("；");
    }
    const persistenceFailure = (reason: string): void => {
      completed.persistenceError = [completed.persistenceError, reason].filter(Boolean).join("；");
      completed.failureReason = [completed.failureReason, `持久化失败：${reason}`].filter(Boolean).join("；");
      completed.status = "失败";
      completed.events = [...completed.events, { at: Date.now(), kind: "错误" as const, text: reason }].slice(-200);
    };
    // Completion history is attempted before the released terminal state becomes
    // observable through readRun or result events. Foreground and background share
    // this exact path; delivery mode only controls the later notification.
    try { await persistCompletion(runDirectory(entry.run.runId), completed); }
    catch (failure) {
      persistenceFailure(`结果保存失败：${String(failure)}`);
      await persistCompletion(runDirectory(entry.run.runId), completed, { overwrite: true }).catch((retryFailure) => {
        persistenceFailure(`结果保存重试失败：${String(retryFailure)}`);
      });
    }
    // Do not mutate the live object until this write finishes. Foreground
    // waiters read the live object and must receive any persistence failure.
    try { await queueSnapshot(entry, completed); }
    catch (failure) {
      persistenceFailure(`状态保存失败：${String(failure)}`);
      await queueSnapshot(entry, completed).catch((retryFailure) => {
        persistenceFailure(`状态保存重试失败：${String(retryFailure)}`);
      });
      // The first completion snapshot predates this status-write error. Refresh
      // the same turn record so a later resume cannot erase the only evidence.
      try { await persistCompletion(runDirectory(entry.run.runId), completed, { overwrite: true }); }
      catch (historyFailure) {
        persistenceFailure(`完成记录更新失败：${String(historyFailure)}`);
        await queueSnapshot(entry, completed).catch(() => {});
      }
    }
    Object.assign(entry.run, completed);
    entry.pendingCompletion = undefined;
    emit(entry, "state");
  }
  if (notifyResult) notify(entry.run, "result");
}

function inTask<T>(runId: string, action: () => Promise<T>): Promise<T> {
  runDirectory(runId); // validate before the lock helper creates any parent directory
  const control = path.join(getAgentDir(), "agent-deck", "control", `${runId}.lock`);
  // This lock serializes control changes for ONE persisted task across Pi
  // processes. It is not a workspace writer lock, capacity slot or scheduler.
  return withFileMutationQueue(control, () => withDiskLock(control, action));
}

function handleEvent(entry: ExecutingRun, data: any): void {
  if (data.type === "extension_error") {
    const message = `子扩展加载或执行失败：${data.error?.message ?? data.error ?? data.message ?? "未知错误"}`;
    // An extension failure is an operational failure, not a model outcome. A
    // later normal assistant message must not be allowed to erase it.
    entry.extensionError = message;
    event(entry, "错误", message);
    void save(entry);
    return;
  }
  if (data.type === "extension_ui_request") {
    const turnId = entry.run.turnId;
    const rpc = entry.rpc;
    void inTask(entry.run.runId, async () => {
      if (!rpc || entry.rpc !== rpc || entry.run.turnId !== turnId || !entry.busy || entry.abort.signal.aborted) return;
      const message = parseParentMessage(data);
      if (!message) {
        if (["input", "select", "confirm", "editor"].includes(data.method)) await rpc.cancelUiRequest(data.id);
        return;
      }
      await recordMessage(entry.run, "to-parent", message.message, message.waitForReply
        ? `${entry.run.runId}:${turnId}:question:${message.id}` : message.id);
      if (message.waitForReply) {
        if (entry.run.pendingQuestion) throw new Error("已有一个问题正在等待主 Agent 回答。");
        entry.run.pendingQuestion = { id: message.id, message: message.message };
        entry.run.status = "等待决定";
        entry.run.currentAction = "等待主 Agent 回答";
        await save(entry);
        emit(entry, "result");
      } else {
        for (const listener of listeners) listener({ kind: "message", run: structuredClone(entry.run), message });
        await rpc.answerUiRequest(message.id, "queued");
      }
    }).catch((error) => failExecution(entry, turnId, error));
    return;
  }
  if (data.type === "message_end" && ["user", "toolResult"].includes(data.message?.role)) {
    void consumeMessages(entry.run.runId, "to-child", inputMessageIds(data.message)).catch(error => failExecution(entry, entry.run.turnId, error));
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
    event(entry, "工具", entry.run.currentAction!);
    void save(entry);
  } else if (data.type === "tool_execution_end") {
    void save(entry);
  } else if (data.type === "message_end" && data.message?.role === "assistant") {
    const message = data.message;
    const text = typeof message.content === "string" ? message.content : (message.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
    // Steering can add another assistant answer before settled. Keep the whole
    // delivery in order; tool-call narration stays in the native transcript.
    const toolCalls = Array.isArray(message.content) && message.content.some((part: any) => part.type === "toolCall");
    if (text && !toolCalls) entry.replies.push(text);
    entry.run.finalText = entry.replies.join("\n\n---\n\n");
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
      const error = entry.extensionError ?? entry.error;
      await finish(entry, entry.interrupted ? "已停止" : error ? "失败" : "已完成", error);
    }).catch((error) => failExecution(entry, turnId, error));
  }
}

function failExecution(entry: ExecutingRun, turnId: string, error: unknown): void {
  void inTask(entry.run.runId, async () => {
    if (entry.busy && !entry.abort.signal.aborted && entry.run.turnId === turnId) await finish(entry, "失败", error instanceof Error ? error.message : String(error));
  }).catch((failure) => { event(entry, "错误", String(failure)); });
}

function beginTurn(entry: ManagedRun): asserts entry is ExecutingRun {
  if (entry.run.version !== 3) throw new Error("历史记录只能通过明确 resume 开始执行。");
  entry.abort = new AbortController();
  entry.busy = true;
  // The previous process has exited; this turn has not submitted its first prompt.
  entry.ready = false;
  entry.error = undefined;
  entry.extensionError = undefined;
  entry.interrupted = false;
  entry.liveMessages = [];
  entry.replies = [];
  entry.pendingCompletion = undefined;
  Object.assign(entry.run, {
    turnId: randomUUID(), ownerPid: process.pid,
    resourceState: "starting",
    status: entry.request.routing && !entry.request.routingDecision && !entry.request.routing.immediate ? "选配中" : "运行中",
    attemptStartedAt: Date.now(), endedAt: undefined, exitCode: undefined, stderr: undefined,
    finalText: undefined, reportPath: undefined, pendingQuestion: undefined, completionSource: undefined, failureReason: undefined, persistenceError: undefined, events: [], stopRequested: false, currentAction: "正在启动", usage: emptyUsage(),
  });
  requireCurrentExecution(entry);
}

async function execute(entry: ExecutingRun): Promise<void> {
  const turnId = entry.run.turnId;
  const cancelled = () => entry.abort.signal.aborted || entry.run.turnId !== turnId;
  try {
    const request = entry.request;
    if (request.routing && !request.routingDecision) {
      const decision = await selectExecution(request.routing, { signal: entry.abort.signal });
      if (cancelled()) return;
      request.routingDecision = decision;
      request.argsPrefix = applyExecutionArgs(request.argsPrefix, decision);
      Object.assign(entry.run, { model: decision.model, thinking: decision.thinking, routing: decision, routingPending: false });
    }
    if (cancelled()) return;
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
      if (entry.extensionError) throw new Error(entry.extensionError);
      if (cancelled()) return;
      await entry.rpc.request("set_steering_mode", { mode: "all" });
    }
    if (cancelled()) return;
    entry.ready = true;
    const prompt = [request.prompt, ...entry.messages.splice(0)].join("\n\n");
    await submitMessages(entry.run.runId, messageIds(prompt), turnId);
    if (cancelled()) return;
    void save(entry);
    entry.run.currentAction = "子 Agent 正在执行";
    if (request.timeoutMs && request.timeoutMs > 0) entry.timer = setTimeout(() => {
      const rpc = entry.rpc;
      void inTask(entry.run.runId, async () => {
        if (!entry.busy || entry.run.turnId !== turnId || entry.rpc !== rpc) return;
        entry.abort.abort();
        entry.run.status = "停止中";
        await stopOwned(entry, "失败", "任务执行超时；主 Agent 可明确 resume 原任务。", "execution");
      }).catch((error) => { event(entry, "错误", String(error)); });
    }, request.timeoutMs);
    await entry.rpc.request("prompt", { message: prompt });
  } catch (error) {
    if (cancelled()) return;
    failExecution(entry, turnId, error);
  }
}

function startExecution(entry: ExecutingRun): void {
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
    if (!entry.busy) {
      beginTurn(entry);
      try { await save(entry); }
      catch (error) {
        // This failure is returned by the initiating tool call itself. Do not
        // also enqueue a background result notification for the same turn.
        await finish(entry, "失败", `启动状态保存失败：${String(error)}`, false);
        return 0;
      }
    }
    if (!entry.starting && !entry.ready) {
      requireCurrentExecution(entry);
      startExecution(entry);
    }
    return entry.rpc?.child.pid ?? 0;
  });
}

function idleStatus(status: RunStatus): RunStatus {
  return isTerminalStatus(status) || status === "等待决定" ? status : "已停止";
}

async function obtainIdleRun(runId: string): Promise<ManagedRun> {
  const live = owned.get(runId);
  if (live) return refreshOwnedFromDisk(live);
  const run = await readRunFresh(runId, true);
  if (!run) throw new Error("找不到任务");
  if (hasLiveOwner(run)) throw new Error("旧任务仍由另一个 Pi 进程运行，请等待它结束后再继续。");
  const request = JSON.parse(await fs.promises.readFile(path.join(runDirectory(runId), "request.json"), "utf8")) as RunnerRequest;
  await reconcileMessages(run, "to-child");
  const entry = manage({ ...run, status: idleStatus(run.status), runnerPid: undefined, childPid: undefined, resourceState: "released", queuedMessageCount: 0 }, request, true);
  entry.messages = (await readMessages(runId)).filter(record => record.direction === "to-child" && record.state === "pending" && !record.submittedAt)
    .map(record => addressedMessage(record.id, record.text));
  return entry;
}

async function refreshOwnedFromDisk(entry: ManagedRun, allowUnreadableDuringCleanup = false): Promise<ManagedRun> {
  await entry.writes.catch(() => {});
  let stored: PersistedRun | undefined;
  try { stored = await readRunFresh(entry.run.runId, true); }
  catch (error) {
    if (allowUnreadableDuringCleanup && (entry.busy || entry.rpc)) return entry;
    throw error;
  }
  if (!stored) throw new Error("找不到任务");
  if (stored.ownerPid !== process.pid && hasLiveOwner(stored)) {
    throw new Error("任务已由另一个 Pi 进程接管，请在持有当前执行的 Pi 中继续。");
  }
  const drifted = stored.turnId !== entry.run.turnId
    || stored.status !== entry.run.status
    || stored.ownerPid !== entry.run.ownerPid
    || stored.resourceState !== entry.run.resourceState;
  if (!drifted) return entry;
  if (entry.busy || entry.rpc) {
    if (stored.turnId !== entry.run.turnId) throw new Error("任务控制状态与磁盘记录不一致；为避免重复执行，本进程不会继续覆盖。请回到持有当前任务的 Pi。");
    return entry;
  }
  const request = JSON.parse(await fs.promises.readFile(path.join(runDirectory(entry.run.runId), "request.json"), "utf8")) as RunnerRequest;
  entry.run = { ...stored, status: idleStatus(stored.status), runnerPid: undefined, childPid: undefined, resourceState: "released", queuedMessageCount: entry.messages.length };
  entry.request = request;
  entry.ready = false;
  entry.abort = new AbortController();
  return entry;
}

/** One control boundary for steering, answering, and resuming the saved session. */
export async function sendToRun(runId: string, message: string, summary?: string, replyTo?: string, messageId?: string): Promise<{ run: PersistedRun; delivery: "queued" | "answered" | "resumed" | "existing"; messageId: string; messageState: MessageRecord["state"] }> {
  if (!message.trim()) throw new Error("请提供补充要求。");
  if (["停止中", "停止未确认"].includes(owned.get(runId)?.run.status ?? "")) throw new Error("任务正在停止，暂不接受消息。");
  return inTask(runId, async () => {
    const entry = await obtainIdleRun(runId);
    if (["停止中", "停止未确认"].includes(entry.run.status) || (entry.busy && entry.abort.signal.aborted)) throw new Error("任务正在停止，暂不接受消息。");
    if (messageId) {
      const previous = (await readMessages(runId)).find(record => record.id === messageId);
      if (previous) {
        if (previous.direction !== "to-child" || previous.text !== message) throw new Error("消息编号已用于另一条消息");
        return { run: structuredClone(entry.run), delivery: "existing", messageId, messageState: previous.state };
      }
    }
    const question = entry.run.pendingQuestion;
    if (replyTo && (question?.id !== replyTo || !entry.busy)) throw new Error("该问题已结束；请读取当前问题后回答，或发送新的任务要求。");
    const record = await recordMessage(entry.run, "to-child", message, messageId);
    const envelope = addressedMessage(record.id, message);
    try {
      if (entry.busy && question) {
        await submitMessages(runId, [record.id], entry.run.turnId);
        await entry.rpc!.answerUiRequest(question.id, envelope);
        await settleMessages(runId, "to-parent", "closed", "澄清回答已交付。", [`${runId}:${entry.run.turnId}:question:${question.id}`]);
        entry.run.pendingQuestion = undefined;
        entry.run.status = "运行中";
        entry.run.currentAction = "已收到主 Agent 回答，继续执行";
        await save(entry);
        return { run: structuredClone(entry.run), delivery: "answered", messageId: record.id, messageState: "pending" };
      }
      if (entry.busy) {
        if (!entry.ready) entry.messages.push(envelope);
        else {
          await submitMessages(runId, [record.id], entry.run.turnId);
          await entry.rpc!.request("steer", { message: envelope });
        }
        await save(entry);
        return { run: structuredClone(entry.run), delivery: "queued", messageId: record.id, messageState: "pending" };
      }
      return { run: await resumeOwned(entry, envelope, summary, true, message), delivery: "resumed", messageId: record.id, messageState: "pending" };
    } catch (error) {
      const submitted = (await readMessages(runId)).find(item => item.id === record.id)?.submittedAt;
      if (!submitted) {
        entry.messages = entry.messages.filter(text => !messageIds(text).includes(record.id));
        entry.run.queuedMessageCount = entry.messages.length;
      }
      await settleMessages(runId, "to-child", submitted ? "unknown" : "closed", `投递失败：${String(error)}`, [record.id]);
      throw error;
    }
  });
}

/** Compatibility entry point; SendMessage uses the same resume implementation. */
export async function resumeRun(runId: string, prompt: string, description?: string, background = false, expectedTurnId?: string | null): Promise<PersistedRun> {
  if (!prompt.trim()) throw new Error("resume 必须提供本次任务要求。");
  return inTask(runId, async () => {
    const entry = await obtainIdleRun(runId);
    if (expectedTurnId !== undefined && (entry.run.turnId ?? null) !== expectedTurnId) {
      throw new Error(`任务 ${runId} 已进入其他执行轮次；期望 ${expectedTurnId ?? "历史轮次"}，实际 ${entry.run.turnId ?? "历史轮次"}。请读取最新结果后再决定是否续接。`);
    }
    return resumeOwned(entry, prompt, description, background);
  });
}

async function resumeOwned(entry: ManagedRun, prompt: string, description?: string, background = false, instruction = prompt): Promise<PersistedRun> {
  const runId = entry.run.runId;
  const resumable = isTerminalStatus(entry.run.status) || entry.run.status === "等待决定";
  if (entry.busy || !resumable || entry.rpc) throw new Error("任务仍在运行或释放中；补充要求请用 SendMessage，结束后才能 resume。");
  try {
    await entry.starting;
    await fs.promises.access(entry.run.childSessionPath).catch(() => { throw new Error("保存的子会话不存在，无法 resume；请明确新建任务。"); });
    let header: any;
    try { header = JSON.parse((await fs.promises.readFile(entry.run.childSessionPath, "utf8")).split(/\r?\n/, 1)[0]); }
    catch { throw new Error("保存的子会话无法读取，不能创建空白替代；请修复会话或明确新建任务。"); }
    if (header?.type !== "session" || typeof header.id !== "string") throw new Error("保存的子会话缺少有效会话头，无法 resume。");
    const nextRequest = structuredClone(entry.request);
    const nextRun = structuredClone(entry.run);
    nextRun.childSessionId = header.id;
    await persistCompletion(runDirectory(runId), entry.run);
    const toolsAt = nextRequest.argsPrefix.indexOf("--tools");
    if (toolsAt >= 0) {
      const oldTools = nextRequest.argsPrefix[toolsAt + 1].split(",").filter(Boolean);
      const tools = oldTools.filter((tool) => !["agent_question", "agent_report"].includes(tool));
      nextRequest.argsPrefix[toolsAt + 1] = tools.join(",");
      nextRun.tools = tools;
    }
    // Old records migrate only when explicitly resumed. Preserve the saved
    // Pi execution arguments while removing retired internal tools.
    const systemAt = nextRequest.argsPrefix.indexOf("--append-system-prompt");
    let systemUpdate: { file: string; content: string } | undefined;
    if (systemAt >= 0 && path.resolve(nextRequest.argsPrefix[systemAt + 1]) === path.join(runDirectory(runId), "SYSTEM.md")) {
      const file = nextRequest.argsPrefix[systemAt + 1];
      const old = await fs.promises.readFile(file, "utf8");
      systemUpdate = { file, content: old.split("# 统一运行规则")[0] + childRuntimeRules() };
    }
    nextRequest.prompt = [...entry.messages, prompt].join("\n\n");
    nextRequest.version = 3;
    nextRun.version = 3;
    nextRun.deliveryMode = background ? "background" : "foreground";
    if (systemUpdate) await fs.promises.writeFile(systemUpdate.file, systemUpdate.content);
    entry.request = nextRequest;
    Object.assign(entry.run, nextRun);
    entry.messages = [];
    entry.loadedIdle = false;
    beginTurn(entry);
    Object.assign(entry.run, buildTaskText(instruction, description));
    try { await save(entry); }
    catch (error) {
      await finish(entry, "失败", `续接启动失败：${String(error)}`, false);
      return structuredClone(entry.run);
    }
    startExecution(entry);
    return structuredClone(entry.run);
  } catch (error) {
    if (entry.busy) {
      await finish(entry, "失败", `续接启动失败：${String(error)}`, false);
      return structuredClone(entry.run);
    }
    throw error;
  }
}

export function liveConversation(runId: string): any[] { return structuredClone(owned.get(runId)?.liveMessages ?? []); }

async function stopOwned(entry: ManagedRun, status: CurrentRunStatus = "已停止", error?: string, source: "tool-stop" | "panel-stop" | "shutdown" | "execution" = "panel-stop"): Promise<PersistedRun> {
  const wasBusy = entry.busy || !isTerminalStatus(entry.run.status);
  if (wasBusy && !entry.busy) entry.busy = true;
  if (entry.run.status === "排队中" && status === "已停止") status = "已取消";
  entry.abort.abort();
  // A retry may retain the original outcome, but this wake decision belongs to
  // the current caller: TaskStop already has a reply and shutdown must stay quiet.
  if (wasBusy) entry.run.completionSource = source;
  entry.ready = false;
  entry.messages = [];
  clearTimeout(entry.timer);
  entry.run.stopRequested = true;
  await settleMessages(entry.run.runId, "to-child", "closed", source === "execution" ? error ?? "执行已停止" : `任务停止：${source}`).catch(failure => {
    entry.run.persistenceError = `消息取消记录失败：${String(failure)}`;
  });
  if (wasBusy) { entry.run.status = "停止中"; await save(entry).catch((error) => { entry.run.persistenceError = String(error); }); }
  if (entry.rpc) {
    try {
      if (entry.run.pendingQuestion) await entry.rpc.cancelUiRequest(entry.run.pendingQuestion.id);
      await entry.rpc.request("clear_queue");
      await entry.rpc.request("abort", {}, 3000);
    } catch { /* Closing the owned process is the final cancellation boundary. */ }
  }
  entry.ready = false;
  if (wasBusy) await finish(entry, status, error);
  else await save(entry).catch((error) => { entry.run.persistenceError = String(error); });
  return structuredClone(entry.run);
}

export async function stopRun(runId: string, source: "tool-stop" | "panel-stop" | "shutdown" = "panel-stop", expectedTurnId?: string | null): Promise<PersistedRun> {
  return inTask(runId, async () => {
    const entry = owned.get(runId);
    if (entry) {
      await refreshOwnedFromDisk(entry, true);
      if (expectedTurnId !== undefined && (entry.run.turnId ?? null) !== expectedTurnId) throw new Error(`任务 ${runId} 已进入其他执行轮次；期望 ${expectedTurnId ?? "历史轮次"}，实际 ${entry.run.turnId ?? "历史轮次"}。`);
      if (!entry.busy && !entry.rpc && isTerminalStatus(entry.run.status)) {
        entry.messages = [];
        await settleMessages(runId, "to-child", "closed", `任务停止：${source}`);
        entry.run.queuedMessageCount = 0;
        return structuredClone(entry.run);
      }
      return stopOwned(entry, "已停止", undefined, source);
    }
    const run = await readRunFresh(runId, true);
    if (!run) throw new Error("找不到任务");
    if (expectedTurnId !== undefined && (run.turnId ?? null) !== expectedTurnId) throw new Error(`任务 ${runId} 已进入其他执行轮次；期望 ${expectedTurnId ?? "历史轮次"}，实际 ${run.turnId ?? "历史轮次"}。`);
    if (isTerminalStatus(run.status) && !hasLiveOwner(run)) {
      await reconcileMessages(run, "to-child");
      await settleMessages(runId, "to-child", "closed", `任务停止：${source}`);
      return run;
    }
    if (hasLiveOwner(run)) throw new Error("任务由另一个 Pi 进程管理，请在原 Pi 中停止。");
    await reconcileMessages(run, "to-child");
    await settleMessages(runId, "to-child", "closed", `任务停止：${source}`);
    if (run.pendingQuestion) await settleMessages(runId, "to-parent", "closed", `问题随任务停止：${source}`,
      [`${runId}:${run.turnId}:question:${run.pendingQuestion.id}`]);
    const stopped: PersistedRun = {
      ...run, status: isTerminalStatus(run.status) ? run.status : "已停止", completionSource: source,
      resourceState: "released",
      ownerPid: undefined, runnerPid: undefined, childPid: undefined, currentAction: undefined,
      pendingQuestion: undefined,
      endedAt: run.endedAt ?? Date.now(), updatedAt: Date.now(), queuedMessageCount: 0,
    };
    await persistCompletion(runDirectory(runId), stopped);
    await writeJsonAtomic(statusPath(runId), stopped);
    return stopped;
  });
}

export async function shutdownRuns(parentSessionId?: string): Promise<void> {
  await Promise.all([...owned.values()].filter((entry) => !parentSessionId || entry.run.parentSessionId === parentSessionId).map(async (entry) => {
    // Historical records opened for a control request have no process to clean
    // up. Dropping an untouched record preserves its original format.
    if (!entry.busy && !entry.rpc && (entry.loadedIdle || isTerminalStatus(entry.run.status))) {
      owned.delete(entry.run.runId);
      return;
    }
    await stopRun(entry.run.runId, "shutdown");
    await entry.starting;
    await entry.writes.catch(() => {});
    if (entry.run.resourceState === "released") owned.delete(entry.run.runId);
  }));
}

function isProcessAlive(pid?: number): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function hasLiveOwner(run: PersistedRun): boolean {
  const liveProcess = isProcessAlive(run.runnerPid) || isProcessAlive(run.childPid);
  const terminalReleased = isTerminalStatus(run.status) && run.resourceState === "released";
  return liveProcess || (!terminalReleased && isProcessAlive(run.ownerPid));
}
export async function reconcileRun(runId: string): Promise<PersistedRun | undefined> {
  return inTask(runId, async () => {
    const local = owned.get(runId);
    if (local) return structuredClone((await refreshOwnedFromDisk(local)).run);
    const run = await readRunFresh(runId);
    // Historical v1/v2 records are read-only on startup. An explicit resume performs
    // the one-task migration after validating its saved session and request.
    if (!run || run.version < 3 || hasLiveOwner(run)) return run;
    await reconcileMessages(run, "to-child");
    if (run.pendingQuestion) await settleMessages(runId, "to-parent", "closed", "原子进程已结束，问题无法继续等待。",
      [`${runId}:${run.turnId}:question:${run.pendingQuestion.id}`]);
    if (isTerminalStatus(run.status) && run.resourceState === "released" && !run.childPid && !run.runnerPid) return run;
    const lost: PersistedRun = {
      ...run,
      status: isTerminalStatus(run.status) ? run.status : "失联",
      resourceState: "released", ownerPid: undefined, runnerPid: undefined, childPid: undefined,
      failureReason: run.failureReason ?? (isTerminalStatus(run.status) ? undefined : "宿主进程已不存在，启动核对将任务标记为失联。"),
      currentAction: undefined, updatedAt: Date.now(), endedAt: run.endedAt ?? Date.now(), queuedMessageCount: 0,
      pendingQuestion: undefined,
    };
    await persistCompletion(runDirectory(runId), lost);
    await writeJsonAtomic(statusPath(runId), lost);
    return lost;
  });
}
export async function reconcileRuns(parentSessionId?: string): Promise<PersistedRun[]> {
  const runs = await listRuns(Number.MAX_SAFE_INTEGER, parentSessionId, Boolean(parentSessionId));
  for (const run of runs) await reconcileRun(run.runId);
  return listRuns(50, parentSessionId, Boolean(parentSessionId));
}
export async function waitForRunTurn(runId: string, turnId: string, options: { signal?: AbortSignal; onUpdate?: (run: PersistedRun) => void; pollMs?: number; stopOnAbort?: boolean } = {}): Promise<PersistedRun> {
  let updated = -1;
  while (true) {
    if (options.signal?.aborted) {
      if (options.stopOnAbort) return stopRun(runId, "panel-stop", turnId);
      throw new Error(`已取消等待；Agent ${runId} 仍在后台运行`);
    }
    const run = await readRun(runId);
    if (!run) throw new Error(`找不到任务：${runId}`);
    if (run.turnId !== turnId) throw new Error(`任务 ${runId} 已进入其他执行轮次；期望 ${turnId}，实际 ${run.turnId ?? "无"}。`);
    if (run.updatedAt !== updated) { updated = run.updatedAt; options.onUpdate?.(run); }
    if (isTerminalStatus(run.status) || run.status === "停止未确认") return run;
    if (run.pendingQuestion) {
      const waiting = await inTask(runId, async () => {
        const entry = owned.get(runId);
        if (!entry || entry.run.turnId !== turnId || entry.run.pendingQuestion?.id !== run.pendingQuestion?.id) return;
        // The foreground tool returns the question so its caller can answer.
        // Subsequent questions and the final result use background delivery.
        entry.run.deliveryMode = "background";
        await save(entry);
        return structuredClone(entry.run);
      });
      if (waiting) return waiting;
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 100));
  }
}
