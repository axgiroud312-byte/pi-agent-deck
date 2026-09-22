import { Type } from "typebox";
import type { AgentDefinition, RunDetails, RunStatus } from "./types.ts";
import type { DeckConfig } from "./config.ts";
import type { RoutingContext } from "./routing.ts";

export const AgentParameters = Type.Object({
  description: Type.String({ minLength: 1, description: "简短任务标题，用于面板和回执；支持中文。" }),
  prompt: Type.String({ minLength: 1, description: "完整任务说明，包含背景、范围和期望结果。" }),
  subagent_type: Type.Optional(Type.String({ minLength: 1, description: "角色，默认 general-purpose；Explore 为只读调查，也可使用准确的自定义角色 ID。" })),
  model: Type.Optional(Type.String({ minLength: 1, description: "仅在明确指定模型时填写 provider/model 或已配置别名；省略则交给 Jev。" })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9_-]*$", description: "可选实例名称，同一主会话内唯一；后续 SendMessage 和 TaskStop 可使用此名称。" })),
  run_in_background: Type.Optional(Type.Literal(true, { description: "仅支持 true 或省略。本版本仅支持后台任务。" })),
}, { additionalProperties: false });

export const SendMessageParameters = Type.Object({
  to: Type.String({ minLength: 1, description: "当前主会话内的任务 ID 或实例名称。" }),
  message: Type.String({ minLength: 1, description: "完整补充要求或问题答复，按纯文本处理。运行中则排队，结束后在原会话继续。" }),
  summary: Type.Optional(Type.String({ minLength: 1, description: "可选消息摘要，只用于预览和记录；不会替换完整 message。" })),
}, { additionalProperties: false });

export const TaskStopParameters = Type.Object({
  task_id: Type.String({ minLength: 1, description: "当前主会话内的任务 ID 或实例名称。" }),
}, { additionalProperties: false });

export interface AgentInput { description: string; prompt: string; subagent_type?: string; model?: string; name?: string; run_in_background?: true }
export interface MessageInput { to: string; message: string; summary: string }

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
  const input = fields(value, ["description", "prompt", "subagent_type", "model", "name", "run_in_background"]);
  if (input.run_in_background !== undefined && input.run_in_background !== true) throw new Error("本版本仅支持后台任务：run_in_background 只能为 true 或省略。");
  const name = textField(input, "name", true);
  return { description: textField(input, "description")!, prompt: textField(input, "prompt")!, subagent_type: textField(input, "subagent_type", true), model: textField(input, "model", true), name: name === undefined ? undefined : validateInstanceName(name) };
}
export function messagePreview(message: string): string { return message.trim().split(/\r?\n/, 1)[0].slice(0, 200); }
export function parseMessageInput(value: unknown): MessageInput {
  const input = fields(value, ["to", "message", "summary"]);
  textField(input, "message");
  const message = input.message as string;
  return { to: textField(input, "to")!, message, summary: messagePreview(textField(input, "summary", true) ?? message) };
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
export function requireAvailableModel(model: string | undefined, ctx: RoutingContext): void {
  if (!model) return;
  if (!/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error("模型必须使用 provider/model 格式。");
  const split = model.indexOf("/");
  if (!ctx.modelRegistry?.find(model.slice(0, split), model.slice(split + 1))) throw new Error(`找不到配置的模型：${model}`);
  if (!ctx.modelRegistry.getAvailable().some((item) => `${item.provider}/${item.id}` === model)) throw new Error(`模型不可用或尚未配置认证：${model}`);
}

export function runTitle(run: Pick<RunDetails, "description" | "objective">): string { return run.description || run.objective; }
export function runRoleLabel(run: Pick<RunDetails, "instanceName" | "agentName">): string { return run.instanceName ? `${run.instanceName} · 角色：${run.agentName}` : run.agentName; }
const STATUSES: Record<RunStatus, string> = { "选配中": "selecting", "排队中": "queued", "运行中": "async_launched", "等待批准": "awaiting_approval", "等待决定": "awaiting_input", "停止中": "stopping", "停止未确认": "stop_unconfirmed", "已停止": "stopped", "已完成": "completed", "失败": "failed", "已取消": "cancelled", "失联": "lost" };
export function publicTaskResult(run: RunDetails, message: string, delivery?: "queued" | "resumed") {
  return {
    agentId: run.runId, name: run.instanceName, description: runTitle(run), agentType: run.agentId,
    status: STATUSES[run.status], statusText: run.status,
    resolvedModel: run.routingPending ? undefined : run.model,
    thinking: run.routingPending ? undefined : run.thinking,
    delivery, message,
  };
}
export function taskToolResult(run: RunDetails, message: string, delivery?: "queued" | "resumed", success?: boolean) {
  const publicResult = { ...publicTaskResult(run, message, delivery), ...(success === undefined ? {} : { success }) };
  return { content: [{ type: "text" as const, text: JSON.stringify(publicResult, null, 2) }], details: { publicResult, run } };
}
