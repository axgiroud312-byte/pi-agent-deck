import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentSource } from "./types.ts";

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const TOOL_ALIASES: Record<string, string> = { glob: "find" };
const BUILTIN_TOOL_NAMES = new Set(BUILTIN_TOOLS);
// writePermission/reportProfile are accepted only to read existing role files.
const SUPPORTED_FIELDS = new Set(["id", "name", "description", "model", "thinking", "tools", "disallowedTools", "extensions", "writePermission", "timeoutMs", "reportProfile"]);

type Frontmatter = Record<string, unknown>;

export function parseStringList(value: unknown): string[] | undefined {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const result = values.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  return value === undefined ? undefined : result;
}

export function parseLegacyWritePermission(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1) return true;
  if (value === 0) return false;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "1", "是"].includes(normalized)) return true;
  if (["false", "no", "0", "否"].includes(normalized)) return false;
  return undefined;
}

/** Known Pi tool names are case-insensitive; extension tool names are not. */
export function normalizeToolName(tool: string): string {
  const lower = tool.toLowerCase();
  return TOOL_ALIASES[lower] ?? (BUILTIN_TOOL_NAMES.has(lower) ? lower : tool);
}

function extensionPath(value: string, roleFile: string): string {
  const expanded = value === "~" ? os.homedir() : value.startsWith(`~${path.sep}`) || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(path.dirname(roleFile), expanded));
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
    return parseStringList(raw)?.map(normalizeToolName);
  };
  const specifiedTools = list("tools");
  const disallowedTools = list("disallowedTools") ?? [];
  // Compatibility for pre-0.13 role files: the old read-only flag becomes the
  // two concrete Pi tool exclusions and otherwise has no runtime meaning.
  const legacyWritePermission = f.writePermission === undefined ? undefined : parseLegacyWritePermission(f.writePermission);
  if (f.writePermission !== undefined && legacyWritePermission === undefined) errors.push("writePermission 必须是布尔值");
  if (legacyWritePermission === false) {
    for (const tool of ["edit", "write"]) if (!disallowedTools.includes(tool)) disallowedTools.push(tool);
  }
  let extensions: string[] = [];
  const rawExtensions = parseStringList(f.extensions);
  if (f.extensions !== undefined && typeof f.extensions !== "string" && (!Array.isArray(f.extensions) || f.extensions.some((item) => typeof item !== "string"))) {
    errors.push("extensions 必须是本地扩展入口路径列表");
  } else {
    for (const configured of rawExtensions ?? []) {
      try {
        const resolved = extensionPath(configured, filePath);
        if (!extensions.some((item) => process.platform === "win32" ? item.toLowerCase() === resolved.toLowerCase() : item === resolved)) extensions.push(resolved);
      } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
    }
  }
  const tools = specifiedTools?.filter((tool) => !disallowedTools.includes(tool));
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
    systemPrompt: body.trim(), source, filePath, model, thinking, tools, extensions, disallowedTools,
    timeoutMs: integer("timeoutMs", 0),
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
      definitions.push({ id: path.basename(entry.name, ".md"), name: path.basename(entry.name, ".md"), description: "配置错误，运行前需修正", systemPrompt: "", source, filePath, tools: [], extensions: [], configurationErrors: [error instanceof Error ? error.message : String(error)] });
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
  return [...(agent.configurationErrors ?? [])];
}
