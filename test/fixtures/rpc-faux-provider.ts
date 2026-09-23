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
  if (transcript.includes("DECK_CAPABILITY_CASE")) return fauxAssistantMessage("CAPABILITIES_CHECKED");
  if (transcript.includes("DECK_FAILURE_CASE")) return fauxAssistantMessage("", { stopReason: "error" });
  if (transcript.includes("DECK_ABORTED_CASE")) return fauxAssistantMessage("", { stopReason: "aborted" });
  if (transcript.includes("DECK_TOOL_CASE")) {
    const completed = context.messages.some((message: any) => message.role === "toolResult" && message.toolName === "deck_pause");
    return completed ? fauxAssistantMessage("TOOL_BOUNDARY_DONE") : fauxAssistantMessage(fauxToolCall("deck_pause", {}), { stopReason: "toolUse" });
  }

  if (transcript.includes("DECK_STOP_CASE")) {
    // Leave the model response pending until the runner aborts this process.
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("stopped before completion", { stopReason: "aborted" });
  }

  if (transcript.includes("DECK_CONTINUE_CASE")) return fauxAssistantMessage("DECK_CONTINUE_DONE");

  const toolAnswer = [...context.messages].reverse().find((message) =>
    typeof message === "object" && message !== null &&
    "role" in message && message.role === "toolResult" &&
    "toolName" in message && message.toolName === "agent_question");
  if (toolAnswer) return fauxAssistantMessage(`DECK_ANSWER_DONE ${JSON.stringify(toolAnswer).includes("同意") ? "同意" : "未同意"}`);

  if (state.callCount === 1) await new Promise((resolve) => setTimeout(resolve, 300));
  return fauxAssistantMessage(fauxToolCall("agent_question", { question: "是否同意继续？", options: ["同意", "取消"] }), { stopReason: "toolUse" });
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
