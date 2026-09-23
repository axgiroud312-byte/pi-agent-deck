import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { RoutingDecision } from "./router.mjs";

export type AgentSource = "内置" | "用户" | "项目";
export type ReportProfile = "通用" | "侦察" | "执行" | "审查";
export type RunStatus = "选配中" | "排队中" | "等待批准" | "运行中" | "等待决定" | "停止中" | "停止未确认" | "已停止" | "已完成" | "失败" | "已取消" | "失联";
export type ReportType = "进度" | "发现" | "问题" | "警告" | "最终";
export type MessageDelivery = "QueueOnly" | "TriggerTurn";
export type ResourceState = "starting" | "running" | "releasing" | "released";

/** Read-only shape for historical records; no new writer leases are created. */
export interface WriterLease {
  version: 1; runId: string; ownerToken: string; cwd: string; leasePath: string; createdAt: number;
}

export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  source: AgentSource;
  filePath: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  writePermission: boolean;
  reportProfile: ReportProfile;
  timeoutMs?: number;
  disallowedTools?: string[];
  configurationErrors?: string[];
}

export interface DelegationRequest {
  agent: string;
  objective: string;
  planContext?: string;
  batchId?: string;
  phase?: string;
  requiresWrite?: boolean;
  requiredTools?: string[];
  background?: string[];
  dependencies?: string[];
  inputs?: string[];
  filesToRead?: string[];
  scope?: string[];
  allowedPaths?: string[];
  forbiddenPaths?: string[];
  exclusions?: string[];
  constraints?: string[];
  implementationRequirements?: string[];
  validationPolicy?: string[];
  acceptanceCriteria: string[];
  expectedDeliverables?: string[];
  expectedReport?: string[];
  cwd?: string;
}

export interface AcceptanceCriterionResult {
  criterion: string;
  status: "通过" | "部分完成" | "未完成" | "未验证";
  evidence: string[];
  notes?: string;
}

export interface FileChangeReport {
  path: string;
  change: string;
}

export interface DesignDecisionReport {
  decision: string;
  reason: string;
  alternatives: string[];
}

export interface AgentReport {
  type: ReportType;
  title: string;
  summary: string;
  objectiveStatus?: "完成" | "部分完成" | "未完成" | "阻塞";
  acceptanceCriteria: AcceptanceCriterionResult[];
  evidence: string[];
  completed: string[];
  deliverables: string[];
  filesRead: string[];
  filesChanged: string[];
  fileChanges: FileChangeReport[];
  designDecisions: DesignDecisionReport[];
  commands: string[];
  tests: string[];
  risks: string[];
  unknowns: string[];
  downstreamNotes: string[];
  recommendations: string[];
  question?: string;
  options: string[];
  recommendation?: string;
  blocking: boolean;
  confidence?: "低" | "中" | "高";
}

export interface RunEvent {
  at: number;
  kind: "状态" | "工具" | "报告" | "错误";
  text: string;
}

export interface RunDetails {
  /** Stable task identity is runId. This identifies only the current execution. */
  turnId?: string;
  resourceState?: ResourceState;
  /** Informational count only; messages themselves are never persisted or replayed. */
  queuedMessageCount?: number;
  pendingQuestion?: { id: string; turnId: string; question: string; options: string[] };
  autoDeliver?: boolean;
  version: 1;
  runId: string;
  agentId: string;
  agentName: string;
  agentSource: AgentSource;
  /** Instance identity is runId; agentId remains the role ID for persisted compatibility. */
  instanceName?: string;
  description?: string;
  objective: string;
  instruction: string;
  planContext?: string;
  batchId?: string;
  phase?: string;
  acceptanceCriteria: string[];
  status: RunStatus;
  model: string;
  thinking: ThinkingLevel;
  routing?: RoutingDecision;
  routingPending?: boolean;
  tools: string[];
  writePermission: boolean;
  parentSessionId: string;
  parentSessionPath?: string;
  childSessionId: string;
  childSessionPath: string;
  cwd: string;
  writerLease?: WriterLease;
  startedAt: number;
  endedAt?: number;
  currentAction?: string;
  reports: AgentReport[];
  events: RunEvent[];
  finalText?: string;
  stderr?: string;
  exitCode?: number;
  usage: Usage;
}

export interface RunIndexEvent {
  version: 1;
  event: "started" | "finished";
  at: number;
  runId: string;
  agentId: string;
  agentName: string;
  objective: string;
  status: RunStatus;
  model: string;
  thinking: ThinkingLevel;
  parentSessionId: string;
  parentSessionPath?: string;
  childSessionId: string;
  childSessionPath: string;
  finalSummary?: string;
}
