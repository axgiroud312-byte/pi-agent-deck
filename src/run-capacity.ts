/** Parent-process admission only. No durable leases, retry queue or global scheduler. */
export const MAX_ACTIVE_RUNS = 8;
const slots = new Map<string, { parent: string; release: () => void }>();

export function activeRunCount(parent: string): number {
  return [...slots.values()].filter((slot) => slot.parent === parent).length;
}

export function reserveRunSlot(parent: string, runId: string): () => void {
  const previous = slots.get(runId);
  if (previous) {
    if (previous.parent !== parent) throw new Error("任务已属于另一个主会话。");
    return previous.release;
  }
  if (activeRunCount(parent) >= MAX_ACTIVE_RUNS) throw new Error("当前主会话已占用 8/8 个子任务槽位（包含选配、执行和释放中的任务）。请等待任务结束后再派发或继续；本次请求未排队。");
  const slot = { parent, release: () => { if (slots.get(runId) === slot) slots.delete(runId); } };
  slots.set(runId, slot);
  return slot.release;
}
