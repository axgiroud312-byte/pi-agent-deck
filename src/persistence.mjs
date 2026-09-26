import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}
export async function readJson(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function atomicJson(file, value, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: options.mode ?? 0o666 });
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temporary, file); break; }
      catch (error) {
        if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
      }
    }
  } finally { await fs.rm(temporary, { force: true }); }
}

const OWNER_WRITE_GRACE_MS = 1000;

async function observeLock(directory) {
  let stat;
  try { stat = await fs.stat(directory); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  let owner;
  try { owner = await readJson(path.join(directory, "owner.json")); }
  catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
  return { owner, mtimeMs: stat.mtimeMs };
}

function isStaleLock(observed) {
  if (observed.owner?.pid) return !alive(observed.owner.pid);
  return Date.now() - observed.mtimeMs >= OWNER_WRITE_GRACE_MS;
}

async function retireObservedLock(directory, observed) {
  const current = await observeLock(directory);
  if (!current || !isStaleLock(current)) return false;
  const unchanged = observed.owner?.token
    ? current.owner?.token === observed.owner.token
    : !current.owner?.token && current.mtimeMs === observed.mtimeMs;
  if (!unchanged) return false;
  const retired = `${directory}.retired-${randomUUID()}`;
  try { await fs.rename(directory, retired); }
  catch (error) { if (["EEXIST", "ENOENT"].includes(error.code)) return false; throw error; }
  await fs.rm(retired, { recursive: true, force: true });
  return true;
}

async function createOwnedLock(directory, token) {
  await fs.mkdir(directory);
  try { await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token })); }
  catch (error) { await fs.rm(directory, { recursive: true, force: true }); throw error; }
}

async function releaseOwnedLock(directory, token) {
  const observed = await observeLock(directory);
  if (observed?.owner?.token === token) await fs.rm(directory, { recursive: true, force: true });
}

