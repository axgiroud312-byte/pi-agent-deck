import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export interface ExecutionChoice { model: string; thinking: ThinkingLevel }
export interface ModelProfile { id: string; modelId: string; thinking: ThinkingLevel; criteria: string }
export interface RoutingCandidate extends ExecutionChoice { id: string; criteria: string }
export interface RoutingDecision extends ExecutionChoice {
  mode: "jev" | "fallback" | "fixed" | "disabled";
  reason: string;
  elapsedMs: number;
  profileId?: string;
  routerModel?: string;
  responseModel?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
  usage?: { input_tokens: number; output_tokens: number };
}
export interface RoutingPlan {
  credentialFile?: string;
  version: 1;
  routerModel: string;
  timeoutMs: number;
  fallback: ExecutionChoice;
  candidates: RoutingCandidate[];
  state: { task: string; role: string; roleDescription: string; tools?: string[] };
  immediate?: RoutingDecision;
}
export const MODEL_PROFILES: ModelProfile[];
export function selectExecution(plan: RoutingPlan, options?: { apiKey?: string; signal?: AbortSignal; fetch?: typeof fetch }): Promise<RoutingDecision>;
export function decisionText(decision: RoutingDecision): string;
export function applyExecutionArgs(args: string[], choice: ExecutionChoice): string[];
