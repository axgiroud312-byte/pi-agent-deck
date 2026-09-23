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

// A short cross-process lock. Dead-owner recovery is serialized and rechecks ownership.
export async function withDiskLock(directory, action) {
  await fs.mkdir(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + 10000;
  const token = randomUUID();
  const recovery = `${directory}.recovery`;
  while (true) {
    let recovering = false;
    try { await fs.access(recovery); recovering = true; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!recovering) {
      try {
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token }));
        break;
      } catch (error) { if (error.code !== "EEXIST") throw error; }
      let owner;
      try { owner = await readJson(path.join(directory, "owner.json")); } catch { /* A creator may still be writing. */ }
      if (owner?.pid && !alive(owner.pid)) {
        let held = false;
        try {
          await fs.mkdir(recovery); held = true;
          const current = await readJson(path.join(directory, "owner.json"));
          if (current.token === owner.token && !alive(current.pid)) {
            const retired = `${directory}.retired-${randomUUID()}`;
            await fs.rename(directory, retired);
            await fs.rm(retired, { recursive: true, force: true });
          }
        } catch (error) { if (!["EEXIST", "ENOENT"].includes(error.code)) throw error; }
        finally { if (held) await fs.rmdir(recovery); }
        continue;
      }
    }
    if (Date.now() >= deadline) throw new Error(`任务调度锁忙或记录不完整，请稍后重试：${directory}`);
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 30));
  }
  try { return await action(); }
  finally {
    const owner = await readJson(path.join(directory, "owner.json"));
    if (owner.token === token) await fs.rm(directory, { recursive: true, force: true });
  }
}

export function completionId(run) {
  return `${run.runId}:${run.turnId ?? run.attemptStartedAt ?? run.startedAt}:${run.pendingQuestion?.id ?? run.endedAt}:${run.status}`;
}
export async function persistCompletion(directory, run) {
  if (!run.autoDeliver || !["已完成", "失败", "已取消", "已停止", "失联", "等待决定"].includes(run.status)) return;
  const deliveryId = completionId(run);
  const file = path.join(directory, "results", `${createHash("sha256").update(deliveryId).digest("hex")}.json`);
  try { await fs.access(file); return; } catch (error) { if (error.code !== "ENOENT") throw error; }
  const snapshot = {
    autoDeliver: true, runId: run.runId, parentSessionId: run.parentSessionId, turnId: run.turnId,
    agentId: run.agentId, agentName: run.agentName, instanceName: run.instanceName,
    description: run.description, objective: run.objective, status: run.status,
    model: run.model, thinking: run.thinking, routing: run.routing, routingPending: run.routingPending,
    attemptStartedAt: run.attemptStartedAt, startedAt: run.startedAt, endedAt: run.endedAt,
    reports: run.reports ?? [], finalText: run.finalText, stderr: run.stderr,
    events: (run.events ?? []).filter((event) => event.kind === "错误").slice(-1),
  };
  await atomicJson(file, snapshot);
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
  const results = await Promise.all(names.filter((name) => name.endsWith(".json")).map((name) => readJson(path.join(root, name))));
  results.sort((a, b) => a.endedAt - b.endedAt);
  if (completionCache.size >= 500) completionCache.delete(completionCache.keys().next().value);
  completionCache.set(root, { mtime, results });
  return [...results];
}

export async function releaseCapacity(lease) {
  if (!lease) return;
  try {
    const file = path.join(lease.directory, `${lease.token}.json`);
    const current = await readJson(file);
    if (current.token === lease.token) await fs.unlink(file);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}

export async function releaseWriter(lease) {
  if (!lease?.leasePath || !lease.ownerToken) return false;
  const root = path.dirname(path.dirname(lease.leasePath));
  return withDiskLock(path.join(root, "writers.lock"), async () => {
    let current;
    try { current = await readJson(path.join(lease.leasePath, "lease.json")); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (current.runId !== lease.runId || current.ownerToken !== lease.ownerToken) return false;
    const retired = `${lease.leasePath}.retired-${randomUUID()}`;
    await fs.rename(lease.leasePath, retired);
    await fs.rm(retired, { recursive: true, force: true });
    return true;
  });
}
