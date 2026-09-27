import { Type } from "typebox";
import type { AgentDefinition, RunDetails, RunStatus } from "./types.ts";
import type { DeckConfig } from "./config.ts";
import { messagesPath } from "./message-store.ts";

export const AgentParameters = Type.Object({
  description: Type.Optional(Type.String({ minLength: 1, description: "新建时必填的简短标题；续接时可更新本轮标题。" })),
  prompt: Type.String({ minLength: 1, description: "本次任务的目标、范围、预期交付和验收方法。" }),
  resume: Type.Optional(Type.String({ minLength: 1, description: "明确续接已结束的任务 ID 或实例名称，复用原 Pi 会话。与角色、模型、name 互斥；运行中请用 SendMessage 补充。" })),
  subagent_type: Type.Optional(Type.String({ minLength: 1, description: "角色，默认 general-purpose；Explore 为只读调查，也可使用准确的自定义角色 ID。" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "仅在明确指定模型时填写 provider/model 或已配置别名；省略则交给 Jev。" })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", description: "可选实例名称，同一主会话内唯一；后续 SendMessage 和 TaskStop 可使用此名称。" })),
  run_in_background: Type.Optional(Type.Boolean({ description: "省略或 false 时前台等待本轮结果；true 时后台执行并在结束后通知。" })),
}, { additionalProperties: false });

export const SendMessageParameters = Type.Object({
  to: Type.String({ minLength: 1, description: "当前主会话内的任务 ID 或实例名称。" }),
  message: Type.String({ minLength: 1, description: "补充要求、澄清回答或继续原任务的新要求。已结束的任务在原会话续接。" }),
  summary: Type.Optional(Type.String({ minLength: 1, description: "可选消息摘要，只用于预览和记录；不会替换完整 message。" })),
  reply_to: Type.Optional(Type.String({ minLength: 1, description: "回答澄清问题时使用通知中的问题编号。" })),
}, { additionalProperties: false });

export const TaskStopParameters = Type.Object({
  task_id: Type.String({ minLength: 1, description: "当前主会话内的任务 ID 或实例名称。" }),
}, { additionalProperties: false });

export type AgentInput = { resume: string; prompt: string; description?: string; run_in_background: boolean } | { resume?: undefined; description: string; prompt: string; subagent_type?: string; model?: string; name?: string; run_in_background: boolean };
export interface MessageInput { to: string; message: string; summary: string; reply_to?: string }

function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("参数必须是对象。");
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`不支持的参数：${key}`);
  return value as Record<string, unknown>;
}
function textField(input: Record<string, unknown>, key: string, optional = false): string | undefined {
  if (input[key] === undefined && optional) return;
  if (typeof input[key] !== "string" || !(input[key] as string).trim()) throw new Error(`${key} 必须是非空文本。`);
  return (input[key] as string).trim();
}
export function validateInstanceName(name: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error("name 须为 1–64 位字母、数字、短横线或下划线，且以字母或数字开头。");
  if (["main", "team-lead"].includes(name.toLowerCase()) || /^A-/i.test(name)) throw new Error("name 不能使用 main、team-lead 或任务 ID 前缀 A-。");
  return name;
}
export function parseAgentInput(value: unknown): AgentInput {
  const input = fields(value, ["description", "prompt", "resume", "subagent_type", "model", "name", "run_in_background"]);
  const resume = textField(input, "resume", true);
  if (input.run_in_background !== undefined && typeof input.run_in_background !== "boolean") throw new Error("run_in_background 必须是布尔值。");
  const run_in_background = input.run_in_background === true;
  if (resume) {
    if (["subagent_type", "model", "name"].some((key) => input[key] !== undefined)) throw new Error("resume 沿用原角色、模型和实例名称，不能同时指定 subagent_type、model 或 name。");
    return { resume, prompt: textField(input, "prompt")!, description: textField(input, "description", true), run_in_background };
  }
  const name = textField(input, "name", true);
  return { description: textField(input, "description")!, prompt: textField(input, "prompt")!, subagent_type: textField(input, "subagent_type", true), model: textField(input, "model", true), name: name === undefined ? undefined : validateInstanceName(name), run_in_background };
}
export function messagePreview(message: string): string { return message.trim().split(/\r?\n/, 1)[0].slice(0, 200); }
export function parseMessageInput(value: unknown): MessageInput {
  const input = fields(value, ["to", "message", "summary", "reply_to"]);
  textField(input, "message");
  const message = input.message as string;
  return { to: textField(input, "to")!, message, summary: messagePreview(textField(input, "summary", true) ?? message), ...(input.reply_to === undefined ? {} : { reply_to: textField(input, "reply_to")! }) };
}
export function parseStopInput(value: unknown): { task_id: string } { return { task_id: textField(fields(value, ["task_id"]), "task_id")! }; }

