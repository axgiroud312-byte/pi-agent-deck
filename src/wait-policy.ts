import { isTerminalStatus, readRun, type PersistedRun } from "./runtime.ts";

export interface RunGroupWaitResult {
  runs: PersistedRun[];
  reason: "all-terminal" | "attention" | "timeout";
}

export async function waitForRunGroup(
  requested: PersistedRun[],
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    returnOn?: "attention" | "all-terminal";
    onUpdate?: (runs: PersistedRun[]) => void;
    pollMs?: number;
  } = {},
): Promise<RunGroupWaitResult> {
  const runIds = requested.map((run) => run.runId);
  const deadline = options.timeoutMs ? Date.now() + options.timeoutMs : undefined;
  let lastSignature = "";
  while (true) {
    if (options.signal?.aborted) throw new Error("已取消等待；后台 Agent 仍在运行");
    const values = await Promise.all(runIds.map((runId) => readRun(runId)));
    const missing = runIds.filter((_runId, index) => !values[index]);
    if (missing.length) throw new Error(`等待期间运行状态丢失：${missing.join("、")}`);
    const runs = values.filter((run): run is PersistedRun => Boolean(run));
    const signature = runs.map((run) => `${run.runId}:${run.status}:${run.updatedAt}`).join("|");
    if (signature !== lastSignature) {
      lastSignature = signature;
      options.onUpdate?.(runs);
    }
    const waitingDecision = runs.some((run) => run.status === "等待决定");
    const failureAttention = runs.some((run) => ["失败", "失联", "停止未确认", "已停止", "已取消"].includes(run.status));
    if (waitingDecision || (failureAttention && options.returnOn !== "all-terminal")) return { runs, reason: "attention" };
    if (runs.every((run) => isTerminalStatus(run.status))) return { runs, reason: "all-terminal" };
    if (deadline !== undefined && Date.now() >= deadline) return { runs, reason: "timeout" };
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 150));
  }
}
