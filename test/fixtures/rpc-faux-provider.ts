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
  const lastUser = [...context.messages].reverse().find((message: any) => message?.role === "user");
  const latestUser = JSON.stringify(lastUser ?? {});
  record({ type: "provider_call", call: state.callCount, transcript, tools: context.tools?.map((tool) => tool.name) });
  const done = (text = "DECK_FINAL_TEXT") => fauxAssistantMessage(text);
  if (transcript.includes("DECK_CONTINUE_CASE")) return done("DECK_CONTINUE_DONE");
  if (transcript.includes("DECK_CAPABILITY_CASE")) return fauxAssistantMessage("CAPABILITIES_CHECKED");
  if (transcript.includes("DECK_EMPTY_CASE")) return done("");
  if (transcript.includes("DECK_FAILURE_CASE")) return fauxAssistantMessage("已经调查入口，尚未验证", { stopReason: "error" });
  if (transcript.includes("DECK_ABORTED_CASE")) return fauxAssistantMessage("", { stopReason: "aborted" });
  if (transcript.includes("DECK_BLOCK_CASE")) return done("我做不到：缺少业务决定，主 Agent 需要处理范围决定");
  if (latestUser.includes("DECK_WORKFLOW_WORKER_CASE")) {
    const boundary = context.messages.reduce((found: number, message: any, index: number) => message.role === "user" ? index : found, -1);
    const current = context.messages.slice(boundary + 1);
    if (!current.some((message: any) => message.role === "toolResult" && message.toolName === "RoleProbe")) {
      return fauxAssistantMessage(fauxToolCall("RoleProbe", { value: "workflow-worker" }), { stopReason: "toolUse" });
    }
    if (!current.some((message: any) => message.role === "toolResult" && message.toolName === "deck_pause")) {
      return fauxAssistantMessage(fauxToolCall("deck_pause", {}), { stopReason: "toolUse" });
    }
    return done("WORKFLOW_WORKER_DONE");
  }
  if (latestUser.includes("DECK_WORKFLOW_FIX_CASE")) {
    const boundary = context.messages.reduce((found: number, message: any, index: number) => message.role === "user" ? index : found, -1);
    const current = context.messages.slice(boundary + 1);
    return current.some((message: any) => message.role === "toolResult" && message.toolName === "RoleProbe")
      ? done("WORKFLOW_RESUME_DONE")
      : fauxAssistantMessage(fauxToolCall("RoleProbe", { value: "workflow-resume" }), { stopReason: "toolUse" });
  }
  if (latestUser.includes("DECK_BASH_REVIEW_CASE")) {
    const boundary = context.messages.reduce((found: number, message: any, index: number) => message.role === "user" ? index : found, -1);
    const current = context.messages.slice(boundary + 1);
    if (!current.some((message: any) => message.role === "toolResult" && message.toolName === "bash")) {
      return fauxAssistantMessage(fauxToolCall("bash", { command: "node --version" }), { stopReason: "toolUse" });
    }
    return current.some((message: any) => message.role === "toolResult" && message.toolName === "deck_pause")
      ? done("BASH_REVIEW_DONE")
      : fauxAssistantMessage(fauxToolCall("deck_pause", {}), { stopReason: "toolUse" });
  }
  if (transcript.includes("DECK_TOOL_CASE")) {
    const completed = context.messages.some((message: any) => message.role === "toolResult" && message.toolName === "deck_pause");
    return completed ? done("DECK_TOOL_DONE") : fauxAssistantMessage(fauxToolCall("deck_pause", {}), { stopReason: "toolUse" });
  }
  if (transcript.includes("DECK_ROLE_EXTENSION_CASE")) {
    const lastUser = context.messages.reduce((found: number, message: any, index: number) => message.role === "user" ? index : found, -1);
    const completed = context.messages.slice(lastUser + 1).some((message: any) => message.role === "toolResult" && message.toolName === "RoleProbe");
    return completed ? done("ROLE_EXTENSION_DONE") : fauxAssistantMessage(fauxToolCall("RoleProbe", { value: "configured-role-extension" }), { stopReason: "toolUse" });
  }
  if (transcript.includes("DECK_STOP_CASE")) {
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    return fauxAssistantMessage("stopped before completion", { stopReason: "aborted" });
  }
  if (state.callCount === 1) await new Promise((resolve) => setTimeout(resolve, 300));
  return done();
};

provider.setResponses(Array.from({ length: 64 }, () => respond));

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
