import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "./types.ts";
import type { DeckConfig } from "./config.ts";
import { MODEL_PROFILES, EXECUTION_POLICY, isReviewAgent, executionPolicyViolation, type RoutingPlan, type RoutingDecision, type ExecutionChoice } from "./router.mjs";

export interface RoutingContext {
  model?: Model<Api>;
  modelRegistry: { find(provider: string, id: string): Model<Api> | undefined; getAvailable(): Model<Api>[] };
}
function supportedThinking(model: Model<Api>): ThinkingLevel[] {
  const supported = getSupportedThinkingLevels(model) as ThinkingLevel[];
  // These models need Responses for reasoning with tools. Policy excludes their off level.
  return model.api === "openai-completions" && ["gpt-6-sol", "gpt-6-luna"].includes(model.id)
    ? supported.filter((level) => level === "off") : supported;
}
function effectiveThinking(model: Model<Api>, requested: ThinkingLevel): ThinkingLevel {
  const mapped = model.thinkingLevelMap?.[requested];
  if (mapped === "none") return "off";
  return typeof mapped === "string" && ["off", "low", "medium", "high", "xhigh", "max"].includes(mapped) ? mapped as ThinkingLevel : requested;
}
function permittedLevels(model: Model<Api>, review: boolean): ThinkingLevel[] {
  return supportedThinking(model).filter((thinking) => !executionPolicyViolation({ model: `${model.provider}/${model.id}`, thinking }, review)
    && !executionPolicyViolation({ model: `${model.provider}/${model.id}`, thinking: effectiveThinking(model, thinking) }, review));
}
export function prepareRouting(agent: AgentDefinition, task: string, ctx: RoutingContext, config: DeckConfig,
  inheritedThinking: ThinkingLevel, override: { model?: string; thinking?: ThinkingLevel } = {}): RoutingPlan {
  const review = isReviewAgent(agent);
  const fixedModel = override.model ?? agent.model;
  const fixedThinking = override.thinking ?? agent.thinking;
  let fallbackModel = ctx.model;
  if (fixedModel) {
    const slash = fixedModel.indexOf("/");
    if (slash <= 0 || slash === fixedModel.length - 1) throw new Error("模型必须使用 provider/model 格式。");
    fallbackModel = ctx.modelRegistry?.find(fixedModel.slice(0, slash), fixedModel.slice(slash + 1));
    if (!fallbackModel) throw new Error(`找不到配置的模型：${fixedModel}`);
    const violation = executionPolicyViolation({ model: fixedModel, thinking: fixedThinking ?? "max" }, review);
    if (violation) throw new Error(`明确配置违反模型策略：${violation}`);
  }
  if (!fallbackModel) throw new Error("主会话当前没有可继承的模型。");
  const originalModel = `${fallbackModel.provider}/${fallbackModel.id}`;
  const provider = fallbackModel.provider;
  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  const canUse = (model: Model<Api>) => {
    const permitted = permittedLevels(model, review);
    return fixedThinking === undefined ? permitted.length > 0 : permitted.includes(fixedThinking);
  };
  if (!canUse(fallbackModel)) {
    // Never change a fixed model, or cross the inherited provider/account boundary.
    const preferred = review ? [EXECUTION_POLICY.reviewModel] : ["gpt-6-sol", "gpt-6-astra", "gpt-6-luna"];
    const compatible = !fixedModel ? preferred.flatMap((id) => available.filter((model) => model.provider === provider && model.id === id)).find(canUse) : undefined;
    if (!compatible) throw new Error(review
      ? `审查 Agent 只能使用 ${provider}/${EXECUTION_POLICY.reviewModel}，最低 xhigh；当前没有满足角色固定强度和模型策略的可用配置。请调整明确配置并检查模型支持档位。`
      : `当前提供商没有符合模型策略的配置${fixedThinking !== undefined ? `，不支持固定思考强度 ${fixedThinking}` : ""}。GPT-6 Sol/Luna 最低 high，其推理工具调用需使用 Responses 接口；GPT-5.6 Sol 仅供审查。`);
    fallbackModel = compatible;
  }
  const requestedThinking = fixedThinking ?? inheritedThinking;
  const permitted = permittedLevels(fallbackModel, review);
  const clamped = clampThinkingLevel(fallbackModel, requestedThinking) as ThinkingLevel;
  const selected = fixedThinking ?? (permitted.includes(clamped) ? clamped : permitted[0]);
  const fallback: ExecutionChoice = { model: `${fallbackModel.provider}/${fallbackModel.id}`, thinking: effectiveThinking(fallbackModel, selected) };
  const plan: RoutingPlan = {
    version: 1, routerModel: config.routing.model, timeoutMs: config.routing.timeoutMs, fallback, candidates: [],
    state: { task, role: agent.id, roleDescription: agent.description, writePermission: agent.writePermission, tools: agent.tools ?? [], review },
  };
  const immediate = (mode: RoutingDecision["mode"], reason: string) => ({ ...plan, immediate: { ...fallback, mode, reason, elapsedMs: 0 } });
  const adjustment = fallback.thinking !== requestedThinking || fallback.model !== originalModel ? ` 已按角色策略与模型能力调整为 ${fallback.model} / ${fallback.thinking}。` : "";
  if (!config.routing.enabled) return immediate("disabled", `自动选配已关闭，使用符合模型策略的角色配置或继承配置。${adjustment}`);
  if (fixedModel && fixedThinking !== undefined) return immediate("fixed", `模型和思考强度已固定，直接使用明确配置。${adjustment}`);
  for (const profile of MODEL_PROFILES) {
    const model = available.find((item) => item.provider === provider && item.id === profile.modelId);
    if (!model || (fixedModel && `${model.provider}/${model.id}` !== fixedModel)
      || (fixedThinking !== undefined && (!permittedLevels(model, review).includes(fixedThinking) || profile.thinking !== effectiveThinking(model, fixedThinking)))
      || !permittedLevels(model, review).includes(profile.thinking)
      || effectiveThinking(model, profile.thinking) !== profile.thinking) continue;
    plan.candidates.push({ id: profile.id, model: `${model.provider}/${model.id}`, thinking: profile.thinking, criteria: profile.criteria });
  }
  if (!plan.candidates.length) return immediate("fallback", `当前提供商没有满足固定设置的可用 Astra / Sol / Luna 组合，使用合规回退配置。${adjustment}`);
  if (plan.candidates.length === 1) return { ...plan, immediate: { ...plan.candidates[0], mode: "fixed", profileId: plan.candidates[0].id, reason: "当前角色策略、固定设置和模型可用性只允许这一个组合。", elapsedMs: 0 } };
  return plan;
}