const ROLE_ALIASES: Record<string, string> = { "general-purpose": "worker", general: "worker", worker: "worker", Explore: "scout", explore: "scout", scout: "scout", reviewer: "reviewer" };
export function resolveAgentRole(requested: string | undefined, agents: AgentDefinition[]): AgentDefinition {
  const id = requested ?? "general-purpose";
  const mapped = Object.hasOwn(ROLE_ALIASES, id) ? ROLE_ALIASES[id] : id;
  if (mapped !== id && agents.some((agent) => agent.id === id)) throw new Error(`角色别名 ${id} 与自定义角色 ID 冲突；请改名后再使用此别名，或使用准确的目标角色 ID ${mapped}。`);
  const agent = agents.find((item) => item.id === mapped);
  if (!agent) throw new Error(`找不到 Agent 角色“${id}”。可用角色：${agents.map((item) => item.id).join("、")}`);
  return agent;
}

export function resolveModelOverride(input: string | undefined, config: DeckConfig): string | undefined {
  if (input === undefined || input.includes("/")) return input;
  if (!Object.hasOwn(config.modelAliases, input)) throw new Error(`模型别名“${input}”尚未配置；请使用 provider/model，或在 modelAliases 中明确映射。`);
  return config.modelAliases[input];
}
export function runTitle(run: Pick<RunDetails, "description" | "objective">): string { return run.description || run.objective; }
export function runRoleLabel(run: Pick<RunDetails, "instanceName" | "agentName">): string { return run.instanceName ? `${run.instanceName} · 角色：${run.agentName}` : run.agentName; }
export function statusLabel(status: string): string { return status === "已完成" ? "已返回结果" : status; }
const STATUSES: Record<RunStatus, string> = { "选配中": "selecting", "排队中": "queued", "运行中": "async_launched", "等待批准": "awaiting_approval", "等待决定": "awaiting_input", "停止中": "stopping", "停止未确认": "stop_unconfirmed", "已停止": "stopped", "已完成": "completed", "失败": "failed", "已取消": "cancelled", "失联": "lost" };
export type MessageDelivery = "queued" | "answered" | "resumed" | "existing";
export function publicTaskResult(run: RunDetails, message: string, delivery?: MessageDelivery, messageId?: string) {
  const pendingQuestion = run.pendingQuestion ?? (run.version < 3 && run.status === "等待决定" ? run.legacy?.pendingQuestion : undefined);
  return {
    agentId: run.runId, name: run.instanceName, description: runTitle(run), agentType: run.roleId,
    status: STATUSES[run.status], statusText: run.status,
    resourceState: run.resourceState, queuedMessageCount: run.queuedMessageCount ?? 0,
    resolvedModel: run.routingPending ? undefined : run.model,
    thinking: run.routingPending ? undefined : run.thinking,
    ...(pendingQuestion ? { pendingQuestion } : {}),
    delivery, message, messageId, messagesPath: messagesPath(run.runId),
  };
}
/** The model receives content, not details. Keep control addresses in every receipt. */
export function taskMessage(run: RunDetails, message: string, delivery?: MessageDelivery, messageId?: string): string {
  const header = [
    `agentId: ${run.runId}`,
    run.instanceName ? `name: ${run.instanceName}` : undefined,
    `agentType: ${run.roleId}`,
    run.turnId ? `turnId: ${run.turnId}` : undefined,
    `状态：${statusLabel(run.status)}`,
    run.resourceState ? `resourceState: ${run.resourceState}` : undefined,
    run.routingPending ? undefined : `model: ${run.model} · thinking: ${run.thinking}`,
    delivery ? `delivery: ${delivery}` : undefined,
    messageId ? `messageId: ${messageId}` : undefined,
    `messagesPath: ${messagesPath(run.runId)}`,
    run.reportPath ? `reportPath: ${run.reportPath}` : undefined,
    run.failureReason && !message.includes(run.failureReason) ? `运行原因：${run.failureReason}` : undefined,
    run.persistenceError && !message.includes(run.persistenceError) ? `保存记录：${run.persistenceError}` : undefined,
  ].filter((line) => line !== undefined).join("\n");
  return `${header}\n\n${message}`;
}
export function taskToolResult(run: RunDetails, message: string, delivery?: MessageDelivery, messageId?: string) {
  const publicResult = publicTaskResult(run, message, delivery, messageId);
  return { content: [{ type: "text" as const, text: taskMessage(run, message, delivery, messageId) }], details: { publicResult, run } };
}
