import { validateAgentDefinition } from "./agents.ts";
import type { AgentDefinition } from "./types.ts";

const READ_TOOLS = ["read", "grep", "find", "ls"];
const WRITE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const SUPPORTED = new Set([...WRITE_TOOLS, "agent_report", "agent_question"]);

/** The catalog and --tools launch argument must come from this same resolver. */
export function roleCapabilities(agent: AgentDefinition) {
  const configured = agent.tools ?? (agent.writePermission ? WRITE_TOOLS : READ_TOOLS);
  const denied = new Set(agent.disallowedTools ?? []);
  const selected = configured.filter((tool) => !denied.has(tool));
  const errors = [...validateAgentDefinition(agent), ...selected.filter((tool) => !SUPPORTED.has(tool)).map((tool) => `子进程不支持工具 ${tool}`)];
  const tools = [...new Set([...selected.filter((tool) => tool !== "agent_report" && SUPPORTED.has(tool)), ...(!denied.has("agent_question") ? ["agent_question"] : [])])];
  return { tools, errors, canWrite: tools.some((tool) => ["write", "edit", "bash"].includes(tool)), canExecute: tools.includes("bash"), canAsk: tools.includes("agent_question") };
}

export function roleCapabilityCatalog(agents: AgentDefinition[]): string {
  return agents.map((agent) => {
    const capability = roleCapabilities(agent);
    const aliases = agent.id === "worker" ? " / general-purpose" : agent.id === "scout" ? " / Explore" : "";
    return `${agent.id}${aliases}：${agent.description}；${capability.errors.length ? `不可用：${capability.errors.join("；")}` : `工具：${capability.tools.join(", ") || "无"}；${capability.canWrite ? "可写" : "只读"}；${capability.canExecute ? "可运行命令/测试" : "不能运行命令/测试"}；${capability.canAsk ? "可提问" : "不能提问"}`}`;
  }).join("\n");
}
