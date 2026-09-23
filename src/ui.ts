import * as fs from "node:fs";
import { runTitle, runRoleLabel } from "./tool-contract.ts";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Markdown, stripTerminalSequences, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isTerminalStatus, listRuns, runDirectory, type PersistedRun } from "./runtime.ts";
import { taskOutput } from "./delivery.ts";
import { readCompletions } from "./persistence.mjs";
import { readDeckConfig } from "./config.ts";
import { decisionText } from "./router.mjs";
import { executionLabel } from "./presentation.ts";
import { activeRunCount } from "./run-capacity.ts";
import { countSummary, fit, frame, panelHeight, plain, runTime, sortRuns, statusText, twoColumns } from "./presentation.ts";

export type AgentPanelAction =
  | { action: "关闭" }
  | { action: "创建" }
  | { action: "配置" }
  | { action: "停止"; runId: string }
  | { action: "回答问题"; runId: string; questionId: string }
  | { action: "仅发信息"; runId: string }
  | { action: "继续"; runId: string };
type LogEntry = { at: number; kind: string; text: string };

class AgentPanelComponent {
  private runs: PersistedRun[];
  private selected = 0;
  private mode: "列表" | "详情" = "列表";
  private page: "任务说明" | "实时记录" | "报告" = "实时记录";
  private scroll = 0;
  private following = true;
  private maxScroll = 0;
  private pageSize = 5;
  private anchor?: string;
  private logKeys: string[] = [];
  private logCache?: { runId: string; stamp: string; entries: LogEntry[]; truncated: boolean };
  private logRender?: { runId: string; stamp: string; width: number; lines: string[]; keys: string[] };
  private reportCache?: { text: string; width: number; lines: string[] };
  private timer: NodeJS.Timeout;
  private refreshing = false;
  private refreshError?: string;
  private history?: { runId: string; results: PersistedRun[] };

