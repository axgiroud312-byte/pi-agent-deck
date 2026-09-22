import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import { deckConfigPath } from "./config.ts";
import { createAgentFromDescription } from "./agent-creation.ts";
import { editAgentConfig, editGlobalConfig } from "./config-editor.ts";
import { selectMenu } from "./menu.ts";

export function registerConfiguration(pi: ExtensionAPI, changed: (ctx: ExtensionContext) => void) {
  pi.registerCommand("agent-create", {
    description: "描述需求，自动创建 Agent：/agent-create [描述]",
    handler: (description, ctx) => createAgentFromDescription(pi, ctx, description),
  });
  const openConfiguration = async (args: string, ctx: ExtensionContext): Promise<void> => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`全局设置：${deckConfigPath()}\n个人 Agent：${path.join(getAgentDir(), "agents")}\n请在交互终端使用 /agent-config 编辑。`, "info");
      return;
    }
    const agents = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
    const words = args.trim().split(/\s+/).filter(Boolean);
    const raw = words.includes("--raw");
    let selected = words.find((word) => word !== "--raw") ?? "";
    if (!selected) {
      const items = [{ id: "global", label: "全局：Jev 自动选配和默认时限" }, { id: "new", label: "描述需求，自动创建 Agent" }, ...agents.map((agent) => ({ id: agent.id, label: `${agent.name} · ${agent.source} · ${agent.id}` }))];
      const choice = await selectMenu(ctx, "Agent 配置", items.map((item) => ({ value: item.id, label: item.label })));
      if (!choice) return;
      selected = choice;
    }
    if (selected === "new") return createAgentFromDescription(pi, ctx);
    if (selected === "global") return editGlobalConfig(ctx, changed, raw);
    const agent = agents.find((item) => item.id === selected);
    if (!agent) { ctx.ui.notify(`找不到 Agent：${selected}`, "warning"); return; }
    await editAgentConfig(ctx, agent, raw);
  };
  pi.registerCommand("agent-config", {
    description: "选择并编辑 Jev、模型、工具或提示词：/agent-config [global|角色ID] [--raw]",
    handler: openConfiguration,
  });
  return openConfiguration;
}
