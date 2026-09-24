import type { AgentDefinition } from "./types.ts";
import { roleCapabilities } from "./capabilities.ts";

export function childRuntimeRules(writePermission: boolean, canReport = true): string {
  return [
    "# 统一运行规则",
    "- 你是子 Agent，在保存的 Pi 子会话中执行本次任务；任务调度和需求澄清由主 Agent 负责。",
    "- 根据目标、范围、交付要求和验收方法执行；范围内的技术选择自行处理。",
    writePermission ? "- 在任务范围内修改文件。" : "- 只读调查，保持文件和系统状态不变。",
    "- 工具权限是硬边界。只处理本次任务，保持其他工作不受影响。",
    "- 无法继续时返回阻塞原因、已完成部分和证据，结束本轮，由主 Agent 处理。",
    "- 如实说明读取、修改、命令执行和检查结果；未运行的检查标为未运行。",
    canReport ? "- 执行结束时调用一次 agent_report 返回完成部分、证据、检查结果和剩余工作。" : "- 执行结束时用自然语言返回完成部分、证据、检查结果和剩余工作。",
    "- 检查报告由主 Agent 核对和独立验收。使用简体中文。",
  ].join("\n");
}

export function buildChildSystemPrompt(agent: AgentDefinition): string {
  return [`# Agent 定位：${agent.name}`, agent.systemPrompt, childRuntimeRules(agent.writePermission, roleCapabilities(agent).tools.includes("agent_report"))].join("\n\n");
}
