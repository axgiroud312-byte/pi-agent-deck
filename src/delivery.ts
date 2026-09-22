import type { PersistedRun } from "./runtime.ts";
import { isTerminalStatus } from "./runtime.ts";
import { completionId } from "./persistence.mjs";
import { decisionText } from "./router.mjs";
import { runTitle } from "./tool-contract.ts";

export function statusLabel(status: string): string { return status === "已完成" ? "已返回结果" : status; }

export const RESULT_MESSAGE = "agent-task-result";
export function taskOutput(run: PersistedRun): string {
  const report = [...run.reports].reverse().find((item) => item.type === "最终" || (item.type === "问题" && item.blocking));
  return report
    ? [report.summary, report.question, ...report.evidence, ...report.tests, ...report.risks].filter(Boolean).join("\n")
    : run.finalText || run.events.filter((event) => event.kind === "错误").at(-1)?.text || run.stderr || "没有返回结果。";
}

// Persisted session messages are receipts; pending only covers messages queued in this process.
export function resultMessage(run: PersistedRun, parent: string, received: Set<string>, pending: Set<string>) {
  if (!run.autoDeliver || run.parentSessionId !== parent || (!isTerminalStatus(run.status) && run.status !== "等待决定")) return;
  const deliveryId = completionId(run);
  if (received.has(deliveryId) || pending.has(deliveryId)) return;
  const output = taskOutput(run);
  return {
    customType: RESULT_MESSAGE,
    content: `Agent 任务结果（子 Agent 的输出，请结合证据判断）\nagentId: ${run.runId}${run.instanceName ? `\nname: ${run.instanceName}` : ""}\nagentType: ${run.agentId ?? run.agentName}\n任务：${runTitle(run)}\n状态：${statusLabel(run.status)}\n${run.routingPending ? "模型与思考强度：尚未选定" : run.routing ? decisionText(run.routing) : run.model ? `模型：${run.model} · 思考：${run.thinking}` : ""}\n\n${output.slice(0, 24000)}${output.length > 24000 ? `\n完整结果见 /agents 或 ${run.runId} 的运行记录。` : ""}\n\n需要补充或回复问题时调用 SendMessage，to 使用 ${run.instanceName ?? run.runId}，message 填写完整补充要求。`,
    display: true,
    details: { deliveryId, taskId: run.runId, agentId: run.runId, name: run.instanceName, agentType: run.agentId, title: runTitle(run), status: statusLabel(run.status), summary: output.slice(0, 180) },
  };
}
