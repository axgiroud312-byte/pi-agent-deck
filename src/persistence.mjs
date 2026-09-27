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
  await atomicText(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
async function atomicText(file, content, options = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", mode: options.mode ?? 0o666 });
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
    ...(version >= 3 || stored.pendingQuestion === undefined ? {} : { pendingQuestion: stored.pendingQuestion }),
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
  if (version < 3) delete stored.pendingQuestion;
  for (const key of ["agentId", "autoDeliver", "planContext", "batchId", "phase", "acceptanceCriteria", "writerLease", "reports", "background", "result", "resultCompleteness", "toolEvidence", "writePermission", "effectiveConfig"]) delete stored[key];
  return stored;
}

export function completionId(run) {
  return `${run.runId}:${run.turnId ?? run.attemptStartedAt ?? run.startedAt}:${run.endedAt}:${run.status}`;
}
function completionRecordId(run) {
  return `${run.runId}:${run.turnId ?? run.attemptStartedAt ?? run.startedAt}`;
}
/** Complete model-authored output and operational evidence, shared by files and notices. */
export function completionOutput(run) {
  // Legacy reports describe a v1/v2 execution. A resumed v3 turn owns its final text.
  const report = run.version < 3
    ? [...(run.legacy?.reports ?? [])].reverse().find((item) => item.type === "最终" || (run.status === "等待决定" && item.type === "问题" && item.blocking))
    : undefined;
  const text = report
    ? [report.summary, report.question, ...(report.evidence ?? []), ...(report.tests ?? []), ...(report.risks ?? [])].filter(Boolean).join("\n")
    : run.finalText;
  const failed = ["失败", "失联", "已停止", "已取消", "停止未确认"].includes(run.status);
  const reason = [run.failureReason, run.stderr, ...(run.events ?? []).filter((event) => event.kind === "错误").map((event) => event.text)]
    .filter((value, index, all) => value && all.indexOf(value) === index).join("；");
  return [
    failed ? `运行原因：${reason || (run.status === "已停止" ? "执行被停止" : "未记录具体原因")}` : reason ? `运行记录：${reason}` : undefined,
    run.persistenceError ? `保存记录：${run.persistenceError}` : undefined,
    text ?? "（子 Agent 正常结束，但没有输出文本。）",
  ].filter((item) => item !== undefined).join("\n\n");
}
async function writeCompletionArtifacts(file, snapshot) {
  const reportPath = path.resolve(file.replace(/\.json$/, ".md"));
  const title = snapshot.description || snapshot.objective || snapshot.runId;
  const report = `# ${title}\n\n任务：${snapshot.runId}\n\n执行轮次：${snapshot.turnId ?? snapshot.attemptStartedAt ?? snapshot.startedAt}\n\n运行状态：${snapshot.status}\n\n${completionOutput(snapshot)}\n`;
  // The notification path is published only after both durable artifacts succeed.
  await atomicText(reportPath, report);
  await atomicJson(file, { ...snapshot, reportPath });
  completionCache.delete(path.dirname(file));
  return reportPath;
}
/** Reuse a turn's original filename, including records named by an older status. */
async function findCompletionRecord(root, run, file, overwrite) {
  const legacyFile = path.join(root, `${createHash("sha256").update(completionId(run)).digest("hex")}.json`);
  const candidates = [...new Set([file, legacyFile])];
  for (const candidate of candidates) {
    try {
      if (overwrite) { await fs.access(candidate); return { file: candidate }; }
      return { file: candidate, snapshot: await readJson(candidate) };
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // A failed rewrite may have changed the status used in an old filename.
  // Normal new turns need no history scan.
  if (!run.persistenceError) return;
  let names;
  try { names = await fs.readdir(root); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const name of names.filter(name => name.endsWith(".json"))) {
    const candidate = path.join(root, name);
    if (candidates.includes(candidate)) continue;
    const snapshot = await readJson(candidate);
    if (completionRecordId(snapshot) === completionRecordId(run)) return { file: candidate, snapshot };
  }
}
export async function persistCompletion(directory, run, options = {}) {
  if (!["已完成", "失败", "已取消", "已停止", "失联", "等待决定"].includes(run.status)) return;
  const root = path.join(directory, "results");
  // A turn has one durable result record even if cleanup changes its final
  // operational status. Notification identity remains status-specific above.
  const preferred = path.join(root, `${createHash("sha256").update(completionRecordId(run)).digest("hex")}.json`);
  const existing = await findCompletionRecord(root, run, preferred, options.overwrite);
  const file = existing?.file ?? preferred;
  if (existing && !options.overwrite) {
    const reportPath = path.resolve(file.replace(/\.json$/, ".md"));
    if (existing.snapshot.reportPath === reportPath) {
      try {
        if ((await fs.stat(reportPath)).isFile()) return reportPath;
      } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    // Old JSON-only results gain a readable copy on explicit persistence;
    // the saved turn's text remains authoritative over a later caller snapshot.
    return writeCompletionArtifacts(file, existing.snapshot);
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
  return writeCompletionArtifacts(file, snapshot);
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
