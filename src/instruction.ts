import type { AgentDefinition } from "./types.ts";
export function childRuntimeRules(): string {
  return [
    "# 统一运行规则",
    "- 你是子 Agent，在保存的 Pi 子会话中执行本次任务；任务调度和需求澄清由主 Agent 负责。",
    "- 根据本次提示中的目标、范围和交付要求持续使用模型与可用工具完成工作；范围内的常规选择自行处理。",
    "- 遵守角色提示词和实际工具范围；只处理本次任务，保持其他工作不受影响。",
    "- 如果缺少关键输入或必须由主 Agent 决定，直接在最终文本中说明阻塞原因、已完成部分和所需决定，然后结束本轮，不要挂起等待问答。",
    "- 最终文本如实说明结果、重要证据、验证情况和未解决事项。运行时会原样交给主 Agent 判断。使用简体中文。",
  ].join("\n");
}

export function buildChildSystemPrompt(agent: AgentDefinition): string {
  return [`# Agent 定位：${agent.name}`, agent.systemPrompt, childRuntimeRules()].join("\n\n");
}
