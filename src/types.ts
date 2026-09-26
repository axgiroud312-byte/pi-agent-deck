import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { RoutingDecision } from "./router.mjs";

export type AgentSource = "内置" | "用户" | "项目";
export type CurrentRunStatus = "选配中" | "运行中" | "停止中" | "停止未确认" | "已停止" | "已完成" | "失败" | "已取消" | "失联";
export type LegacyRunStatus = "排队中" | "等待批准" | "等待决定";
export type RunStatus = CurrentRunStatus | LegacyRunStatus;
export type ResourceState = "starting" | "running" | "releasing" | "released";

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
  /** Additional local Pi extension entry files, resolved relative to the role file. */
  extensions: string[];
  timeoutMs?: number;
  disallowedTools?: string[];
  configurationErrors?: string[];
}

export interface LegacyAgentReport {
  type: "进度" | "发现" | "问题" | "警告" | "最终";
  title: string;
  summary: string;
  objectiveStatus?: "完成" | "部分完成" | "未完成" | "阻塞";
  acceptanceCriteria: Array<{
    criterion: string;
    status: "通过" | "部分完成" | "未完成" | "未验证";
    evidence: string[];
    notes?: string;
  }>;
  evidence: string[];
  completed: string[];
  deliverables: string[];
  filesRead: string[];
  filesChanged: string[];
  fileChanges: Array<{ path: string; change: string }>;
  designDecisions: Array<{ decision: string; reason: string; alternatives: string[] }>;
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

/** Historical-only projection populated by the compatibility adapter; current execution never writes these fields. */
export interface LegacyRunView {
  agentId?: string;
  pendingQuestion?: { id: string; turnId: string; question: string; options: string[] };
  autoDeliver?: boolean;
  planContext?: string;
  batchId?: string;
  phase?: string;
  acceptanceCriteria?: string[];
  writerLease?: Record<string, unknown>;
  reports?: LegacyAgentReport[];
  /** Fields written by the retired structured-report and writer-policy layers. */
  structuredResult?: unknown;
  resultCompleteness?: string;
  toolEvidence?: string[];
  writePermission?: boolean;
}

export interface RunEvent {
  at: number;
  kind: "状态" | "工具" | "报告" | "错误";
  text: string;
}

export interface RunDetails {
  /** runId is stable across resumes; turnId identifies only the current execution. */
  turnId?: string;
  resourceState?: ResourceState;
  /** Informational count only; messages themselves are never persisted or replayed. */
  queuedMessageCount?: number;
  /** Versions 1 and 2 are accepted through the compatibility adapter. New records use version 3. */
  version: 1 | 2 | 3;
  runId: string;
  /** Current role identity. */
  roleId: string;
  agentName: string;
  agentSource: AgentSource;
  /** Instance identity is runId; roleId identifies the reusable role. */
  instanceName?: string;
  description?: string;
  objective: string;
  instruction: string;
  status: RunStatus;
  model: string;
  thinking: ThinkingLevel;
  routing?: RoutingDecision;
  routingPending?: boolean;
  tools?: string[];
  disallowedTools?: string[];
  extensions?: string[];
  /** Delivery mode belongs to the current turn and is reset on every resume. */
  deliveryMode?: "foreground" | "background";
  parentSessionId: string;
  parentSessionPath?: string;
  childSessionId: string;
  childSessionPath: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  currentAction?: string;
  legacy?: LegacyRunView;
  events: RunEvent[];
  finalText?: string;
  /** Caller/cause of the completion or cleanup notification; not the delivery outcome. */
  completionSource?: "execution" | "tool-stop" | "panel-stop" | "shutdown";
  failureReason?: string;
  persistenceError?: string;
  stderr?: string;
  exitCode?: number;
  /** Usage for the current execution turn; every resume resets it and completion history preserves it. */
  usage: Usage;
}
