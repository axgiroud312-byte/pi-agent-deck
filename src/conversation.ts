import * as fs from "node:fs";
import { SessionManager, parseSessionEntries } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { liveConversation, type PersistedRun } from "./runtime.ts";

export interface ConversationBlock { key: string; text: string }
const cache = new Map<string, { stamp: string; messages: any[] }>();
const key = (message: any) => `${message.role}:${message.timestamp}:${message.toolCallId ?? ""}`;
function text(content: any, expanded: boolean): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((part: any) => {
    if (part.type === "text") return part.text;
    if (part.type === "image") return "[图片]";
    if (part.type !== "toolCall") return "";
    const args = JSON.stringify(part.arguments, null, 2) ?? "";
    return `工具调用：${part.name}\n${!expanded && args.length > 600 ? args.slice(0, 600) + "\n[长工具参数已折叠，按 O 展开]" : args}`;
  }).filter(Boolean).join("\n");
}

/** Read the active Pi branch, merge in-flight events; never resume or write a session. */
export function conversationBlocks(run: PersistedRun, expanded = false): ConversationBlock[] {
  let messages: any[] = [];
  let warning: string | undefined;
  if (run.childSessionPath) {
    try {
      const stat = fs.statSync(run.childSessionPath);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      let saved = cache.get(run.childSessionPath);
      if (saved?.stamp !== stamp) {
        const entries = SessionManager.inMemory(run.cwd, undefined, parseSessionEntries(fs.readFileSync(run.childSessionPath, "utf8"))).getBranch();
        saved = { stamp, messages: entries.flatMap((entry) => entry.type === "message" ? [entry.message] : []) };
        if (cache.size >= 16) cache.delete(cache.keys().next().value!);
        cache.set(run.childSessionPath, saved);
      }
      messages = [...saved.messages];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") warning = `会话读取失败：${String(error)}`;
    }
  }
  for (const message of liveConversation(run.runId)) {
    const found = messages.findIndex((saved) => key(saved) === key(message));
    if (found >= 0) messages[found] = message; else messages.push(message);
  }
  const blocks: ConversationBlock[] = warning ? [{ key: "warning", text: warning }] : [];
  for (const [index, message] of messages.entries()) {
    const heading = message.role === "user" ? "主 Agent · 任务/补充" : message.role === "assistant" ? "子 Agent" : message.role === "toolResult" ? `工具结果：${message.toolName}${message.isError ? " · 失败" : ""}` : "会话记录";
    let body = text(message.content, expanded);
    if (message.errorMessage) body += `\n错误：${message.errorMessage}`;
    if (!body.trim()) continue;
    if (message.role === "toolResult" && !expanded && body.length > 600) body = body.slice(0, 600) + "\n[长工具输出已折叠，按 O 展开]";
    blocks.push({ key: `${key(message)}:${index}`, text: stripTerminalSequences(`${heading}\n${body}\n`) });
  }
  return blocks;
}
