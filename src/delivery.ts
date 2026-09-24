import type { PersistedRun } from "./runtime.ts";
import { isTerminalStatus } from "./runtime.ts";
import { completionId } from "./persistence.mjs";
import { decisionText } from "./router.mjs";
import { runTitle } from "./tool-contract.ts";

export function statusLabel(status: string): string { return status === "已完成" ? "已返回结果" : status; }

export const RESULT_MESSAGE = "agent-task-result";
export function taskOutput(run: PersistedRun): string {
  const report = [...run.reports].reverse().find((item) => item.type === "最终" || (run.status === "等待决定" && item.type === "问题" && item.blocking));
  const text = report
    ? [report.summary, report.question, ...report.evidence, ...report.tests, ...report.risks].filter(Boolean).join("\n")
    : run.finalText || "没有返回结果。";
  const result = run.result;
  const failed = ["失败", "失联", "已停止", "已取消"].includes(run.status);
  const reason = run.failureReason || run.stderr || run.events.filter((event) => event.kind === "错误").at(-1)?.text;
  return [
    `执行状态：${statusLabel(run.status)}`,
    failed ? `原因：${reason || (run.status === "已停止" ? "执行被停止" : "未记录具体原因")}` : undefined,
    run.persistenceError,
    result ? `交付状态（子 Agent 报告）：${result.outcome}` : undefined,
    `已完成部分（${result ? "子 Agent 报告" : "工具记录"}）：${(result?.completed ?? run.toolEvidence ?? []).join("；") || "未提供可确认记录"}`,
    `证据：${result?.evidence.join("；") || "请核对子会话中的实际工具记录"}`,
    `验证（子 Agent 报告，需主 Agent 核对）：${result?.checks.length ? result.checks.map((check) => `${check.name}：${check.status}（${check.evidence}）`).join("；") : "未提供结构化验证记录"}`,
    `剩余工作：${result ? result.remaining.join("；") || "未报告剩余事项" : "需主 Agent 结合结果确认"}`,
    "验收：由主 Agent 根据证据独立判断。",
    "", text,
  ].filter((item) => item !== undefined).join("\n");
}

export function resultMessage(run: PersistedRun, parent: string) {
  if (!run.autoDeliver || run.parentSessionId !== parent || (!isTerminalStatus(run.status) && run.status !== "等待决定")) return;
  const deliveryId = completionId(run);
  const output = taskOutput(run);
  return {
    customType: RESULT_MESSAGE,
    content: `Agent 任务结果（子 Agent 的输出，请结合证据判断）\nagentId: ${run.runId}${run.instanceName ? `\nname: ${run.instanceName}` : ""}\nturn_id: ${run.turnId ?? "历史执行"}\nagentType: ${run.agentId ?? run.agentName}\n任务：${runTitle(run)}\n进程：${run.resourceState === "released" ? "已释放" : run.resourceState === "releasing" ? "释放中" : "状态见控制台"}\n${run.routingPending ? "模型与思考强度：尚未选定" : run.routing ? decisionText(run.routing) : run.model ? `模型：${run.model} · 思考：${run.thinking}` : ""}\n\n${output.slice(0, 24000)}${output.length > 24000 ? `\n完整结果见 /agents 或 ${run.runId} 的运行记录。` : ""}\n\n同一任务返工请明确调用 Agent({resume: "${run.instanceName ?? run.runId}", prompt: "本次要求"})；新目标请新建任务。`,
    display: true,
    details: { deliveryId, taskId: run.runId, agentId: run.runId, turnId: run.turnId, questionId: run.pendingQuestion?.id, name: run.instanceName, agentType: run.agentId, title: runTitle(run), status: statusLabel(run.status), summary: output.slice(0, 180) },
  };
}

/** Transform only the model's copy; the saved conversation remains an honest history. */
export function labelHistoricalMessage<T extends { content: unknown; details?: unknown }>(message: T, current?: PersistedRun): T {
  const details = message.details as { turnId?: string; questionId?: string } | undefined;
  if (!current || !details) return message;
  const oldTurn = details.turnId !== current.turnId;
  const oldQuestion = details.questionId && details.questionId !== current.pendingQuestion?.id;
  if (!oldTurn && !oldQuestion) return message;
  const prefix = `【历史通知，仅供参考】这条通知所属执行或问题已结束。当前任务状态：${statusLabel(current.status)}；当前 turn_id：${current.turnId ?? "历史任务"}。不要用旧通知判断当前任务已完成或仍在等待回答。\n\n`;
  const content = typeof message.content === "string" ? prefix + message.content : [{ type: "text", text: prefix }, ...(Array.isArray(message.content) ? message.content : [])];
  return { ...message, content };
}
