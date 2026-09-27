import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { RoutingDecision } from "./router.mjs";
import type { LegacyRunStatus, LegacyRunView } from "./legacy-types.ts";
export type { LegacyAgentReport, LegacyRunStatus, LegacyRunView } from "./legacy-types.ts";

export type AgentSource = "内置" | "用户" | "项目";
export type CurrentRunStatus = "选配中" | "运行中" | "等待决定" | "停止中" | "停止未确认" | "已停止" | "已完成" | "失败" | "已取消" | "失联";
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

export interface RunEvent {
  at: number;
  kind: "状态" | "工具" | "报告" | "错误";
  text: string;
}

/** Stable task and session identity, retained across execution turns. */
export interface TaskIdentity {
  /** Stable task identity; public agentId and tool control addresses resolve to this ID. */
  runId: string;
  /** Current role identity. */
  roleId: string;
  agentName: string;
  agentSource: AgentSource;
  /** Instance identity is runId; roleId identifies the reusable role. */
  instanceName?: string;
  parentSessionId: string;
  parentSessionPath?: string;
  childSessionId: string;
  childSessionPath: string;
  cwd: string;
  startedAt: number;
}

/** Read/display snapshot shared by current and historical records; not execution admission. */
export interface RunDetails extends TaskIdentity {
  /** Historical records may have no turn or process metadata. */
  version: 1 | 2 | 3;
  turnId?: string;
  resourceState?: ResourceState;
  /** Informational count only; messages themselves are never persisted or replayed. */
  queuedMessageCount?: number;
  /** Current turn's caller-supplied title, or a derived summary. */
  description?: string;
  /** Derived display summary retained for v3 compatibility. Never the execution input. */
  objective: string;
  /** Full assignment for this turn, without separately queued supplements. */
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
  endedAt?: number;
  currentAction?: string;
  legacy?: LegacyRunView;
  events: RunEvent[];
  finalText?: string;
  /** One live Pi RPC question; the answer is recorded by Pi as a tool result. */
  pendingQuestion?: { id: string; message: string };
  /** Caller/cause of the completion or cleanup notification; not the delivery outcome. */
  completionSource?: "execution" | "tool-stop" | "panel-stop" | "shutdown";
  failureReason?: string;
  persistenceError?: string;
  stderr?: string;
  exitCode?: number;
  /** Usage for the current execution turn; every resume resets it and completion history preserves it. */
  usage: Usage;
}

export interface PersistedRun extends RunDetails {
  updatedAt: number;
  ownerPid?: number;
  /** Read-only compatibility with old detached task records. */
  runnerPid?: number;
  childPid?: number;
  stopRequested?: boolean;
  attemptStartedAt?: number;
}

/** Only this shape can enter the Pi execution loop; history is converted on explicit resume. */
export interface CurrentExecution extends PersistedRun {
  version: 3;
  status: CurrentRunStatus;
  turnId: string;
  resourceState: ResourceState;
  deliveryMode: "foreground" | "background";
}