  constructor(
    initialRuns: PersistedRun[],
    private readonly theme: Theme,
    private readonly requestRender: () => void,
    private readonly done: (action: AgentPanelAction) => void,
    private readonly parentSessionId: string,
    private readonly terminalRows: () => number,
  ) {
    this.runs = sortRuns(initialRuns);
    this.timer = setInterval(() => void this.refresh(), 700);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const selectedId = this.runs[this.selected]?.runId;
      this.runs = sortRuns(await listRuns(Number.MAX_SAFE_INTEGER, this.parentSessionId));
      if (selectedId) {
        const next = this.runs.findIndex((item) => item.runId === selectedId);
        if (next >= 0) this.selected = next;
      }
      this.selected = Math.max(0, Math.min(this.selected, Math.max(0, this.runs.length - 1)));
      const selected = this.runs[this.selected];
      if (this.mode === "详情" && selected) this.history = { runId: selected.runId, results: await readCompletions(runDirectory(selected.runId)) };
      this.refreshError = undefined;
    } catch (error) { this.refreshError = error instanceof Error ? error.message : String(error); }
    finally { this.refreshing = false; this.requestRender(); }
  }

  private scrollBy(amount: number): void {
    if (this.mode === "列表") this.selected = Math.max(0, Math.min(this.runs.length - 1, this.selected + amount));
    else {
      this.following = false;
      this.anchor = undefined;
      this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll + amount));
      if (amount > 0 && this.scroll >= this.maxScroll && this.page === "实时记录") this.following = true;
    }
    this.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      if (this.mode === "详情") { this.mode = "列表"; this.scroll = 0; this.anchor = undefined; this.requestRender(); }
      else this.done({ action: "关闭" });
      return;
    }
    if (data.toLowerCase() === "n") { this.done({ action: "创建" }); return; }
    if (data.toLowerCase() === "g") { this.done({ action: "配置" }); return; }
    if (matchesKey(data, Key.up) || data === "k") { this.scrollBy(-1); return; }
    if (matchesKey(data, Key.down) || data === "j") { this.scrollBy(1); return; }
    if (matchesKey(data, Key.pageUp)) { this.scrollBy(-this.pageSize); return; }
    if (matchesKey(data, Key.pageDown)) { this.scrollBy(this.pageSize); return; }
    if (matchesKey(data, Key.home)) {
      if (this.mode === "列表") this.selected = 0;
      else { this.scroll = 0; this.following = false; this.anchor = undefined; }
      this.requestRender(); return;
    }
    if (matchesKey(data, Key.end)) {
      if (this.mode === "列表") this.selected = Math.max(0, this.runs.length - 1);
      else { this.scroll = this.maxScroll; this.following = true; this.anchor = undefined; }
      this.requestRender(); return;
    }
    if (data === "1" || data === "2" || data === "3" || matchesKey(data, Key.tab) || data === "\u001b[Z") {
      if (this.mode === "详情") {
        const pages = ["任务说明", "实时记录", "报告"] as const;
        if (data === "1" || data === "2" || data === "3") this.page = pages[Number(data) - 1];
        else this.page = pages[(pages.indexOf(this.page) + (data === "\u001b[Z" ? 2 : 1)) % pages.length];
        this.scroll = 0; this.following = true; this.anchor = undefined; this.requestRender();
      }
      return;
    }
    const selected = this.runs[this.selected];
    if (!selected) return;
    if (matchesKey(data, Key.enter)) {
      this.mode = "详情";
      this.page = isTerminalStatus(selected.status) || selected.status === "等待决定" ? "报告" : "实时记录";
      this.scroll = 0; this.following = true; this.anchor = undefined; this.requestRender(); void this.refresh(); return;
    }
    if (data.toLowerCase() === "x" && !isTerminalStatus(selected.status)) this.done({ action: "停止", runId: selected.runId });
    if (data.toLowerCase() === "a" && selected.pendingQuestion) this.done({ action: "回答问题", runId: selected.runId, questionId: selected.pendingQuestion.id });
    if (data.toLowerCase() === "c" && selected.status !== "停止中" && selected.status !== "停止未确认") this.done({ action: "继续", runId: selected.runId });
    if (data.toLowerCase() === "m" && selected.status !== "停止中" && selected.status !== "停止未确认") this.done({ action: "仅发信息", runId: selected.runId });
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const height = panelHeight(this.terminalRows());
    const inner = Math.max(1, safeWidth - 4);
    const title = this.theme.fg("accent", this.theme.bold(this.mode === "列表" ? "Agent 控制台" : "Agent 详情"));
    const body = this.mode === "列表" ? this.renderList(inner, Math.max(1, height - 2)) : this.renderDetail(inner, Math.max(1, height - 2));
    return frame(title, body, safeWidth, this.theme).slice(0, height);
  }

  private actionHint(run?: PersistedRun): string {
    const actions = [];
    if (run?.pendingQuestion) actions.push("A 回答问题");
    if (run && run.status !== "停止中" && run.status !== "停止未确认") actions.push("C 继续", "M 仅发信息");
    if (run && !isTerminalStatus(run.status)) actions.push("X 停止");
    return [...actions, "N 新建", "G 配置", "Esc 返回"].join(" · ");
  }

  private renderList(width: number, height: number): string[] {
    height = Math.min(height, this.runs.length ? this.runs.length * 2 + 5 : 7);
    const lines = [countSummary(this.runs, this.theme), this.theme.fg("muted", `槽位 ${activeRunCount(this.parentSessionId)}/8 · 本会话 ${this.runs.length} 项任务 · Jev ${readDeckConfig().routing.enabled ? "开启" : "关闭"}`), ""];
    this.pageSize = Math.max(1, Math.floor((height - 5) / 2));
    const start = Math.max(0, Math.min(this.selected - Math.floor(this.pageSize / 2), Math.max(0, this.runs.length - this.pageSize)));
    const end = Math.min(this.runs.length, start + this.pageSize);
    for (let index = start; index < end; index++) {
      const run = this.runs[index];
      const selected = index === this.selected;
      const tail = `${fit(statusText(run, this.theme), 12)} ${runTime(run)}`;
      let row = twoColumns(`${selected ? this.theme.fg("accent", "›") : " "} ${this.theme.bold(plain(runTitle(run)))}`, tail, width);
      if (selected && this.theme.bg) row = this.theme.bg("selectedBg", fit(row, width));
      lines.push(row);
      const activity = run.pendingQuestion ? `待回答：${run.pendingQuestion.question}` : run.currentAction ?? (isTerminalStatus(run.status) ? taskOutput(run) : run.status === "排队中" ? "等待工作区写任务结束" : run.status === "等待决定" ? "等待答复后继续" : "等待新的活动记录");
      lines.push(this.theme.fg("muted", `  ${plain(runRoleLabel(run))} · ${plain(executionLabel(run))} · ${plain(activity)}`));
    }
    if (!this.runs.length) lines.push("还没有任务。直接告诉主 Agent 你要完成什么。", "按 N 描述并创建一个专用 Agent。");
    while (lines.length < height - 2) lines.push("");
    lines.push(this.theme.fg(this.refreshError ? "error" : "muted", this.refreshError ? `刷新失败：${this.refreshError}` : this.runs.length ? `显示 ${start + 1}–${end} / ${this.runs.length} · ↑↓ 选择 · Enter 详情` : "↑↓ 选择 · Enter 详情"));
    lines.push(this.theme.fg("muted", this.actionHint(this.runs[this.selected])));
    return lines.slice(0, height);
  }

  private renderDetail(width: number, height: number): string[] {
    const run = this.runs[this.selected];
    if (!run) return ["任务记录不存在。", "Esc 返回"];
    const tabs = (["任务说明", "实时记录", "报告"] as const).map((page, index) => {
      const label = `${index + 1} ${page === "报告" ? "结果" : page === "任务说明" ? "任务" : "实时"}`;
      return page === this.page ? this.theme.fg("accent", this.theme.bold(`[${label}]`)) : this.theme.fg("muted", label);
    }).join("   ");
    const resource = run.resourceState ? { starting: "进程启动中", running: "进程存活", releasing: "进程释放中", released: "进程已释放" }[run.resourceState] : "历史资源状态";
    const lines = [twoColumns(this.theme.bold(plain(runTitle(run))), `${statusText(run, this.theme)} · ${runTime(run)}`, width), this.theme.fg("muted", `${plain(runRoleLabel(run))} · ${resource} · 暂存信息 ${run.queuedMessageCount ?? 0}`), tabs, ""];
    let content = this.page === "任务说明" ? this.renderInstruction(run, width) : this.page === "报告" ? this.renderReports(run, width) : this.renderTranscript(run, width);
    if (run.pendingQuestion) {
      const question = run.pendingQuestion;
      const choices = question.options.map((option, index) => `${index + 1}. ${option}`);
      content = [...this.wrapLines([`待回答问题：${stripTerminalSequences(question.question)}`, ...choices, "A 回答问题；C/M 仅补充，不能解除等待。", ""].join("\n"), width), ...content];
    }
    if (!content.length) content = [this.theme.fg("muted", this.page === "实时记录" ? run.currentAction ?? "等待新的活动记录…" : "暂无结果。")];
    height = Math.min(height, content.length + 7);
    this.pageSize = Math.max(1, height - 7);
    this.maxScroll = Math.max(0, content.length - this.pageSize);
    if (this.page === "实时记录" && this.following) this.scroll = this.maxScroll;
    else if (this.page === "实时记录" && this.anchor) {
      const found = this.logKeys.indexOf(this.anchor);
      if (found >= 0) this.scroll = found;
    }
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    if (this.page === "实时记录" && !this.following) this.anchor = this.logKeys[this.scroll];
    lines.push(...content.slice(this.scroll, this.scroll + this.pageSize));
    while (lines.length < height - 3) lines.push("");
    const position = `${this.scroll + 1}–${Math.min(content.length, this.scroll + this.pageSize)} / ${content.length}`;
    const mode = this.page === "实时记录" ? `${this.following ? "跟随最新" : "已暂停跟随 · End 最新"}${this.logCache?.truncated ? " · 近期日志" : ""}` : "↑↓ / PgUp PgDn 滚动";
    lines.push(this.theme.fg("muted", twoColumns(mode, position, width)));
    lines.push(this.theme.fg("muted", "1 任务 · 2 实时 · 3 结果 · Tab 切换"));
    lines.push(this.theme.fg("muted", this.actionHint(run)));
    return lines.slice(0, height);
  }

  private wrapLines(text: string, width: number, color: any = "text"): string[] {
    return text.split(/\r?\n/).flatMap((line) => wrapTextWithAnsi(this.theme.fg(color, line || " "), Math.max(1, width)));
  }

  private renderInstruction(run: PersistedRun, width: number): string[] {
    return this.wrapLines(`任务编号：${run.runId}\n实例名称：${run.instanceName ?? "未命名"}\n角色：${run.agentName}（${run.agentId}）\n模型：${run.routingPending ? "待选配" : run.model}\n思考强度：${run.routingPending ? "待选配" : run.thinking}\n${run.routing ? decisionText(run.routing) + "\n" : ""}权限：${run.writePermission ? "可写入 / 执行命令" : "只读"}\n\n${run.instruction}`, width);
  }

  private renderTranscript(run: PersistedRun, width: number): string[] {
    const file = path.join(runDirectory(run.runId), "events.jsonl");
    if (run.turnId) {
      this.logCache = { runId: run.runId, stamp: `${run.turnId}:${run.updatedAt}`, entries: run.events, truncated: run.events.length >= 200 };
    } else try {
      const stat = fs.statSync(file);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (this.logCache?.runId !== run.runId || this.logCache.stamp !== stamp) {
        const handle = fs.openSync(file, "r");
        let text: string;
        const start = Math.max(0, stat.size - 128 * 1024);
        try { const buffer = Buffer.alloc(stat.size - start); const count = fs.readSync(handle, buffer, 0, buffer.length, start); text = buffer.subarray(0, count).toString("utf8"); }
        finally { fs.closeSync(handle); }
        if (start) text = text.slice(text.indexOf("\n") + 1);
        const entries = text.split(/\r?\n/).flatMap((line) => { try { const item = JSON.parse(line); return typeof item.text === "string" ? [item] : []; } catch { return []; } });
        this.logCache = { runId: run.runId, stamp, entries, truncated: start > 0 };
      }
    } catch { this.logCache = { runId: run.runId, stamp: "missing", entries: [], truncated: false }; }
    if (this.logRender?.runId === run.runId && this.logRender.stamp === this.logCache.stamp && this.logRender.width === width) {
      this.logKeys = this.logRender.keys;
      return this.logRender.lines;
    }
    const lines: string[] = [];
    this.logKeys = [];
    for (const item of this.logCache.entries) {
      const time = new Date(item.at).toLocaleTimeString("zh-CN", { hour12: false });
      const color = item.kind === "错误" ? "error" : item.kind === "报告" ? "accent" : item.kind === "工具" ? "muted" : "text";
      const wrapped = this.wrapLines(`${time}  ${item.kind}  ${stripTerminalSequences(item.text)}`, width, color);
      const key = createHash("sha1").update(`${item.at}:${item.kind}:${item.text}`).digest("hex");
      wrapped.forEach((line, index) => { lines.push(line); this.logKeys.push(`${key}:${index}`); });
    }
    this.logRender = { runId: run.runId, stamp: this.logCache.stamp, width, lines, keys: this.logKeys };
    return lines;
  }

  private renderMarkdown(text: string, width: number): string[] {
    if (this.reportCache?.text === text && this.reportCache.width === width) return this.reportCache.lines;
    const color = (key: any) => (value: string) => this.theme.fg(key, value);
    const markdown = new Markdown(text, 0, 0, { heading: (value) => this.theme.fg("accent", this.theme.bold(value)), link: color("accent"), linkUrl: color("dim"), code: color("mdCode"), codeBlock: color("text"), codeBlockBorder: color("borderMuted"), quote: color("muted"), quoteBorder: color("borderMuted"), hr: color("borderMuted"), listBullet: color("accent"), bold: (value) => this.theme.bold(value), italic: (value) => value, strikethrough: (value) => value, underline: (value) => value });
    const lines = markdown.render(width);
    this.reportCache = { text, width, lines };
    return lines;
  }
  private renderReports(run: PersistedRun, width: number): string[] {
    const blocks: string[] = [`当前执行：${run.turnId ?? "历史任务"} · ${run.status}`, ""];
    if (run.finalText) blocks.push(run.finalText, "");
    if (!run.reports.length && !run.finalText) blocks.push(isTerminalStatus(run.status) ? taskOutput(run) : "当前执行尚未返回结果。", "");
    for (const report of run.reports) {
      blocks.push(`${report.type === "问题" && run.turnId ? "已回答的问题" : report.type}｜${report.title}`, report.summary);
      if (report.objectiveStatus) blocks.push(`目标状态：${report.objectiveStatus}`);
      for (const item of report.acceptanceCriteria) {
        blocks.push(`[${item.status}] ${item.criterion}`);
        if (item.evidence.length) blocks.push(`  证据：${item.evidence.join("；")}`);
        if (item.notes) blocks.push(`  说明：${item.notes}`);
      }
      if (report.deliverables.length) blocks.push(`交付物：${report.deliverables.join("；")}`);
      if (report.completed.length) blocks.push(`完成：${report.completed.join("；")}`);
      if (report.fileChanges.length) blocks.push(`文件变更：${report.fileChanges.map((item) => `${item.path}（${item.change}）`).join("；")}`);
      else if (report.filesChanged.length) blocks.push(`修改文件：${report.filesChanged.join("；")}`);
      if (report.designDecisions.length) blocks.push(`设计决定：${report.designDecisions.map((item) => `${item.decision}（${item.reason}）`).join("；")}`);
      if (report.commands.length) blocks.push(`命令：${report.commands.join("；")}`);
      if (report.tests.length) blocks.push(`测试：${report.tests.join("；")}`);
      if (report.risks.length) blocks.push(`风险：${report.risks.join("；")}`);
      if (report.unknowns.length) blocks.push(`未知项：${report.unknowns.join("；")}`);
      if (report.downstreamNotes.length) blocks.push(`下游注意：${report.downstreamNotes.join("；")}`);
      if (report.recommendations.length) blocks.push(`建议：${report.recommendations.join("；")}`);
      if (report.question) blocks.push(`问题记录：${report.question}`);
      blocks.push("");
    }
    const history = this.history?.runId === run.runId ? this.history.results : [];
    for (const previous of history.filter((item) => item.turnId !== run.turnId || (!item.turnId && item.endedAt !== run.endedAt)).slice(-5).reverse()) {
      blocks.push(`历史结果｜${previous.turnId ?? "旧版执行"}｜${previous.status}`, taskOutput(previous), "");
    }
    return this.renderMarkdown(blocks.join("\n\n"), width);
  }

  invalidate(): void { this.reportCache = undefined; this.logRender = undefined; }
  dispose(): void { clearInterval(this.timer); }
}

export async function showAgentPanel(ctx: ExtensionContext): Promise<AgentPanelAction> {
  if (ctx.mode !== "tui") return { action: "关闭" };
  const initial = await listRuns(Number.MAX_SAFE_INTEGER, ctx.sessionManager.getSessionId());
  return ctx.ui.custom<AgentPanelAction>((tui, theme, _keys, done) =>
    new AgentPanelComponent(initial, theme, () => tui.requestRender(), done, ctx.sessionManager.getSessionId(), () => tui.terminal?.rows ?? 24), {
      overlay: true,
      overlayOptions: { width: "95%", maxHeight: "75%", anchor: "bottom-center", offsetY: -3, margin: 1 },
    });
}
