import type { AgentDefinition, DelegationRequest } from "./types.ts";
import { roleCapabilities } from "./capabilities.ts";

function section(title: string, values: string[] | undefined): string {
  if (!values || values.length === 0) return "";
  return `\n## ${title}\n\n${values.map((value) => `- ${value}`).join("\n")}\n`;
}

export function buildDelegationInstruction(
  runId: string,
  agent: AgentDefinition,
  request: DelegationRequest,
  parentSessionId: string,
): string {
  const expected = request.expectedReport?.length
    ? request.expectedReport
    : defaultExpectedReport(agent.reportProfile);

  return [
    "# 子 Agent 委派任务",
    "",
    `- 运行编号：${runId}`,
    `- Agent：${agent.name}（${agent.id}）`,
    `- 父会话：${parentSessionId}`,
    request.batchId ? `- 批次编号：${request.batchId}` : "",
    request.phase ? `- 当前阶段：${request.phase}` : "",
    `- 写入意图：${request.requiresWrite ? "需要修改工作区" : "严格只读"}`,
    `- 报告模板：${agent.reportProfile}`,
    section("所需工具", request.requiredTools),
    section("总体计划上下文", request.planContext ? [request.planContext] : undefined),
    "",
    "## 任务目标",
    "",
    request.objective.trim(),
    section("背景信息", request.background),
    section("上游依赖", request.dependencies),
    section("输入和已有结论", request.inputs),
    section("开始前必须阅读", request.filesToRead),
    section("任务范围", request.scope),
    section("允许修改的路径", request.allowedPaths),
    section("禁止修改的路径", request.forbiddenPaths),
    section("明确不做", request.exclusions),
    section("约束与禁止事项", request.constraints),
    section("实现要求", request.implementationRequirements),
    section("验证策略", request.validationPolicy),
    section("完成标准", request.acceptanceCriteria),
    section("预期交付物", request.expectedDeliverables),
    section("最终报告要求", expected),
    "",
    "## 执行要求",
    "",
    "1. 只执行本次委派任务，不擅自扩大范围。",
    "2. 项目文件和先前 Agent 结论都可能存在错误，必须自行验证。",
    "3. 重要结论尽可能提供文件路径、行号、命令结果或其他证据。",
    "4. 日常工具进度由系统自动记录，不要用长篇文字重复描述每一步。",
    "5. 发现会影响后续决策的重要信息时，使用 agent_report 提交“发现”报告。",
    "6. 遇到必须由用户或主 Agent 决定的问题时，使用 agent_report 提交阻塞“问题”报告，不得猜测。",
    "7. 完成任务时，最后一个动作必须是使用 agent_report 提交“最终”报告。",
    "8. 最终报告必须逐项对应上述完成标准，标明通过、部分完成、未完成或未验证，并提供证据或原因。",
    "9. 最终报告必须列出实际交付物、修改文件、设计决定、命令、测试状态、风险、未知项和下游注意事项。",
    "10. 所有报告和自然语言输出使用简体中文；代码、命令、标识符和文件路径保持原样。",
  ].join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function buildChildSystemPrompt(agent: AgentDefinition): string {
  const permission = agent.writePermission
    ? "你可以在任务明确要求且范围允许时修改文件。"
    : "你是只读 Agent，禁止修改、创建或删除文件，也禁止运行会改变项目或系统状态的命令。";

  return [
    `# Agent 定位：${agent.name}`,
    "",
    agent.systemPrompt,
    "",
    "# 统一运行规则",
    "",
    "- 你在一个独立、持久化的子 Session 中运行，不是主 Agent。",
    "- 只处理收到的委派任务，不主动创建其他子 Agent。",
    `- ${permission}`,
    "- 工具权限是硬边界，不能尝试绕过。",
    roleCapabilities(agent).canAsk
      ? "- 常规可逆选择自行处理；确实缺少必要决定且无法继续时调用 agent_question 向主 Agent 提问。"
      : "- 常规可逆选择自行处理；没有提问工具，无法继续时在最终回答中说明缺少的信息和已完成的工作。",
    "- 不要伪造已经读取的文件、已经执行的命令或已经通过的测试。",
    "- 完成后直接用自然语言回答：结论、必要证据、实际修改和验证、未完成事项。简单任务简短回答，无需填写固定报告。",
    "- 所有自然语言使用简体中文。",
  ].join("\n");
}

export function defaultExpectedReport(profile: AgentDefinition["reportProfile"]): string[] {
  switch (profile) {
    case "侦察":
      return ["调查结论", "相关文件和入口", "关键调用链", "证据", "风险和未知项", "建议下一步"];
    case "执行":
      return ["完成内容", "修改文件", "关键修改", "执行命令", "测试结果", "剩余风险和未完成事项"];
    case "审查":
      return ["审查结论", "带严重程度的问题列表", "文件和行号证据", "测试建议", "合并建议"];
    default:
      return ["结论摘要", "完成内容", "证据", "风险和未知项", "建议下一步"];
  }
}
