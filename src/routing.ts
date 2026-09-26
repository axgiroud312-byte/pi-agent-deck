import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AgentDefinition } from "./types.ts";
import { jevCredentialPath, type DeckConfig } from "./config.ts";
import { MODEL_PROFILES, type RoutingPlan, type RoutingDecision, type ExecutionChoice } from "./router.mjs";

export interface RoutingContext {
  model?: Model<Api>;
  modelRegistry: { find(provider: string, id: string): Model<Api> | undefined; getAvailable(): Model<Api>[] };
}

function supportedThinking(model: Model<Api>): ThinkingLevel[] {
  return getSupportedThinkingLevels(model) as ThinkingLevel[];
}

function effectiveThinking(model: Model<Api>, requested: ThinkingLevel): ThinkingLevel {
  const mapped = model.thinkingLevelMap?.[requested];
  if (mapped === "none") return "off";
  return typeof mapped === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(mapped)
    ? mapped as ThinkingLevel : requested;
}

function findConfiguredModel(value: string | undefined, ctx: RoutingContext): Model<Api> | undefined {
  if (!value) return;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) return;
  return ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1));
}

/**
 * Build a soft model/thinking selection plan. Role/model preferences never gate
 * task execution: unavailable or unsupported preferences fall back to the
 * current Pi model and its closest supported thinking level.
 */
export function prepareRouting(agent: AgentDefinition, task: string, ctx: RoutingContext, config: DeckConfig,
  inheritedThinking: ThinkingLevel, override: { model?: string; thinking?: ThinkingLevel } = {}): RoutingPlan {
  const available = ctx.modelRegistry?.getAvailable?.() ?? [];
  const requestedModel = override.model ?? agent.model;
  const found = findConfiguredModel(requestedModel, ctx);
  const configured = found && available.some((item) => item.provider === found.provider && item.id === found.id) ? found : undefined;
  const fallbackModel = configured ?? ctx.model ?? available[0];
  if (!fallbackModel) throw new Error("当前 Pi 会话没有可执行的模型。");

  const requestedThinking = override.thinking ?? agent.thinking ?? inheritedThinking;
  const clamped = clampThinkingLevel(fallbackModel, requestedThinking) as ThinkingLevel;
  const fallback: ExecutionChoice = {
    model: `${fallbackModel.provider}/${fallbackModel.id}`,
    thinking: effectiveThinking(fallbackModel, clamped),
  };
  const ignoredModel = requestedModel && !configured
    ? `请求的模型 ${requestedModel} 当前不可用，沿用 ${fallback.model}。`
    : "";
  const adjustedThinking = fallback.thinking !== requestedThinking
    ? `思考强度按模型实际支持从 ${requestedThinking} 调整为 ${fallback.thinking}。`
    : "";
  const plan: RoutingPlan = {
    version: 1,
    routerModel: config.routing.model,
    timeoutMs: config.routing.timeoutMs,
    credentialFile: jevCredentialPath(),
    fallback,
    candidates: [],
    state: { task, role: agent.id, roleDescription: agent.description, tools: agent.tools },
  };
  const immediate = (mode: RoutingDecision["mode"], reason: string): RoutingPlan => ({
    ...plan,
    immediate: { ...fallback, mode, reason: [reason, ignoredModel, adjustedThinking].filter(Boolean).join(" "), elapsedMs: 0 },
  });

  if (!config.routing.enabled) return immediate("disabled", "自动选配已关闭，沿用角色或主会话配置。");
  if (configured && override.thinking !== undefined) return immediate("fixed", "模型和思考强度已明确指定。");

  const known = new Map(MODEL_PROFILES.map((profile) => [`${profile.modelId}:${profile.thinking}`, profile.criteria]));
  const fixedThinking = override.thinking ?? agent.thinking;
  for (const [modelIndex, candidateModel] of available.entries()) {
    if (configured && (candidateModel.provider !== configured.provider || candidateModel.id !== configured.id)) continue;
    const levels = fixedThinking === undefined
      ? supportedThinking(candidateModel)
      : [clampThinkingLevel(candidateModel, fixedThinking) as ThinkingLevel];
    const seenThinking = new Set<ThinkingLevel>();
    for (const level of [...new Set(levels)]) {
      const thinking = effectiveThinking(candidateModel, level);
      if (seenThinking.has(thinking)) continue;
      seenThinking.add(thinking);
      const model = `${candidateModel.provider}/${candidateModel.id}`;
      plan.candidates.push({
        id: `model_${modelIndex}_${thinking}`,
        model,
        thinking,
        criteria: known.get(`${candidateModel.id}:${thinking}`)
          ?? `Use ${candidateModel.name || candidateModel.id} with ${thinking} reasoning when its available capabilities and effort fit the task.`,
      });
    }
  }
  if (!plan.candidates.length) return immediate("fallback", "没有匹配的 Jev 候选，沿用当前配置。");
  if (plan.candidates.length === 1) return {
    ...plan,
    immediate: { ...plan.candidates[0], mode: "fixed", profileId: plan.candidates[0].id,
      reason: ["当前只有一个可用候选。", ignoredModel, adjustedThinking].filter(Boolean).join(" "), elapsedMs: 0 },
  };
  return plan;
}
