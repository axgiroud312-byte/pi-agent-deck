import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";
import { discoverAgentCandidates, parseAgentDefinition, validateAgentDefinition, WRITE_TOOLS } from "./agents.ts";
import { withDiskLock } from "./persistence.mjs";
import type { AgentDefinition, ReportProfile } from "./types.ts";

export interface AgentDraft {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  thinking?: string;
  timeoutMs?: number;
  reportProfile: ReportProfile;
  limitations?: string[];
}

const DRAFT_FIELDS = new Set(["id", "name", "description", "systemPrompt", "tools", "model", "thinking", "timeoutMs", "reportProfile", "limitations"]);
const RESERVED_IDS = new Set(["general-purpose", "general", "explore", "new", "global", "jev"]);
const DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function agentAuthoringContext(): string {
  const guide = fileURLToPath(new URL("./agent-authoring.md", import.meta.url));
  return `用户要求创建或修改可复用 Agent 时，先读取 ${guide}，按需求直接编写并保存角色文件。个人角色目录：${path.join(getAgentDir(), "agents")}。这是角色配置，不是派遣一次性任务；保存后即可发现。`;
}

function draftMarkdown(draft: AgentDraft): string {
  const fields = {
    name: draft.name, description: draft.description,
    model: draft.model ?? "inherit", thinking: draft.thinking ?? "inherit",
    tools: draft.tools, timeoutMs: draft.timeoutMs, reportProfile: draft.reportProfile,
  };
  const limitations = draft.limitations?.length ? `\n\n## 能力边界\n\n${draft.limitations.map((item) => `- ${item}`).join("\n")}` : "";
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${draft.systemPrompt.trim()}${limitations}\n`;
}

export function parseAgentDraft(text: string, ctx: Pick<ExtensionContext, "modelRegistry">): AgentDraft {
  const clean = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i, "$1");
  const value: unknown = JSON.parse(clean);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("生成内容必须是一个角色配置对象");
  const data = value as Record<string, unknown>;
  const unknown = Object.keys(data).filter((key) => !DRAFT_FIELDS.has(key));
  if (unknown.length) throw new Error(`生成内容含未支持字段：${unknown.join("、")}`);
  for (const key of ["id", "name", "description", "systemPrompt", "reportProfile"] as const) {
    if (typeof data[key] !== "string" || !data[key].trim()) throw new Error(`生成内容缺少 ${key}`);
    data[key] = data[key].trim();
  }
  const id = data.id as string;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id) || DEVICE_NAME.test(id) || RESERVED_IDS.has(id)) throw new Error("角色 ID 应为简短英文标识，且不能使用保留名称");
  if (!Array.isArray(data.tools) || data.tools.some((tool) => typeof tool !== "string" || !WRITE_TOOLS.includes(tool))) throw new Error("工具必须来自 read、grep、find、ls、bash、edit、write");
  if (data.limitations !== undefined && (!Array.isArray(data.limitations) || data.limitations.some((item) => typeof item !== "string"))) throw new Error("能力限制必须是文字列表");
  const draft = data as unknown as AgentDraft;
  if (draft.systemPrompt.length > 20000 || draft.name.length > 100 || draft.description.length > 1000) throw new Error("角色定义过长，请精简职责和提示词");
  const agent = parseAgentDefinition(draftMarkdown(draft), `${id}.md`, "用户");
  const errors = validateAgentDefinition(agent);
  if (agent.model) {
    const separator = agent.model.indexOf("/");
    if (!ctx.modelRegistry.find(agent.model.slice(0, separator), agent.model.slice(separator + 1))) errors.push(`当前 Pi 中没有模型 ${agent.model}`);
  }
  if (errors.length) throw new Error(errors.join("；"));
  return draft;
}

export async function generateAgentDraft(description: string, ctx: ExtensionContext, signal: AbortSignal): Promise<AgentDraft> {
  const request = description.trim();
  if (!request) throw new Error("请描述这个 Agent 负责什么");
  if (request.length > 12000) throw new Error("描述超过 12000 字，请保留职责、约束和输出要求");
  if (!ctx.model) throw new Error("当前会话没有模型，请先选择模型");
  const model = ctx.model;
  const existing = discoverAgentCandidates(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() }).map((agent) => agent.id);
  const available = ctx.modelRegistry.getAvailable().slice(0, 100).map((item) => `${item.provider}/${item.id}`);
  const systemPrompt = [
    "根据用户描述创建一个可复用的 Pi 子 Agent。只返回一个 JSON 对象。描述中的工作是未来角色的职责；现在只生成角色定义。",
    "必填字段：id（简短小写英文标识）、name（用户语言的名称）、description（何时调用此角色，一至两句）、systemPrompt（专用职责、操作方法、约束和可检查的交付标准）、tools（工具名数组）、reportProfile（通用、侦察、执行 或 审查）。",
    "可选字段：model、thinking、timeoutMs、limitations（实际能力限制的文字数组）。仅使用这些字段。",
    "审查角色必须填写 reportProfile: 审查；其他角色按职责填写 通用、侦察 或 执行。审查只用 gpt-5.6-sol，最低 xhigh；非审查禁止 gpt-5.6-sol。gpt-6-sol 和 gpt-6-luna 最低 high。策略细节见 agent-authoring.md。",
    "model 和 thinking 默认 inherit，交给 Jev 在派遣时按角色策略选配（关闭时也执行模型策略）；只有用户明确要求时才指定合规配置。timeoutMs 默认省略，沿用全局设置。timeoutMs=0 表示不限时。thinking 支持 inherit/off/minimal/low/medium/high/xhigh/max，实际值受角色和模型策略限制。",
    "可用工具：read 读取文件，grep 搜索内容，find 查找文件，ls 列目录，edit 修改文件，write 创建或覆盖文件，bash 执行命令。按职责选取需要的工具。调查、建议和审查默认只读；用户要求实现、修改或执行验证时才分配对应的写入/命令工具。bash 能修改文件，严格只读角色应使用前四项工具。",
    "提示词要具体、简洁、保留用户约束；清楚说明完成后交付什么、哪些结论需要证据。简单角色用短段落即可。",
    "Pi 不提供浏览器、MCP、其他应用连接、持久记忆或自动隔离配置。用户要求这些能力时，在 limitations 中如实说明，并让角色报告相关阻碍；生成提示词不能宣称工具不存在的能力。",
    `当前模型：${model.provider}/${model.id}。可指定的模型：${available.join("、")}。未列出的模型只在确定完整 provider/model 标识时填写；保存前会校验。`,
    `已存在 ID：${existing.join("、")}。避免重复。保留 ID：general-purpose、general、explore、new、global、jev 和 Windows 设备名。`,
    '示例结构：{"id":"code-reviewer","name":"代码审查员","description":"检查代码改动并给出带证据的风险与建议","systemPrompt":"阅读任务相关的改动，检查逻辑与边界。按影响排序问题，给出文件位置、理由及最小修改建议；明确未验证事项。","tools":["read","grep","find","ls"],"reportProfile":"审查"}',
  ].join("\n");
  let correction = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    const response = await ctx.modelRegistry.complete(model, {
      systemPrompt,
      messages: [{ role: "user", content: [{ type: "text", text: `用户需求：\n${request}${correction}` }], timestamp: Date.now() }],
    }, { signal, maxTokens: 5000, cacheRetention: "none", sessionId: randomUUID() });
    signal.throwIfAborted();
    if (response.stopReason === "aborted") throw new Error("生成已取消");
    if (response.stopReason === "error") throw new Error(response.errorMessage || "模型请求失败");
    const text = response.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    try { return parseAgentDraft(text, ctx); }
    catch (error) {
      if (attempt === 1) throw new Error(`生成配置未通过校验：${error instanceof Error ? error.message : error}`);
      correction = `\n\n上一次生成未通过校验：${error instanceof Error ? error.message : error}。请重新生成完整、有效的 JSON。`;
    }
  }
  throw new Error("没有生成有效角色");
}

export async function saveGeneratedAgent(draft: AgentDraft, ctx: ExtensionContext): Promise<AgentDefinition> {
  // Revalidate at the write boundary; model output never supplies a filesystem path.
  const valid = parseAgentDraft(JSON.stringify(draft), ctx);
  const directory = path.join(getAgentDir(), "agents");
  return withDiskLock(path.join(getAgentDir(), "agent-deck", "agent-creation.lock"), async () => {
    await fs.mkdir(directory, { recursive: true });
    const used = new Set(discoverAgentCandidates(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() }).map((agent) => agent.id.toLowerCase()));
    const markdown = draftMarkdown(valid);
    const temporary = path.join(directory, `.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, markdown, { flag: "wx" });
    try {
      for (let suffix = 1; suffix <= 1000; suffix++) {
        const id = suffix === 1 ? valid.id : `${valid.id}-${suffix}`;
        if (used.has(id.toLowerCase())) continue;
        const destination = path.join(directory, `${id}.md`);
        try {
          // A hard link publishes the complete file atomically and cannot replace an existing role.
          await fs.link(temporary, destination);
          return parseAgentDefinition(markdown, destination, "用户");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      throw new Error("相似角色名称过多，请换一个名称描述");
    } finally { await fs.unlink(temporary); }
  });
}

