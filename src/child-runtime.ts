import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import type { AgentReport } from "./types.ts";

import { registerChildProviders } from "./child-providers.ts";

const StringList = Type.Optional(Type.Array(Type.String()));
const CriterionResults = Type.Optional(Type.Array(Type.Object({
  criterion: Type.String(),
  status: StringEnum(["通过", "部分完成", "未完成", "未验证"] as const),
  evidence: Type.Optional(Type.Array(Type.String())),
  notes: Type.Optional(Type.String()),
})));
const FileChanges = Type.Optional(Type.Array(Type.Object({
  path: Type.String(),
  change: Type.String(),
})));
const DesignDecisions = Type.Optional(Type.Array(Type.Object({
  decision: Type.String(),
  reason: Type.String(),
  alternatives: Type.Optional(Type.Array(Type.String())),
})));

const ReportParameters = Type.Object({
  type: StringEnum(["进度", "发现", "问题", "警告", "最终"] as const, {
    description: "报告类型。完成任务必须使用“最终”；需要外部决定且无法继续时使用“问题”。",
  }),
  title: Type.String({ description: "简短、具体的中文标题" }),
  summary: Type.String({ description: "报告核心内容，使用简体中文" }),
  objectiveStatus: Type.Optional(StringEnum(["完成", "部分完成", "未完成", "阻塞"] as const)),
  acceptanceCriteria: CriterionResults,
  evidence: StringList,
  completed: StringList,
  deliverables: StringList,
  filesRead: StringList,
  filesChanged: StringList,
  fileChanges: FileChanges,
  designDecisions: DesignDecisions,
  commands: StringList,
  tests: StringList,
  risks: StringList,
  unknowns: StringList,
  downstreamNotes: StringList,
  recommendations: StringList,
  question: Type.Optional(Type.String()),
  options: StringList,
  recommendation: Type.Optional(Type.String()),
  blocking: Type.Optional(Type.Boolean()),
  confidence: Type.Optional(StringEnum(["低", "中", "高"] as const)),
});

function normalize(params: Static<typeof ReportParameters>): AgentReport {
  return {
    type: params.type,
    title: params.title,
    summary: params.summary,
    objectiveStatus: params.objectiveStatus,
    acceptanceCriteria: (params.acceptanceCriteria ?? []).map((item) => ({ ...item, evidence: item.evidence ?? [] })),
    evidence: params.evidence ?? [],
    completed: params.completed ?? [],
    deliverables: params.deliverables ?? [],
    filesRead: params.filesRead ?? [],
    filesChanged: params.filesChanged ?? [],
    fileChanges: params.fileChanges ?? [],
    designDecisions: (params.designDecisions ?? []).map((item) => ({ ...item, alternatives: item.alternatives ?? [] })),
    commands: params.commands ?? [],
    tests: params.tests ?? [],
    risks: params.risks ?? [],
    unknowns: params.unknowns ?? [],
    downstreamNotes: params.downstreamNotes ?? [],
    recommendations: params.recommendations ?? [],
    question: params.question,
    options: params.options ?? [],
    recommendation: params.recommendation,
    blocking: params.blocking ?? false,
    confidence: params.confidence,
  };
}

function expectedAcceptanceCriteria(): string[] {
  try {
    const parsed = JSON.parse(process.env.PI_AGENT_DECK_ACCEPTANCE_CRITERIA ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function normalizeCriterion(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
}

async function awaitQuestionAnswer(report: AgentReport, signal: AbortSignal | undefined, ctx: { ui: { input: (title: string, placeholder?: string, options?: { signal?: AbortSignal }) => Promise<string | undefined> } }): Promise<string> {
  if (signal?.aborted) throw signal.reason ?? new Error("问题等待已取消");
  const question = report.question?.trim() || report.summary;
  const choices = report.options.length ? `可选回答：\n${report.options.map((option, index) => `${index + 1}. ${option}`).join("\n")}` : undefined;
  const answer = await ctx.ui.input(question, choices, { signal });
  if (signal?.aborted) throw signal.reason ?? new Error("问题等待已取消");
  if (!answer?.trim()) throw new Error("问题尚未获得主 Agent 的答复");
  return answer.trim();
}

export default function childRuntime(pi: ExtensionAPI) {
  registerChildProviders(pi);
  pi.registerTool({
    name: "agent_question",
    label: "询问主 Agent",
    description: "确实缺少必要信息且无法继续时提问。常规可逆选择自行处理。",
    parameters: Type.Object({ question: Type.String({ minLength: 1 }), options: StringList }),
    async execute(_id, params, signal, _update, ctx) {
      const report = normalize({ type: "问题", title: "需要答复", summary: params.question, question: params.question, options: params.options, blocking: true });
      const answer = await awaitQuestionAnswer(report, signal, ctx);
      return { content: [{ type: "text", text: `主 Agent 的答复：${answer}` }], details: report };
    },
  });
  if (process.env.PI_AGENT_DECK_SIMPLE === "1") return;
  pi.registerTool({
    name: "agent_report",
    label: "Agent 报告",
    description: "向主 Agent 提交结构化的中文进度、发现、阻塞问题、警告或最终报告。最终报告必须作为任务的最后一个动作。",
    promptSnippet: "提交阶段性发现、阻塞问题或最终结构化报告",
    promptGuidelines: [
      "使用 agent_report 报告会影响后续决策的重要发现，不要用它重复每个普通工具步骤。",
      "遇到无法自行决定的关键问题时，使用 agent_report 提交 blocking=true 的“问题”报告，并在同一次工具调用中等待答复。",
      "完成委派任务时，最后一个动作必须使用 agent_report 提交“最终”报告。",
      "最终报告必须逐项填写 acceptanceCriteria，说明每项是通过、部分完成、未完成还是未验证，并提供证据或原因。",
      "最终报告必须清楚列出交付物、读取和修改的文件、设计决定、命令、测试状态、风险、未知项及下游注意事项。",
    ],
    parameters: ReportParameters,
    async execute(_toolCallId, params, signal, _update, ctx) {
      const report = normalize(params);
      if (report.type === "最终") {
        if (!report.objectiveStatus) throw new Error("最终报告必须填写 objectiveStatus");
        if (report.acceptanceCriteria.length === 0) throw new Error("最终报告必须逐项填写 acceptanceCriteria");
        const reported = new Set(report.acceptanceCriteria.map((item) => normalizeCriterion(item.criterion)));
        const missing = expectedAcceptanceCriteria().filter((criterion) => !reported.has(normalizeCriterion(criterion)));
        if (missing.length) throw new Error(`最终报告遗漏完成标准：${missing.join("；")}`);
      }
      if (report.type === "问题" && report.blocking) {
        const answer = await awaitQuestionAnswer(report, signal, ctx);
        return { content: [{ type: "text", text: `主 Agent 的答复：${answer}` }], details: report };
      }
      const terminal = report.type === "最终";
      return {
        content: [{ type: "text", text: terminal ? `已提交${report.type}报告：${report.title}` : `已记录${report.type}：${report.title}` }],
        details: report,
        terminate: terminal,
      };
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("Agent 报告 ")) +
          theme.fg(args.type === "问题" ? "warning" : args.type === "最终" ? "success" : "accent", args.type) +
          ` ${theme.fg("muted", args.title ?? "")}`,
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const report = result.details as AgentReport | undefined;
      if (!report) return new Text(theme.fg("muted", "报告已记录"), 0, 0);
      return new Text(
        `${theme.fg("accent", theme.bold(report.title))}\n${theme.fg("text", report.summary)}`,
        0,
        0,
      );
    },
  });
}
