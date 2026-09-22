import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import type { PersistedRun } from "./runtime.ts";
import type { RunStatus } from "./types.ts";
import { runTitle, runRoleLabel } from "./tool-contract.ts";

export const STATUS_VIEW: Record<RunStatus, { icon: string; label: string; color: "accent" | "muted" | "warning" | "success" | "error"; order: number }> = {
  "选配中": { icon: "◌", label: "选配中", color: "accent", order: 1 },
  "运行中": { icon: "●", label: "运行中", color: "accent", order: 1 },
  "排队中": { icon: "○", label: "排队中", color: "muted", order: 3 },
  "等待批准": { icon: "◐", label: "等待批准", color: "warning", order: 0 },
  "等待决定": { icon: "◐", label: "等答复", color: "warning", order: 0 },
  "停止中": { icon: "◒", label: "停止中", color: "warning", order: 2 },
  "停止未确认": { icon: "!", label: "停止未确认", color: "error", order: 0 },
  "已完成": { icon: "✓", label: "已返回结果", color: "success", order: 5 },
  "失败": { icon: "✗", label: "失败", color: "error", order: 4 },
  "失联": { icon: "!", label: "失联", color: "error", order: 0 },
  "已停止": { icon: "■", label: "已停止", color: "muted", order: 5 },
  "已取消": { icon: "–", label: "已取消", color: "muted", order: 5 },
};
const statusView = (status: RunStatus) => STATUS_VIEW[status] ?? { icon: "?", label: plain(status), color: "muted" as const, order: 4 };

export function plain(text: string): string { return stripTerminalSequences(text).replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim(); }
export function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}
export function twoColumns(left: string, right: string, width: number): string {
  if (visibleWidth(right) + 3 >= width) return fit(right, width);
  return fit(left, width - visibleWidth(right) - 2) + "  " + right;
}
export function runTime(run: PersistedRun): string {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? Date.now()) - (run.attemptStartedAt ?? run.startedAt)) / 1000));
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h${Math.floor(seconds % 3600 / 60).toString().padStart(2, "0")}`;
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}
export function statusText(run: PersistedRun, theme: Theme): string {
  const view = statusView(run.status);
  return theme.fg(view.color, `${view.icon} ${view.label}`);
}
export function runCounts(runs: PersistedRun[]) {
  const count = (statuses: RunStatus[]) => runs.filter((run) => statuses.includes(run.status)).length;
  return { selecting: count(["选配中"]), running: count(["运行中"]), queued: count(["排队中"]), waiting: count(["等待决定", "等待批准"]), stopping: count(["停止中"]), issues: count(["失败", "失联", "停止未确认"]), returned: count(["已完成"]) };
}
export function countSummary(runs: PersistedRun[], theme: Theme): string {
  const n = runCounts(runs);
  return [...(n.selecting ? [theme.fg("accent", `选配 ${n.selecting}`)] : []), theme.fg("accent", `运行 ${n.running}`), theme.fg("muted", `排队 ${n.queued}`), theme.fg(n.waiting ? "warning" : "muted", `等答复 ${n.waiting}`), ...(n.stopping ? [theme.fg("warning", `停止中 ${n.stopping}`)] : []), ...(n.issues ? [theme.fg("error", `异常 ${n.issues}`)] : [])].join(" · ");
}
export function executionLabel(run: PersistedRun): string {
  return run.routingPending ? "模型待选配" : `${run.model.split("/").at(-1)} · ${run.thinking}${run.routing?.mode === "fallback" ? " · 已回退" : ""}`;
}
export function sortRuns(runs: PersistedRun[]): PersistedRun[] {
  return [...runs].sort((a, b) => statusView(a.status).order - statusView(b.status).order || (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt));
}
export function renderFleet(runs: PersistedRun[], width: number, height: number, theme: Theme): string[] {
  const visible = sortRuns(runs);
  const maxRows = Math.max(1, Math.min(5, Math.floor(height / 6)));
  const lines = [truncateToWidth(`${theme.fg("accent", "Agent")}  ${countSummary(visible, theme)}`, width)];
  for (const run of visible.slice(0, maxRows)) {
    const view = statusView(run.status);
    lines.push(twoColumns(`${theme.fg(view.color, view.icon)} ${plain(runTitle(run))} · ${plain(runRoleLabel(run))}`, theme.fg(view.color, `${plain(executionLabel(run))} · ${view.label}`), width));
  }
  const rest = visible.length - maxRows;
  lines.push(truncateToWidth(theme.fg("muted", `${rest > 0 ? `另有 ${rest} 项 · ` : ""}/agents 查看 · 同工作区写任务依次执行`), width));
  return lines;
}

export function panelHeight(rows = 24): number { return Math.max(1, Math.min(rows - 4, Math.floor(rows * 0.75))); }
export function frame(title: string, contents: string[], width: number, theme: Theme): string[] {
  const safe = Math.max(1, width);
  if (safe < 4) return [title, ...contents].map((line) => fit(line, safe));
  const heading = `─ ${title} `;
  return [
    theme.fg("borderAccent", "┌") + fit(heading, safe - 2).replace(/ +$/, (spaces) => "─".repeat(spaces.length)) + theme.fg("borderAccent", "┐"),
    ...contents.map((line) => `${theme.fg("borderMuted", "│")} ${fit(line, safe - 4)} ${theme.fg("borderMuted", "│")}`),
    theme.fg("borderMuted", `└${"─".repeat(safe - 2)}┘`),
  ];
}
