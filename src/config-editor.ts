import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { parseAgentDefinition, validateAgentDefinition } from "./agents.ts";
import { parseDeckConfig, readDeckConfig, writeDeckConfig, type DeckConfig } from "./config.ts";
import { frame, plain } from "./presentation.ts";
import { withDiskLock } from "./persistence.mjs";
import type { AgentDefinition } from "./types.ts";
import { selectMenu as choose } from "./menu.ts";
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
function duration(value: number | undefined): string { return value === undefined ? "跟随全局" : value === 0 ? "不限时" : `${value / 60000} 分钟`; }

async function numberInput(ctx: ExtensionContext, title: string, current: number, minimum: number): Promise<number | undefined> {
  const text = await ctx.ui.input(title, String(current));
  if (text === undefined || !text.trim()) return;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < minimum) { ctx.ui.notify(`请输入至少为 ${minimum} 的整数。`, "error"); return; }
  return value;
}
async function chooseDuration(ctx: ExtensionContext, current: number | undefined, inherit: boolean): Promise<{ value: number | undefined } | undefined> {
  const choice = await choose(ctx, "执行时限", [
    ...(inherit ? [{ value: "inherit", label: `跟随全局 · ${duration(readDeckConfig().timeoutMs)}` }] : []),
    { value: "none", label: "不限时" }, { value: "custom", label: "自定义分钟数" },
  ]);
  if (choice === "inherit") return { value: undefined };
  if (choice === "none") return { value: 0 };
  if (choice === "custom") {
    const minutes = await numberInput(ctx, "最多运行多少分钟？0 表示不限时", Math.ceil((current ?? 0) / 60000), 0);
    if (minutes !== undefined && Number.isSafeInteger(minutes * 60000)) return { value: minutes * 60000 };
  }
}

export async function editGlobalConfig(ctx: ExtensionContext, changed: (ctx: ExtensionContext) => void, raw = false): Promise<void> {
  const original = readDeckConfig();
  let draft = structuredClone(original);
  let action: string | undefined = raw ? "raw" : undefined;
  let selected: string | undefined;
  while (true) {
    if (!action) action = await choose(ctx, `全局设置${JSON.stringify(draft) !== JSON.stringify(original) ? " · 未保存" : ""}`, [
      { value: "enabled", label: `派遣开关     ${draft.enabled ? "开启" : "关闭"}` },
      { value: "routing", label: `Jev 自动选配 ${draft.routing.enabled ? "开启" : "关闭"}` },
      { value: "timeout", label: `默认时限     ${duration(draft.timeoutMs)}` },
      { value: "save", label: "保存并返回" }, { value: "raw", label: "高级：编辑 JSON" }, { value: "cancel", label: "返回，不保存" },
    ], selected);
    if (!action || action === "cancel") return;
    selected = action;
    if (action === "enabled") {
      const value = await choose(ctx, "允许主 Agent 派遣新任务", [{ value: true, label: "开启" }, { value: false, label: "关闭" }]);
      if (value !== undefined) draft.enabled = value;
    } else if (action === "routing") {
      const value = await choose(ctx, "让 Jev 选择新任务的模型与思考强度", [{ value: true, label: "开启" }, { value: false, label: "关闭，使用合规回退配置" }]);
      if (value !== undefined) draft.routing.enabled = value;
    } else if (action === "timeout") {
      const value = await chooseDuration(ctx, draft.timeoutMs, false);
      if (value) draft.timeoutMs = value.value!;
    } else if (action === "raw") {
      const text = await ctx.ui.editor("高级全局配置", JSON.stringify(draft, null, 2));
      if (text === undefined && raw) return;
      if (text !== undefined) {
        try { draft = parseDeckConfig(JSON.parse(text)); }
        catch (error) { ctx.ui.notify(`未应用：${errorText(error)}`, "error"); action = raw ? "raw" : undefined; continue; }
      }
      if (raw) action = "save";
    }
    if (action === "save") {
      try {
        const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => JSON.stringify(original[key as keyof DeckConfig]) !== JSON.stringify(value)));
        if (patch.routing) patch.routing = Object.fromEntries(Object.entries(draft.routing).filter(([key, value]) => original.routing[key as keyof DeckConfig["routing"]] !== value));
        if (Object.keys(patch).length) { await writeDeckConfig(patch); changed(ctx); }
        ctx.ui.notify("设置已保存。选配与默认时限只用于新任务。", "info");
        return;
      } catch (error) { ctx.ui.notify(`未保存：${errorText(error)}`, "error"); if (raw) { action = "raw"; continue; } }
    }
    action = undefined;
  }
}

