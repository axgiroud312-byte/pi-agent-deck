import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";
import { discoverAgents, validateAgentDefinition } from "./agents.ts";
import { readDeckConfig, writeDeckConfig } from "./config.ts";
import { prepareRouting } from "./routing.ts";
import { selectExecution, decisionText, type RoutingDecision, type RoutingPlan } from "./router.mjs";

async function preview(plan: RoutingPlan, ctx: ExtensionContext): Promise<RoutingDecision | undefined> {
  if (ctx.mode !== "tui") return selectExecution(plan);
  type Result = { decision: RoutingDecision } | { error: unknown } | undefined;
  const result = await ctx.ui.custom<Result>((tui, theme, _keys, done) => {
    const loader = new CancellableLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), "正在试选模型… Esc 取消");
    let settled = false;
    const finish = (value: Result) => { if (!settled) { settled = true; loader.stop(); done(value); } };
    loader.onAbort = () => finish(undefined);
    void selectExecution(plan, { signal: loader.signal }).then(
      (decision) => { if (!loader.aborted) finish({ decision }); },
      (error: unknown) => { if (!loader.aborted) finish({ error }); },
    );
    return loader;
  });
  if (result && "error" in result) throw result.error;
  return result?.decision;
}
export function registerRouting(pi: ExtensionAPI) {
  pi.registerCommand("agent-router", {
    description: "Jev 自动选配：/agent-router [on|off|status]，只影响新任务",
    async handler(args, ctx) {
      try {
        const current = readDeckConfig();
        const action = args.trim().toLowerCase() || "status";
        if (["on", "开启", "off", "关闭"].includes(action)) {
          await writeDeckConfig({ routing: { ...current.routing, enabled: ["on", "开启"].includes(action) } });
        } else if (!["status", "状态"].includes(action)) {
          ctx.ui.notify("用法：/agent-router on、off 或 status。", "warning"); return;
        }
        const config = readDeckConfig();
        ctx.ui.notify(`Jev 自动选配：${config.routing.enabled ? "开启" : "关闭"}\n选配模型：${config.routing.model} · 超时：${config.routing.timeoutMs} ms\nTypeSafe 密钥：${process.env.TYPESAFE_API_KEY?.trim() ? "已检测到（尚未验证）" : "未配置，将回退"}\n只影响新任务；主 Agent 决定数量、角色和分工。用 /agent-route-test 试选。`, "info");
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
        const decision = await preview(plan, ctx);
        ctx.ui.notify(decision ? `试选结果 · ${agent.name}\n${decisionText(decision)}\n未创建子任务。` : "已取消试选，未创建子任务。", decision?.mode === "fallback" ? "warning" : "info");
      } catch (error) { ctx.ui.notify(`试选失败：${error instanceof Error ? error.message : error}`, "error"); }
    },
  });
}

