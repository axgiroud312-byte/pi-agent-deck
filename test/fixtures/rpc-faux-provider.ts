import * as fs from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// This provider is fully local. Every response is selected from the Pi transcript;
// it never opens a socket or loads an account credential.
const provider = fauxProvider({ provider: "deck-local-fixture", models: [{ id: "scripted", reasoning: false }] });

function record(value: unknown): void {
  const file = process.env.PI_AGENT_DECK_FIXTURE_LOG;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

const respond = async (context: { messages: unknown[]; tools?: { name: string }[] }, options: { signal?: AbortSignal } | undefined, state: { callCount: number }) => {
  const transcript = JSON.stringify(context.messages);
  record({ type: "provider_call", call: state.callCount, transcript, tools: context.tools?.map((tool) => tool.name) });
  const report = (outcome = "完成") => fauxAssistantMessage(fauxToolCall("agent_report", {
    outcome, summary: outcome === "阻塞" ? "缺少业务决定" : "DECK_REPORT_DONE",
    completed: ["已读取本地测试上下文"], evidence: ["本地可控模型记录"],
    checks: [{ name: "测试检查", status: "通过", evidence: "本地测试样例" }],
    remaining: outcome === "阻塞" ? ["主 Agent 需要处理范围决定"] : [],
  }), { stopReason: "toolUse" });
  if (transcript.includes("DECK_CONTINUE_CASE")) return report();
  if (transcript.includes("DECK_CAPABILITY_CASE")) return fauxAssistantMessage("CAPABILITIES_CHECKED");
  if (transcript.includes("DECK_FAILURE_CASE")) return fauxAssistantMessage("已经调查入口，尚未验证", { stopReason: "error" });
  if (transcript.includes("DECK_ABORTED_CASE")) return fauxAssistantMessage("", { stopReason: "aborted" });
  if (transcript.includes("DECK_BLOCK_CASE")) return report("阻塞");
  if (transcript.includes("DECK_TOOL_CASE")) {
    const completed = context.messages.some((message: any) => message.role === "toolResult" && message.toolName === "deck_pause");
    return completed ? report() : fauxAssistantMessage(fauxToolCall("deck_pause", {}), { stopReason: "toolUse" });
  }
  if (transcript.includes("DECK_STOP_CASE")) {
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("stopped before completion", { stopReason: "aborted" });
  }
  if (state.callCount === 1) await new Promise((resolve) => setTimeout(resolve, 300));
  return report();
};

provider.setResponses(Array.from({ length: 12 }, () => respond));

export default function localProvider(pi: ExtensionAPI): void {
  pi.registerProvider(provider.provider);
  pi.on("before_agent_start", async () => { record({ type: "active_tools", tools: pi.getActiveTools() }); });
  pi.registerTool({ name: "deck_pause", label: "local fixture", description: "A controlled local long tool", parameters: Type.Object({}),
    async execute() {
      record({ type: "long_tool_start" });
      await new Promise((resolve) => setTimeout(resolve, 400));
      record({ type: "long_tool_end" });
      return { content: [{ type: "text", text: "tool completed" }], details: {} };
    },
  });
}