const TOOL_LABELS: Record<string, string> = { read: "读取文件", grep: "搜索内容", find: "查找文件", ls: "查看目录", edit: "修改已有文件", write: "写入文件", bash: "运行命令（可以修改文件）" };
export async function selectAgentTools(ctx: ExtensionContext, initial: string[]): Promise<string[] | undefined> {
  return ctx.ui.custom<string[] | undefined>((tui, theme, _keys, done) => {
    const tools = ["read", "grep", "find", "ls", "edit", "write", "bash"];
    const selected = new Set(initial.filter((tool) => tools.includes(tool)));
    let cursor = 0;
    return {
      render(width: number) {
        const count = Math.max(1, Math.min(tools.length, (tui.terminal?.rows ?? 24) - 7));
        const start = Math.max(0, Math.min(cursor - Math.floor(count / 2), tools.length - count));
        const lines = [`已选 ${selected.size} 个工具`, ""];
        for (let index = start; index < start + count; index++) {
          const tool = tools[index];
          const line = `${index === cursor ? "›" : " "} ${selected.has(tool) ? "[✓]" : "[ ]"} ${TOOL_LABELS[tool]} · ${tool}`;
          lines.push(index === cursor ? theme.fg("accent", line) : line);
        }
        lines.push("", theme.fg("muted", "↑↓ 选择 · 空格 勾选 · Enter 应用 · Esc 取消"));
        return frame(theme.fg("accent", "选择工具"), lines, width, theme);
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(tools.filter((tool) => selected.has(tool)));
        if (matchesKey(data, Key.up)) cursor = Math.max(0, cursor - 1);
        else if (matchesKey(data, Key.down)) cursor = Math.min(tools.length - 1, cursor + 1);
        else if (data === " ") { const tool = tools[cursor]; if (selected.has(tool)) selected.delete(tool); else selected.add(tool); }
        tui.requestRender();
      }, invalidate() {},
    };
  });
}

