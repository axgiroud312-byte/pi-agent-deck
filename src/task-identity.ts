import * as path from "node:path";
import { createHash } from "node:crypto";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { withDiskLock } from "./persistence.mjs";
import { listRuns, readRun, type PersistedRun } from "./runtime.ts";
import { validateInstanceName } from "./tool-contract.ts";

/** The persisted run is the name binding. Serialize name checking through initialization. */
export async function withTaskCreation<T>(parent: string, name: string | undefined, create: () => Promise<T>): Promise<T> {
  if (name !== undefined) validateInstanceName(name);
  const lock = path.join(getAgentDir(), "agent-deck", "creation", `${createHash("sha256").update(parent).digest("hex")}.lock`);
  return withFileMutationQueue(lock, () => withDiskLock(lock, async () => {
    if (name && (await listRuns(Number.MAX_SAFE_INTEGER, parent, true)).some((run) => run.instanceName?.toLowerCase() === name.toLowerCase())) throw new Error(`当前会话已有名为“${name}”的任务；请用 SendMessage 继续，或为新任务选择另一个 name。`);
    return create();
  }));
}

export async function resolveTaskTarget(target: string, parent: string): Promise<PersistedRun> {
  if (!target.trim()) throw new Error("请提供当前会话的任务 ID 或实例名称。");
  target = target.trim();
  // Historical IDs are also accepted, but arbitrary paths never reach the run store.
  const byId = /^[A-Za-z0-9_-]+$/.test(target) ? await readRun(target, true) : undefined;
  if (byId?.parentSessionId === parent) return byId;
  const matches = (await listRuns(Number.MAX_SAFE_INTEGER, parent, true)).filter((run) => run.instanceName?.toLowerCase() === target.toLowerCase());
  if (matches.length > 1) throw new Error("实例名称存在历史冲突，请使用准确的任务 ID。");
  if (matches.length === 1) return matches[0];
  throw new Error("当前会话找不到这个任务；请使用返回的 agentId 或实例名称，不能使用角色名称。");
}
