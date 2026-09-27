import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { adaptStoredRun, atomicJson } from "./persistence.mjs";
import type { PersistedRun } from "./types.ts";

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
  runCache.delete(filePath);
}

function parentIndex(parent: string): string {
  return path.join(getAgentDir(), "agent-deck", "parents", createHash("sha256").update(parent).digest("hex"));
}
export async function registerParentIdentity(parentSessionId: string, runId: string): Promise<void> {
  const directory = parentIndex(parentSessionId);
  await fs.promises.mkdir(directory, { recursive: true });
  await fs.promises.writeFile(path.join(directory, runId), "");
}

export async function discardStoredRun(runId: string, parentSessionId: string): Promise<void> {
  const directory = runDirectory(runId);
  runCache.delete(path.join(directory, "status.json"));
  const marker = path.join(parentIndex(parentSessionId), runId);
  const results = await Promise.allSettled([
    fs.promises.rm(directory, { recursive: true, force: true }),
    fs.promises.unlink(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    }),
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length) throw new AggregateError(failures.map((failure) => failure.reason), `无法清理未完成的任务 ${runId}`);
}

export async function readStoredRun(runId: string, strict = false): Promise<PersistedRun | undefined> {
  try {
    const file = statusPath(runId);
    const stat = await fs.promises.stat(file);
    const cached = runCache.get(file);
    if (cached && cached.mtime === stat.mtimeMs && cached.size === stat.size) return structuredClone(cached.run);
    const run = adaptStoredRun(JSON.parse(await fs.promises.readFile(file, "utf8")));
    if (runCache.size >= 500) runCache.delete(runCache.keys().next().value!);
    runCache.set(file, { mtime: stat.mtimeMs, size: stat.size, run: structuredClone(run) });
    return run;
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`无法读取任务记录 ${runId}，请先修复记录：${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

export async function readRunFresh(runId: string, strict = false): Promise<PersistedRun | undefined> {
  try { return adaptStoredRun(JSON.parse(await fs.promises.readFile(statusPath(runId), "utf8"))); }
  catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`无法读取任务记录 ${runId}，请先修复记录：${error instanceof Error ? error.message : error}`);
    return undefined;
  }
}

const runCache = new Map<string, { mtime: number; size: number; run: PersistedRun }>();

export async function listStoredRuns(limit = 50, parentSessionId?: string, strict = Boolean(parentSessionId), read: typeof readStoredRun = readStoredRun): Promise<PersistedRun[]> {
  try {
    let ids: string[];
    if (parentSessionId) {
      const index = parentIndex(parentSessionId);
      const marker = path.join(index, ".indexed-v2");
      try { await fs.promises.access(marker); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Build the parent index from raw identity first. A relevant unknown
        // version is indexed and then rejected explicitly; a damaged record
        // prevents the marker so repairing it can never leave it hidden forever.
        let scanError: unknown;
        let scanIncomplete = false;
        const entries = await fs.promises.readdir(runsRoot(), { withFileTypes: true }).catch((failure) => {
          if ((failure as NodeJS.ErrnoException).code === "ENOENT") return [];
          throw failure;
        });
        for (const item of entries.filter((item) => item.isDirectory())) {
          let raw: any;
          try {
            raw = JSON.parse(await fs.promises.readFile(statusPath(item.name), "utf8"));
          } catch (failure) {
            // A damaged record cannot be attributed to this parent from its
            // contents. Do not block an unrelated parent, but also do not
            // write the scan marker so repairing the record makes it visible.
            scanIncomplete = true;
            continue;
          }
          if (raw?.parentSessionId !== parentSessionId) continue;
          try {
            await registerParentIdentity(parentSessionId, item.name);
            adaptStoredRun(raw);
          } catch (failure) {
            scanError ??= new Error(`无法索引任务记录 ${item.name}：${failure instanceof Error ? failure.message : failure}`);
          }
        }
        await fs.promises.mkdir(index, { recursive: true });
        if (!scanError && !scanIncomplete) await fs.promises.writeFile(marker, "1");
        else if (scanError && strict) throw scanError;
      }
      ids = (await fs.promises.readdir(index)).filter((name) => !name.startsWith("."));
    } else ids = (await fs.promises.readdir(runsRoot(), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const runs = (await Promise.all(ids.map((id) => read(id, strict))))
      .filter((item): item is PersistedRun => Boolean(item) && (!parentSessionId || item?.parentSessionId === parentSessionId));
    return runs.sort((a, b) => (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt)).slice(0, limit);
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return [];
  }
}