function serialize(fields: Record<string, unknown>, body: string): string {
  return `---\n${Object.entries(fields).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n")}\n---\n\n${body.trim()}\n`;
}
async function readOptional(file: string): Promise<string | undefined> {
  try { return await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

async function chooseModel(ctx: ExtensionContext): Promise<string | undefined> {
  const models = ctx.modelRegistry.getAvailable();
  const providers = [...new Set(models.map((model) => model.provider))].sort();
  const provider = await choose(ctx, "选择模型来源", [
    { value: "inherit", label: "自动选配（始终遵守角色策略）" },
    ...providers.map((value) => ({ value, label: value })),
  ]);
  if (!provider || provider === "inherit") return provider;
  return choose(ctx, `选择 ${provider} 模型`, models.filter((model) => model.provider === provider).map((model) => ({ value: `${provider}/${model.id}`, label: `${model.name || model.id} · ${model.id}` })));
}

export async function editAgentConfig(ctx: ExtensionContext, agent: AgentDefinition, raw = false): Promise<void> {
  const original = await fs.readFile(agent.filePath, "utf8");
  const destination = agent.source === "项目" ? agent.filePath : path.join(getAgentDir(), "agents", `${agent.id}.md`);
  const expectedDestination = await readOptional(destination);
  let text = original;
  let action: string | undefined = raw ? "raw" : undefined;
  let selected: string | undefined;
  while (true) {
    let fields: Record<string, unknown>, body: string, definition: AgentDefinition;
    try {
      ({ frontmatter: fields, body } = parseFrontmatter<Record<string, unknown>>(text));
      definition = parseAgentDefinition(text, destination, agent.source === "项目" ? "项目" : "用户");
    } catch (error) {
      ctx.ui.notify(`配置需要修正：${errorText(error)}`, "warning");
      const edited = await ctx.ui.editor("修正 Agent 配置", text);
      if (edited === undefined) return;
      text = edited; continue;
    }
    if (!action) action = await choose(ctx, `${plain(definition.name)}${text !== original ? " · 未保存" : ""}`, [
      { value: "model", label: `模型         ${definition.model ?? "自动选配（遵守角色策略）"}` },
      { value: "thinking", label: `思考强度     ${definition.thinking ?? "自动选配（遵守角色策略）"}` },
      { value: "tools", label: `工具         ${definition.tools?.length ?? 0} 项 · ${definition.writePermission ? "含写入/命令" : "只读"}` },
      { value: "timeout", label: `执行时限     ${duration(definition.timeoutMs)}` },
      { value: "prompt", label: "编辑角色提示词" }, { value: "description", label: "编辑调用描述" }, { value: "name", label: "修改显示名称" },
      { value: "save", label: "保存并返回" }, { value: "raw", label: "高级：编辑完整配置" }, { value: "cancel", label: "返回，不保存" },
    ], selected);
    if (!action || action === "cancel") return;
    selected = action;
    if (action === "model") {
      const model = await chooseModel(ctx);
      if (model) { fields.model = model; text = serialize(fields, body); }
    } else if (action === "thinking") {
      const level = await choose(ctx, "思考强度（保存时检查角色和模型策略）", [
        { value: "inherit", label: "自动选配（遵守角色策略）" }, { value: "off", label: "关闭 · off（需符合模型策略）" }, { value: "minimal", label: "最低 · minimal（由模型映射）" }, { value: "low", label: "低 · low" }, { value: "medium", label: "中 · medium" }, { value: "high", label: "高 · high" }, { value: "xhigh", label: "更高 · xhigh" }, { value: "max", label: "最高 · max" },
      ]);
      if (level) { fields.thinking = level; text = serialize(fields, body); }
    } else if (action === "tools") {
      const tools = await selectAgentTools(ctx, definition.tools ?? []);
      if (tools) { fields.tools = tools; delete fields.disallowedTools; delete fields.writePermission; text = serialize(fields, body); }
    } else if (action === "timeout") {
      const value = await chooseDuration(ctx, definition.timeoutMs, true);
      if (value) { fields.timeoutMs = value.value; text = serialize(fields, body); }
    } else if (["name", "description", "prompt"].includes(action)) {
      const edited = await ctx.ui.editor(action === "prompt" ? "角色提示词" : action === "name" ? "显示名称" : "何时调用这个 Agent", action === "prompt" ? body : action === "name" ? definition.name : definition.description);
      if (edited !== undefined) {
        if (!edited.trim()) ctx.ui.notify("内容不能为空。", "error");
        else if (action === "prompt") text = serialize(fields, edited);
        else { fields[action] = edited.trim(); text = serialize(fields, body); }
      }
    } else if (action === "raw") {
      const edited = await ctx.ui.editor(`完整配置 · ${agent.id}`, text);
      if (edited === undefined && raw) return;
      if (edited !== undefined) text = edited;
      if (raw) action = "save";
    }
    if (action === "save") {
      try {
        const result = parseAgentDefinition(text, destination, agent.source === "项目" ? "项目" : "用户");
        const errors = validateAgentDefinition(result);
        if (result.id !== agent.id) errors.push("请保留角色 ID；创建其他角色请使用新建入口。");
        if (errors.length) throw new Error(errors.join("；"));
        if (text !== original) {
          await withDiskLock(`${destination}.lock`, async () => {
            if (await fs.readFile(agent.filePath, "utf8") !== original || await readOptional(destination) !== expectedDestination) throw new Error("文件已在其他地方修改，请重新打开配置。");
            await fs.mkdir(path.dirname(destination), { recursive: true });
            const temporary = `${destination}.${randomUUID()}.tmp`;
            try { await fs.writeFile(temporary, text.endsWith("\n") ? text : `${text}\n`, "utf8"); await fs.rename(temporary, destination); }
            finally { await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
          });
        }
        ctx.ui.notify(`已保存 ${result.name}。新任务使用新配置；已有任务保留原配置。`, "info");
        return;
      } catch (error) { ctx.ui.notify(`未保存：${errorText(error)}`, "error"); if (raw) { action = "raw"; continue; } }
    }
    action = undefined;
  }
}
