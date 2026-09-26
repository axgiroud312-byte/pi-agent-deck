import type { PersistedRun } from "./runtime.ts";
import { isTerminalStatus } from "./runtime.ts";
import { completionId } from "./persistence.mjs";
import { runTitle } from "./tool-contract.ts";

export function statusLabel(status: string): string { return status === "已完成" ? "已返回结果" : status; }

export const RESULT_MESSAGE = "agent-task-result";
function modelEvidence(text: string, sessionPath?: string): string {
  return text.length <= 24000 ? text : `${text.slice(0, 24000)}\n\n【显示前24000字符，完整证据未删除】完整结果保存在原通知 details.evidence 和对应任务执行记录；子会话：${sessionPath ?? "见任务记录的 childSessionPath"}。不能把此摘要当作全部证据。`;
}
export function taskOutput(run: PersistedRun): string {
  // Legacy reports describe a v1/v2 execution. After an explicit resume the
  // record becomes v3, so the current turn's native final text must win.
  const report = run.version < 3
    ? [...(run.legacy?.reports ?? [])].reverse().find((item) => item.type === "最终" || (run.status === "等待决定" && item.type === "问题" && item.blocking))
    : undefined;
  const text = report
    ? [report.summary, report.question, ...report.evidence, ...report.tests, ...report.risks].filter(Boolean).join("\n")
    : run.finalText;
  const failed = ["失败", "失联", "已停止", "已取消", "停止未确认"].includes(run.status);
  const reason = [run.failureReason, run.stderr, ...run.events.filter((event) => event.kind === "错误").map((event) => event.text)].filter((value, index, all) => value && all.indexOf(value) === index).join("；");
  return [
    `[Agent ${run.runId} · ${statusLabel(run.status)}]`,
    failed ? `运行原因：${reason || (run.status === "已停止" ? "执行被停止" : "未记录具体原因")}` : reason ? `运行记录：${reason}` : undefined,
    run.persistenceError ? `保存记录：${run.persistenceError}` : undefined,
    "",
    text ?? "（子 Agent 正常结束，但没有输出文本。）",
  ].filter((item) => item !== undefined).join("\n");
}

export function resultMessage(run: PersistedRun, parent: string) {
  const background = run.deliveryMode === "background";
  if (!background || run.parentSessionId !== parent || (!isTerminalStatus(run.status) && run.status !== "等待决定" && run.status !== "停止未确认")) return;
  const deliveryId = completionId(run);
  const output = taskOutput(run);
  const pendingQuestion = run.version < 3 && run.status === "等待决定" ? run.legacy?.pendingQuestion : undefined;
  return {
    customType: RESULT_MESSAGE,
    content: `Agent 任务结果\nagentId: ${run.runId}${run.instanceName ? `\nname: ${run.instanceName}` : ""}\nagentType: ${run.roleId}\n任务：${runTitle(run)}\n\n${modelEvidence(output, run.childSessionPath)}`,
    display: true,
    details: { deliveryId, taskId: run.runId, agentId: run.runId, turnId: run.turnId, questionId: pendingQuestion?.id, name: run.instanceName, agentType: run.roleId, title: runTitle(run), status: statusLabel(run.status), summary: output.slice(0, 180), evidence: output },
  };
}

/** Transform only the model's copy; the saved conversation remains an honest history. */
export function labelHistoricalMessage<T extends { content: unknown; details?: unknown }>(message: T, current?: PersistedRun): T {
  const details = message.details as { turnId?: string; questionId?: string; evidence?: string; taskId?: string; status?: string } | undefined;
  if (!current || !details) return message;
  const oldTurn = details.turnId !== current.turnId;
  const oldQuestion = details.questionId && details.questionId !== current.legacy?.pendingQuestion?.id;
  const oldStatus = typeof details.status === "string" && details.status !== statusLabel(current.status);
  if (!oldTurn && !oldQuestion && !oldStatus) return message;
  // Legacy notifications have no evidence detail: retain their recorded result text,
  // but never carry the old resume instruction into the model's current context.
  const legacy = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? message.content.filter((block): block is { type: "text"; text: string } => Boolean(block && typeof block === "object" && (block as { type?: string }).type === "text" && typeof (block as { text?: unknown }).text === "string")).map((block) => block.text).join("") : "";
  // Remove only plugin-generated action footers, never natural-language report evidence.
  const withoutFooter = legacy.split(/\n\n(?:同一任务返工请明确调用 Agent\(\{resume:|SendMessage 的 to 使用 )/)[0];
  const evidence = details.evidence ?? (withoutFooter.includes("本次执行状态：") ? withoutFooter.slice(withoutFooter.indexOf("本次执行状态：")) : withoutFooter.includes("执行状态：") ? withoutFooter.slice(withoutFooter.indexOf("执行状态：")) : withoutFooter);
  const text = `【历史通知，仅供参考，不是当前待办】任务 ${details.taskId ?? "未知"} 的这条通知（turn ${details.turnId ?? "未知"}）已不代表当前待处理状态；当前任务状态：${statusLabel(current.status)}；当前 turn_id：${current.turnId ?? "历史任务"}。以下是历史产物、错误和检查证据，不据此启动或续接任务。\n\n${modelEvidence(evidence, current.childSessionPath)}`;
  const content = Array.isArray(message.content)
    ? [{ type: "text", text }, ...message.content.filter(block => block && typeof block === "object" && block.type !== "text")]
    : text;
  return { ...message, content };
}
