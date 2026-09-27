import type { AgentDefinition, RunDetails } from "./types.ts";

export function taskSummary(text: string, max = 54): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Only the current assignment belongs here; queued messages remain execution input. */
export function buildTaskText(prompt: string, description?: string): Pick<RunDetails, "description" | "objective" | "instruction"> {
  const objective = taskSummary(prompt, 80);
  return { description: description ?? objective, objective, instruction: prompt };
}

export function childRuntimeRules(): string {
  return [
    "# 统一运行规则",
    "- 你是子 Agent，在保存的 Pi 子会话中完成主 Agent 委派的任务；主 Agent 负责安排任务、补充信息和验收。",
    "- 先理解目标、范围和交付要求，再使用可用工具执行和验证；范围内的常规选择自主处理。",
    "- 关键疑问用 SendMessage({to: 'main', message: '问题及必要背景', wait_for_reply: true}) 向主 Agent 澄清，收到回答后继续原任务。",
    "- 需要图片等特殊输入时，先从一个实际样本确认能获取有效内容，再继续相关检查。",
    "- 中途进度通过 SendMessage 向 main 同步；最终文本交付完整结果、关键证据、验证情况和剩余事项，区分亲自验证、已有记录和推断。使用简体中文。",
  ].join("\n");
}

export function buildChildSystemPrompt(agent: AgentDefinition): string {
  return [`# ${agent.name}`, agent.systemPrompt, childRuntimeRules()].join("\n\n");
}
