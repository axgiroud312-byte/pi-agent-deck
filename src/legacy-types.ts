/** Read-only v1/v2 data retained by adaptStoredRun; not a current execution protocol. */
export type LegacyRunStatus = "排队中" | "等待批准" | "等待决定";

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

export interface LegacyRunView {
  /** Historical role identity; unlike the public receipt's agentId, this is not runId. */
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
