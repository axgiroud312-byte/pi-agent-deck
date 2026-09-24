import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { registerChildProviders } from "./child-providers.ts";
import type { TaskResult } from "./types.ts";

/** One final attestation, no question tools or waiting protocol. */
export default function childRuntime(pi: ExtensionAPI) {
  registerChildProviders(pi);
  pi.registerTool({
    name: "agent_report", executionMode: "sequential", label: "返回任务结果",
    description: "执行结束时提交一次最终结果并结束本轮。无法继续时报告阻塞原因和已完成部分，由主 Agent 处理。检查结果是你的报告，由主 Agent 独立验收。",
    parameters: Type.Object({
      outcome: StringEnum(["完成", "部分完成", "阻塞"] as const),
      summary: Type.String({ minLength: 1 }),
      completed: Type.Array(Type.String(), { description: "实际完成的部分；没有则 []。" }),
      evidence: Type.Array(Type.String(), { description: "文件位置、工具记录或检查输出等可核对的依据。" }),
      checks: Type.Array(Type.Object({
        name: Type.String({ minLength: 1 }),
        status: StringEnum(["通过", "失败", "未运行", "不适用"] as const),
        evidence: Type.String({ description: "结果依据；未运行或不适用时说明原因。" }),
      }), { description: "逐项说明任务要求的检查；没有验证记录时用 []。" }),
      remaining: Type.Array(Type.String(), { description: "未完成事项或阻塞原因；没有则 []。" }),
    }, { additionalProperties: false }),
    async execute(_id, params) {
      const result: TaskResult = params;
      return { content: [{ type: "text" as const, text: result.summary }], details: { taskResult: result }, terminate: true };
    },
  });
}
