import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentSource, ReportProfile } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REPORT_PROFILES = new Set<ReportProfile>(["通用", "侦察", "执行", "审查"]);
export const READ_TOOLS = ["read", "grep", "find", "ls"];
export const WRITE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const TOOL_ALIASES: Record<string, string> = { glob: "find" };
const SUPPORTED_FIELDS = new Set(["id", "name", "description", "model", "thinking", "tools", "disallowedTools", "writePermission", "timeoutMs", "maxConcurrent", "reportProfile"]);

type Frontmatter = Record<string, unknown>;

function parseStringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const result = values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return value === undefined ? undefined : result;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (["true", "yes", "1", "是"].includes(value.toLowerCase())) return true;
    if (["false", "no", "0", "否"].includes(value.toLowerCase())) return false;
  }
  return fallback;
}

export function parseAgentDefinition(text: string, filePath: string, source: AgentSource): AgentDefinition {
  const { frontmatter: f, body } = parseFrontmatter<Frontmatter>(text);
  const id = typeof f.id === "string" ? f.id.trim() : path.basename(filePath, ".md");
  const name = typeof f.name === "string" ? f.name.trim() : id;
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Agent 文件名或 id 只能包含字母、数字、短横线和下划线。");
  if (!name || !body.trim()) throw new Error("Agent 名称和提示词不能为空。");
  const errors = Object.keys(f).filter((key) => !SUPPORTED_FIELDS.has(key)).map((key) => `不支持配置 ${key}；请查看 README 支持的字段`);
  const list = (key: string): string[] | undefined => {
    const raw = f[key];
    if (raw !== undefined && typeof raw !== "string" && (!Array.isArray(raw) || raw.some((item) => typeof item !== "string"))) errors.push(`${key} 必须是工具名列表`);
    return parseStringList(raw)?.map((tool) => TOOL_ALIASES[tool.toLowerCase()] ?? tool.toLowerCase());
  };
  const specifiedTools = list("tools");
  const disallowedTools = list("disallowedTools") ?? [];
  for (const tool of [...(specifiedTools ?? []), ...disallowedTools]) if (![...WRITE_TOOLS, "agent_report", "agent_question"].includes(tool)) errors.push(`Pi 子 Agent 不支持工具 ${tool}`);
  if (f.writePermission !== undefined && typeof f.writePermission !== "boolean" && !["true", "false", "yes", "no", "1", "0", "是", "否"].includes(String(f.writePermission).toLowerCase())) errors.push("writePermission 必须是布尔值");
  const writable = (tools: string[]) => tools.some((tool) => ["bash", "write", "edit"].includes(tool));
  const requestedWrite = parseBoolean(f.writePermission, writable(specifiedTools ?? []));
  const tools = (specifiedTools ?? (requestedWrite ? WRITE_TOOLS : READ_TOOLS)).filter((tool) => !disallowedTools.includes(tool));
  const writePermission = f.writePermission === undefined ? writable(tools) : requestedWrite && writable(tools);
  if (f.writePermission !== undefined && !requestedWrite && writable(tools)) errors.push("只读 Agent 配置了 bash/edit/write，请移除这些工具或启用 writePermission");
  const integer = (key: string, minimum: number): number | undefined => {
    if (f[key] === undefined) return undefined;
    if (!Number.isSafeInteger(f[key]) || Number(f[key]) < minimum) { errors.push(`${key} 必须是至少为 ${minimum} 的整数`); return undefined; }
    return f[key] as number;
  };
  const thinking = f.thinking === "inherit" || f.thinking === undefined ? undefined : f.thinking as ThinkingLevel;
  if (thinking !== undefined && !THINKING_LEVELS.has(thinking)) errors.push(`不支持的 thinking：${thinking}`);
  const model = typeof f.model === "string" && f.model.trim() && f.model.trim() !== "inherit" ? f.model.trim() : undefined;
  if (f.model !== undefined && typeof f.model !== "string") errors.push("model 必须是 inherit 或 provider/model");
  if (model && !/^[^/]+\/.+$/.test(model)) errors.push("model 必须使用 Pi 的 provider/model 格式；Claude 的 sonnet/opus 别名不能直接使用");
  const definition: AgentDefinition = {
    id, name, description: typeof f.description === "string" ? f.description.trim() : "自定义 Agent",
    systemPrompt: body.trim(), source, filePath, model, thinking, tools, disallowedTools, writePermission,
    timeoutMs: integer("timeoutMs", 0),
    reportProfile: REPORT_PROFILES.has(f.reportProfile as ReportProfile) ? f.reportProfile as ReportProfile : "通用",
    configurationErrors: errors,
  };
  return definition;
}

function loadDirectory(directory: string, source: AgentSource): AgentDefinition[] {
  if (!fs.existsSync(directory)) return [];
  const definitions: AgentDefinition[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const text = fs.readFileSync(filePath, "utf8");
      definitions.push(parseAgentDefinition(text, filePath, source));
    } catch (error) {
      // Keep invalid overrides visible instead of silently falling back to a broader built-in role.
      definitions.push({ id: path.basename(entry.name, ".md"), name: path.basename(entry.name, ".md"), description: "配置错误，运行前需修正", systemPrompt: "", source, filePath, tools: [], writePermission: false, reportProfile: "通用", configurationErrors: [error instanceof Error ? error.message : String(error)] });
    }
  }
  return definitions;
}

function findProjectAgentsDirectory(cwd: string): string | undefined {
  let current = path.resolve(cwd);
  while (true) {
    const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function getBuiltinAgentsDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
}

export function discoverAgentCandidates(cwd: string, options: { projectTrusted?: boolean } = {}): AgentDefinition[] {
  const directories: Array<[string, AgentSource]> = [
    [getBuiltinAgentsDirectory(), "内置"],
    [path.join(getAgentDir(), "agents"), "用户"],
  ];
  const projectDirectory = options.projectTrusted ? findProjectAgentsDirectory(cwd) : undefined;
  if (projectDirectory) directories.push([projectDirectory, "项目"]);
  return directories.flatMap(([directory, source]) => loadDirectory(directory, source));
}

export function discoverAgents(cwd: string, options: { projectTrusted?: boolean } = {}): AgentDefinition[] {
  const map = new Map<string, AgentDefinition>();
  // 后加载者覆盖同 ID：内置 < 用户 < 项目。
  for (const definition of discoverAgentCandidates(cwd, options)) map.set(definition.id, definition);
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
}

export function validateAgentDefinition(agent: AgentDefinition): string[] {
  const errors: string[] = [...(agent.configurationErrors ?? [])];
  const dangerous = new Set(["bash", "powershell", "edit", "write"]);
  if (!agent.writePermission) {
    const forbidden = (agent.tools ?? []).filter((tool) => dangerous.has(tool));
    if (forbidden.length > 0) errors.push(`只读 Agent 配置了潜在写入工具：${forbidden.join("、")}`);
  }
  if (agent.writePermission && !(agent.tools ?? []).some((tool) => ["bash", "powershell", "edit", "write"].includes(tool))) {
    errors.push("Agent 允许写入，但没有配置任何执行或写入工具");
  }
  return errors;
}