// A short cross-process lock. Dead or interrupted-owner recovery is serialized
// and rechecks both ownership and age before retiring the lock directory.
export async function withDiskLock(directory, action) {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + 10000;
  const token = randomUUID();
  const recovery = `${directory}.recovery`;
  while (true) {
    const recovering = await observeLock(recovery);
    if (recovering) {
      if (isStaleLock(recovering)) await retireObservedLock(recovery, recovering);
    } else {
      try {
        await createOwnedLock(directory, token);
        break;
      } catch (error) { if (error.code !== "EEXIST") throw error; }
      const observed = await observeLock(directory);
      if (observed && isStaleLock(observed)) {
        let held = false;
        try {
          await createOwnedLock(recovery, token); held = true;
          const current = await observeLock(directory);
          if (current && isStaleLock(current)) await retireObservedLock(directory, current);
        } catch (error) { if (!["EEXIST", "ENOENT"].includes(error.code)) throw error; }
        finally { if (held) await releaseOwnedLock(recovery, token); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`本地文件更新锁忙或记录不完整，请稍后重试：${directory}`);
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
  }
  try { return await action(); }
  finally { await releaseOwnedLock(directory, token); }
}

/** Central compatibility boundary for both status files and completion snapshots. */
export function adaptStoredRun(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("任务记录不是对象");
  const stored = structuredClone(raw);
  const version = stored.version ?? 1;
  if (![1, 2, 3].includes(version)) throw new Error(`不支持的任务记录版本：${String(version)}`);
  if (typeof stored.runId !== "string" || !stored.runId) throw new Error("任务记录缺少 runId");
  const roleId = version === 1 ? stored.agentId ?? stored.roleId : stored.roleId;
  if (typeof roleId !== "string" || !roleId) throw new Error("任务记录缺少角色标识");
  stored.version = version;
  stored.roleId = roleId;
  const savedConfig = stored.effectiveConfig && typeof stored.effectiveConfig === "object" ? stored.effectiveConfig : {};
  stored.tools = Array.isArray(stored.tools) ? stored.tools : Array.isArray(savedConfig.tools) ? savedConfig.tools : undefined;
  stored.disallowedTools = Array.isArray(stored.disallowedTools) ? stored.disallowedTools : Array.isArray(savedConfig.disallowedTools) ? savedConfig.disallowedTools : [];
  stored.extensions = Array.isArray(stored.extensions) ? stored.extensions : Array.isArray(savedConfig.extensions) ? savedConfig.extensions : [];
  stored.deliveryMode ??= stored.background === false || stored.autoDeliver === false ? "foreground" : "background";
  stored.cwd ??= "";
  stored.events ??= [];
  stored.usage ??= {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const reports = (stored.legacy?.reports ?? stored.reports ?? []).map((report) => ({
    ...report,
    acceptanceCriteria: report.acceptanceCriteria ?? [], evidence: report.evidence ?? [], completed: report.completed ?? [],
    deliverables: report.deliverables ?? [], filesRead: report.filesRead ?? [], filesChanged: report.filesChanged ?? [],
    fileChanges: report.fileChanges ?? [], designDecisions: report.designDecisions ?? [], commands: report.commands ?? [],
    tests: report.tests ?? [], risks: report.risks ?? [], unknowns: report.unknowns ?? [], downstreamNotes: report.downstreamNotes ?? [],
    recommendations: report.recommendations ?? [], options: report.options ?? [], blocking: report.blocking ?? false,
  }));
  const legacy = {
    ...(stored.legacy ?? {}),
    ...(stored.agentId === undefined ? {} : { agentId: stored.agentId }),
    ...(stored.pendingQuestion === undefined ? {} : { pendingQuestion: stored.pendingQuestion }),
    ...(stored.autoDeliver === undefined ? {} : { autoDeliver: stored.autoDeliver }),
    ...(stored.planContext === undefined ? {} : { planContext: stored.planContext }),
    ...(stored.batchId === undefined ? {} : { batchId: stored.batchId }),
    ...(stored.phase === undefined ? {} : { phase: stored.phase }),
    ...(stored.acceptanceCriteria === undefined ? {} : { acceptanceCriteria: stored.acceptanceCriteria }),
    ...(stored.writerLease === undefined ? {} : { writerLease: stored.writerLease }),
    ...(reports.length ? { reports } : {}),
    ...(stored.result === undefined ? {} : { structuredResult: stored.result }),
    ...(stored.resultCompleteness === undefined ? {} : { resultCompleteness: stored.resultCompleteness }),
    ...(stored.toolEvidence === undefined ? {} : { toolEvidence: stored.toolEvidence }),
    ...(stored.writePermission === undefined ? {} : { writePermission: stored.writePermission === true }),
  };
  if (Object.keys(legacy).length) stored.legacy = legacy;
  for (const key of ["agentId", "pendingQuestion", "autoDeliver", "planContext", "batchId", "phase", "acceptanceCriteria", "writerLease", "reports", "background", "result", "resultCompleteness", "toolEvidence", "writePermission", "effectiveConfig"]) delete stored[key];
  return stored;
}

export function completionId(run) {
  return `${run.runId}:${run.turnId ?? run.attemptStartedAt ?? run.startedAt}:${run.endedAt}:${run.status}`;
}
function completionRecordId(run) {
  return `${run.runId}:${run.turnId ?? run.attemptStartedAt ?? run.startedAt}`;
}
export async function persistCompletion(directory, run, options = {}) {
  if (!["已完成", "失败", "已取消", "已停止", "失联", "等待决定"].includes(run.status)) return;
  const root = path.join(directory, "results");
  // A turn has one durable result record even if cleanup changes its final
  // operational status. Notification identity remains status-specific above.
  const file = path.join(root, `${createHash("sha256").update(completionRecordId(run)).digest("hex")}.json`);
  if (!options.overwrite) {
    const legacyFile = path.join(root, `${createHash("sha256").update(completionId(run)).digest("hex")}.json`);
    for (const existing of [file, legacyFile]) {
      try { await fs.access(existing); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
  }
  const snapshot = {
    version: run.version ?? 1, runId: run.runId, parentSessionId: run.parentSessionId, turnId: run.turnId,
    roleId: run.roleId, agentName: run.agentName, agentSource: run.agentSource, instanceName: run.instanceName,
    description: run.description, objective: run.objective, instruction: run.instruction, status: run.status,
    model: run.model, thinking: run.thinking, routing: run.routing, routingPending: run.routingPending,
    attemptStartedAt: run.attemptStartedAt, startedAt: run.startedAt, endedAt: run.endedAt,
    parentSessionPath: run.parentSessionPath, childSessionId: run.childSessionId, childSessionPath: run.childSessionPath, cwd: run.cwd,
    deliveryMode: run.deliveryMode ?? (run.background === false ? "foreground" : "background"),
    finalText: run.finalText, stderr: run.stderr, tools: run.tools, disallowedTools: run.disallowedTools ?? [],
    extensions: run.extensions ?? [],
    ...(run.legacy ? { legacy: run.legacy } : {}),
    completionSource: run.completionSource,
    failureReason: run.failureReason, persistenceError: run.persistenceError, resourceState: run.resourceState,
    usage: structuredClone(run.usage),
    events: (run.events ?? []).filter((event) => event.kind === "错误"),
  };
  await atomicJson(file, snapshot);
  completionCache.delete(root);
}
const completionCache = new Map();
export async function readCompletions(directory) {
  const root = path.join(directory, "results");
  let names;
  let mtime;
  try { mtime = (await fs.stat(root)).mtimeMs; } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const cached = completionCache.get(root);
  if (cached?.mtime === mtime) return [...cached.results];
  try { names = await fs.readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const results = await Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => adaptStoredRun(await readJson(path.join(root, name)))));
  results.sort((a, b) => a.endedAt - b.endedAt);
  if (completionCache.size >= 500) completionCache.delete(completionCache.keys().next().value);
  completionCache.set(root, { mtime, results });
  return [...results];
}
