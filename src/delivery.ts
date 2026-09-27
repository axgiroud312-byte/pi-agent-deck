import type { PersistedRun } from "./types.ts";
import { isTerminalStatus } from "./runtime.ts";
import { completionId, completionOutput } from "./persistence.mjs";
import { runTitle, statusLabel, taskMessage } from "./tool-contract.ts";
export { statusLabel } from "./tool-contract.ts";

export const RESULT_MESSAGE = "agent-task-result";
export const PARENT_MESSAGE = "agent-parent-message";
function modelEvidence(text: string, reportPath?: string, sessionPath?: string): string {
  const preview = text.length <= 24000 ? text : `${text.slice(0, 24000)}\n\n【显示前24000字符】`;
  if (reportPath) return `${preview}\n\n完整结果文件：${reportPath}`;
  return text.length <= 24000 ? preview : `${preview}完整结果保存在原通知 details.evidence 和对应任务执行记录；完整证据请读取子会话：${sessionPath ?? "见任务记录的 childSessionPath"}。`;
}
export function taskOutput(run: PersistedRun): string {
  if (run.pendingQuestion) return `子 Agent 等待你的回答：\n${run.pendingQuestion.message}\n\n请用 SendMessage 回答：to=${run.runId}，reply_to=${run.pendingQuestion.id}，message 填写补充信息或决定。回答后在原子会话继续，完成时返回完整结果。`;
  return completionOutput(run);
}

export function resultMessage(run: PersistedRun, parent: string) {
  const background = run.deliveryMode === "background";
  if (!background || run.parentSessionId !== parent || (!isTerminalStatus(run.status) && run.status !== "等待决定" && run.status !== "停止未确认")) return;
  const deliveryId = run.pendingQuestion ? `${run.runId}:${run.turnId}:question:${run.pendingQuestion.id}` : completionId(run);
  const output = taskOutput(run);
  const pendingQuestion = run.pendingQuestion ?? (run.version < 3 && run.status === "等待决定" ? run.legacy?.pendingQuestion : undefined);
  return {
    customType: RESULT_MESSAGE,
    content: `${run.pendingQuestion ? "Agent 澄清问题" : "Agent 任务结果"}\n${modelEvidence(taskMessage(run, `任务：${runTitle(run)}\n\n${output}`), run.pendingQuestion ? undefined : run.reportPath, run.childSessionPath)}`,
    display: true,
    details: { deliveryId, taskId: run.runId, agentId: run.runId, turnId: run.turnId, questionId: pendingQuestion?.id, name: run.instanceName, agentType: run.roleId, title: runTitle(run), status: statusLabel(run.status), summary: output.slice(0, 180), evidence: output, reportPath: run.pendingQuestion ? undefined : run.reportPath },
  };
}
