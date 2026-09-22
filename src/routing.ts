import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "./types.ts";
import type { DeckConfig } from "./config.ts";
import { MODEL_PROFILES, type RoutingPlan, type RoutingDecision } from "./router.mjs";

export interface RoutingContext {
  model?: Model<Api>;
  modelRegistry: { find(provider: string, id: string): Model<Api> | undefined; getAvailable(): Model<Api>[] };
}
function effectiveThinking(model: Model<Api>, requested: ThinkingLevel): ThinkingLevel {
  const clamped = clampThinkingLevel(model, requested) as ThinkingLevel;
  const mapped = model.thinkingLevelMap?.[clamped];
  if (mapped === "none") return "off";
  return typeof mapped === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(mapped) ? mapped as ThinkingLevel : clamped;
}
export function prepareRouting(agent: AgentDefinition, task: string, ctx: RoutingContext, config: DeckConfig,
  inheritedThinking: ThinkingLevel, override: { model?: string; thinking?: ThinkingLevel } = {}): RoutingPlan {
  const fixedModel = override.model ?? agent.model;
  const fixedThinking = override.thinking ?? agent.thinking;
  let fallbackModel = ctx.model;
  if (fixedModel) {
    const slash = fixedModel.indexOf("/");
    if (slash <= 0 || slash === fixedModel.length - 1) throw new Error("模型必须使用 provider/model 格式。");
    fallbackModel = ctx.modelRegistry?.find(fixedModel.slice(0, slash), fixedModel.slice(slash + 1));
    if (!fallbackModel) throw new Error(`找不到配置的模型：${fixedModel}`);
  }
  if (!fallbackModel) throw new Error("主会话当前没有可继承的模型。");
  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  if (fixedThinking !== undefined && !getSupportedThinkingLevels(fallbackModel).includes(fixedThinking)) {
    const compatible = !fixedModel && config.routing.enabled ? available.find((item) => item.provider === fallbackModel!.provider
      && MODEL_PROFILES.some((profile) => profile.modelId === item.id)
      && getSupportedThinkingLevels(item).includes(fixedThinking)) : undefined;
    if (!compatible) throw new Error(`模型 ${fallbackModel.id} 不支持固定思考强度 ${fixedThinking}；请调整明确配置。`);
    fallbackModel = compatible;
  }
  const requestedThinking = fixedThinking ?? inheritedThinking;
  const fallback = { model: `${fallbackModel.provider}/${fallbackModel.id}`, thinking: effectiveThinking(fallbackModel, requestedThinking) };
  const plan: RoutingPlan = {
    version: 1, routerModel: config.routing.model, timeoutMs: config.routing.timeoutMs, fallback, candidates: [],
    state: { task, role: agent.id, roleDescription: agent.description, writePermission: agent.writePermission, tools: agent.tools ?? [] },
  };
  const immediate = (mode: RoutingDecision["mode"], reason: string) => ({ ...plan, immediate: { ...fallback, mode, reason, elapsedMs: 0 } });
  const adjustment = fallback.thinking !== requestedThinking ? ` 当前模型将 ${requestedThinking} 调整为支持的 ${fallback.thinking}。` : "";
  if (!config.routing.enabled) return immediate("disabled", `自动选配已关闭，使用角色配置或主会话配置。${adjustment}`);
  if (fixedModel && fixedThinking !== undefined) return immediate("fixed", `模型和思考强度已固定，直接使用明确配置。${adjustment}`);
  // Preserve the chosen provider/authentication path. Routing cannot switch billing accounts.
  for (const profile of MODEL_PROFILES) {
    const model = available.find((item) => item.provider === fallbackModel!.provider && item.id === profile.modelId);
    if (!model || (fixedModel && `${model.provider}/${model.id}` !== fixedModel)
      || (fixedThinking !== undefined && (!getSupportedThinkingLevels(model).includes(fixedThinking) || profile.thinking !== effectiveThinking(model, fixedThinking)))
      || !getSupportedThinkingLevels(model).includes(profile.thinking)) continue;
    plan.candidates.push({ id: profile.id, model: `${model.provider}/${model.id}`, thinking: profile.thinking, criteria: profile.criteria });
  }
  if (!plan.candidates.length) return immediate("fallback", `当前提供商没有满足固定设置的可用 Astra / Sol 组合，沿用原配置。${adjustment}`);
  if (plan.candidates.length === 1) return { ...plan, immediate: { ...plan.candidates[0], mode: "fixed", profileId: plan.candidates[0].id, reason: "当前固定设置和模型可用性只允许这一个组合。", elapsedMs: 0 } };
  return plan;
}
