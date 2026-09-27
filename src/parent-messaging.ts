import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Pi's native RPC dialog already supplies correlation IDs and reply delivery.
// This reserved envelope carries child-to-parent messages over that channel.
export const PARENT_MESSAGE_TITLE = "agent-deck:parent-message";
export interface ParentMessage { id: string; message: string; waitForReply: boolean }

export function parseParentMessage(event: any): ParentMessage | undefined {
  if (event.type !== "extension_ui_request" || event.method !== "input" || event.title !== PARENT_MESSAGE_TITLE) return;
  const body = JSON.parse(event.placeholder);
  if (typeof event.id !== "string" || typeof body.message !== "string" || !body.message.trim() || typeof body.waitForReply !== "boolean") {
    throw new Error("子 Agent 消息需要请求编号、正文和等待回答标记。");
  }
  return { id: event.id, message: body.message, waitForReply: body.waitForReply };
}

export function registerParentMessaging(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "SendMessage", label: "联系主 Agent",
    description: "向主 Agent（main）发送进度或关键疑问。需要主 Agent 明确目标、补充资料或作出决定时，设置 wait_for_reply=true，收到回答后继续执行；普通进度消息发送后继续当前工作。最终回复用于交付完整任务结果。",
    parameters: Type.Object({
      to: Type.Literal("main"),
      message: Type.String({ minLength: 1, description: "进度，或需要澄清的问题及必要背景。" }),
      wait_for_reply: Type.Optional(Type.Boolean({ description: "等待主 Agent 回答，随后在原会话继续。默认 false。" })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      if (!params.message.trim()) throw new Error("请提供消息正文。");
      const reply = await ctx.ui.input(PARENT_MESSAGE_TITLE, JSON.stringify({ message: params.message, waitForReply: params.wait_for_reply === true }), { signal });
      if (reply === undefined) throw new Error("与主 Agent 的通信已取消。");
      return { content: [{ type: "text", text: params.wait_for_reply ? `主 Agent 回答：\n${reply}` : "消息已送入主 Agent 队列。继续当前任务，完成后提交完整结果。" }], details: {} };
    },
  });
}
