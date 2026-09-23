import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents, validateAgentDefinition } from "./agents.ts";
import { jevCredentialPath, readDeckConfig, writeDeckConfig } from "./config.ts";
import { prepareRouting } from "./routing.ts";
import { decisionText } from "./router.mjs";
import { editJevConfig, previewRouting } from "./jev-ui.ts";
import { resolveJevKey } from "./jev-service.mjs";

export function registerRouting(pi: ExtensionAPI) {
  pi.registerCommand("agent-router", {
    description: "Jev 可视化配置：/agent-router；也支持 on、off、status",
    async handler(args, ctx) {
      try {
        const action = args.trim().toLowerCase() || (ctx.mode === "tui" ? "config" : "status");
        if (["config", "设置"].includes(action)) return await editJevConfig(ctx, () => pi.getThinkingLevel?.() ?? "off");
        if (["on", "开启", "off", "关闭"].includes(action)) {
          await writeDeckConfig({ routing: { enabled: ["on", "开启"].includes(action) } });
        } else if (!["status", "状态"].includes(action)) {
          ctx.ui.notify("用法：/agent-router 打开配置；on、off、status 管理开关和状态。", "warning"); return;
        }
        const config = readDeckConfig();
        const credential = resolveJevKey(jevCredentialPath());
        ctx.ui.notify(`Jev 自动选配：${config.routing.enabled ? "开启" : "关闭"}\n选配模型：${config.routing.model} · 超时：${config.routing.timeoutMs} ms\nTypeSafe 密钥：${credential.apiKey ? `已检测到（${credential.source === "saved" ? "本机保存" : "环境变量"}，尚未验证）` : "未配置，将回退"}\n只影响新任务；主 Agent 决定数量、角色和分工。用 /agent-route-test 试选。`, "info");
      } catch (error) { ctx.ui.notify(`选配设置失败：${error instanceof Error ? error.message : error}`, "error"); }
    },
  });
  pi.registerCommand("agent-route-test", {
    description: "试选模型，不创建任务：/agent-route-test [角色ID] 任务说明",
    async handler(args, ctx) {
      try {
        const agents = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
        let task = args.trim();
        if (!task && ctx.mode === "tui") task = (await ctx.ui.editor("输入试选任务（可在开头写角色 ID）", ""))?.trim() ?? "";
        if (!task) { ctx.ui.notify("请提供任务说明，例如 /agent-route-test explore 调查登录失败的原因。", "info"); return; }
        const token = task.split(/\s+/, 1)[0];
        const roleId = token === "general" ? "worker" : token === "explore" ? "scout" : token;
        const explicit = agents.find((item) => item.id === roleId);
        const agent = explicit ?? agents.find((item) => item.id === "worker");
        if (explicit) task = task.slice(token.length).trim();
        if (!agent || !task) { ctx.ui.notify("请在角色 ID 后写明任务内容。", "warning"); return; }
        const errors = validateAgentDefinition(agent);
        if (errors.length) throw new Error(errors.join("；"));
        const plan = prepareRouting(agent, task, ctx, readDeckConfig(), pi.getThinkingLevel());
        const decision = await previewRouting(plan, ctx);
        ctx.ui.notify(decision ? `试选结果 · ${agent.name}\n${decisionText(decision)}\n未创建子任务。` : "已取消试选，未创建子任务。", decision?.mode === "fallback" ? "warning" : "info");
      } catch (error) { ctx.ui.notify(`试选失败：${error instanceof Error ? error.message : error}`, "error"); }
    },
  });
}