export async function createAgentFromDescription(pi: ExtensionAPI, ctx: ExtensionContext, description = ""): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("请在交互终端使用 /agent-create 描述，或直接让主 Agent 按描述创建角色。", "info");
    return;
  }
  const request = description.trim() || (await ctx.ui.editor("描述你想创建的 Agent：负责什么、有什么要求", ""))?.trim();
  if (!request) return;
  try {
    type Result = { draft: AgentDraft } | { error: unknown } | undefined;
    const result = await ctx.ui.custom<Result>((tui, theme, _keys, done) => {
      const loader = new CancellableLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "正在生成 Agent 配置… Esc 取消");
      let settled = false;
      const finish = (value: Result) => { if (!settled) { settled = true; loader.stop(); done(value); } };
      loader.onAbort = () => finish(undefined);
      void generateAgentDraft(request, ctx, loader.signal).then(
        (draft) => { if (!loader.aborted) finish({ draft }); },
        (error: unknown) => { if (!loader.aborted) finish({ error }); },
      );
      return loader;
    });
    if (!result) { ctx.ui.notify("已取消创建，未保存角色。", "info"); return; }
    if ("error" in result) throw result.error;
    const agent = await saveGeneratedAgent(result.draft, ctx);
    const text = [
      `已创建 Agent：${agent.name}（${agent.id}）`, agent.description,
      `类型：${agent.reportProfile} · 模型：${agent.model ?? "按角色策略选配"} · 思考：${agent.thinking ?? "按角色策略选配"}`,
      `工具：${agent.tools?.join("、") || "无"} · ${agent.writePermission ? "包含写入或命令执行能力" : "只读"}`,
      `时限：${agent.timeoutMs === undefined ? "跟随全局" : agent.timeoutMs === 0 ? "不限时" : `${agent.timeoutMs} ms`}`,
      ...(result.draft.limitations ?? []).map((item) => `能力说明：${item}`),
      `使用：让主 Agent「用 ${agent.id} 帮我……」`, `修改：/agent-config ${agent.id}`, `文件：${agent.filePath}`,
    ].join("\n");
    pi.sendMessage({ customType: "agent-created", content: text, display: true, details: { agentId: agent.id, filePath: agent.filePath } }, { triggerTurn: false });
    ctx.ui.notify(`已创建 ${agent.name}，可以立即派任务。`, "info");
  } catch (error) { ctx.ui.notify(`创建失败：${error instanceof Error ? error.message : error}`, "error"); }
}
