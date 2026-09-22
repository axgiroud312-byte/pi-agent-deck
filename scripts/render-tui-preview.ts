// Render the shipped TUI components with isolated fixtures; no model calls or real tasks.
// node --import ./test/environment.mjs --import tsx scripts/render-tui-preview.ts
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { initializeRun, runDirectory } from "../src/runtime.ts";
import { showAgentPanel } from "../src/ui.ts";
import { renderFleet } from "../src/presentation.ts";
import { editAgentConfig, editGlobalConfig, selectAgentTools } from "../src/config-editor.ts";
import { parseAgentDefinition } from "../src/agents.ts";

if (!path.basename(getAgentDir()).startsWith("agent-deck-tests-")) throw new Error("Preview requires the isolated test/environment.mjs preload.");
process.env.COLORTERM = "truecolor";
initTheme("dark", false);
const directory = path.resolve("docs/evidence/0.9.0");
await fs.mkdir(directory, { recursive: true });
const captures: Array<{ id: string; title: string; caption: string; lines: string[]; width: number; rows: number }> = [];
function capture(id: string, title: string, caption: string, lines: string[], width: number, rows: number) {
  if (lines.some((line) => visibleWidth(line) > width)) throw new Error(`Overflow: ${id}`);
  captures.push({ id, title, caption, lines, width, rows });
}
const definitions = [
  ["等待决定", "方案顾问", "确认登录方式是否支持第三方账号", "需要主 Agent 补充需求后继续", 204],
  ["运行中", "代码审查员", "检查登录逻辑与异常处理", "读取 auth/login.ts，检查错误分支", 125],
  ["选配中", "实现工程师", "调整账户设置页面", "Jev 正在选择模型与思考强度", 2],
  ["排队中", "文档助手", "补充登录配置说明", "等待同一工作区的写入任务结束", 48],
  ["已完成", "侦察员", "定位认证模块和调用入口", "已返回文件位置与调用关系", 39],
] as const;
const now = Date.now();
const runs = [];
for (let index = 0; index < definitions.length; index++) {
  const [status, agentName, objective, currentAction, seconds] = definitions[index];
  const run: any = { version: 1, runId: `preview-${index}`, agentId: `fixture-${index}`, agentName, instanceName: `task-${index + 1}`, description: objective, objective, instruction: "检查任务相关文件，报告证据、结论和仍需确认的事项。", currentAction, status, parentSessionId: "tui-preview", model: index === 1 ? "openai-codex/gpt-6-astra" : "openai-codex/gpt-5.6-sol", thinking: index === 1 ? "high" : "medium", routingPending: status === "选配中" || status === "排队中", routing: status === "已完成" ? { model: "openai-codex/gpt-5.6-sol", thinking: "medium", mode: "fallback", elapsedMs: 15000, reason: "演示：Jev 超时后沿用原配置。" } : undefined, writePermission: index === 2 || index === 3, startedAt: now - seconds * 1000, endedAt: status === "已完成" || status === "等待决定" ? now : undefined, reports: [], events: [], finalText: "## 检查结果\n\n**已定位认证入口。**\n\n- 入口：`auth/login.ts`\n- 会话管理：`auth/session.ts`\n- 下一步：核对异常与过期处理。\n\n以上为界面演示内容。" };
  runs.push(await initializeRun(run, { version: 1, cwd: getAgentDir(), command: process.execPath, argsPrefix: [], prompt: "fixture" }, true));
}
const logTexts = ["读取 package.json，确认项目结构", "查找登录入口与调用位置", "读取 auth/login.ts", "检查空输入与错误提示", "读取 auth/session.ts", "核对过期处理与重试逻辑", "整理检查结果及文件位置", "继续核对异常分支，准备返回结论"];
await fs.writeFile(path.join(runDirectory(runs[1].runId), "events.jsonl"), Array.from({ length: 32 }, (_, i) => JSON.stringify({ at: now - (32 - i) * 2000, kind: i % 4 === 3 ? "进度" : "工具", text: logTexts[i % logTexts.length] }) + "\n").join(""));
const width = 90;
const ctx: any = { mode: "tui", model: { id: "当前模型" }, sessionManager: { getSessionId: () => "tui-preview" }, ui: { custom: async (factory: any) => {
  const terminal = { rows: 34 };
  const component = factory({ terminal, requestRender() {} }, theme, undefined, () => {});
  try {
    capture("overview", "任务总览", "短标题、实例名称和角色分开显示；右侧保留状态与耗时。", component.render(width), width, terminal.rows);
    component.handleInput("\u001b[B"); component.handleInput("\u001b[B"); component.handleInput("\r");
    component.handleInput("1");
    capture("identity", "任务身份与完整说明", "实例名称与角色分开；保留完整任务和实际模型。", component.render(width), width, terminal.rows);
    component.handleInput("2");
    capture("live", "实时记录", "默认跟随最新记录；向上翻阅时暂停，End 恢复。", component.render(width), width, terminal.rows);
    component.handleInput("\u001b"); component.handleInput("\u001b[F"); component.handleInput("\r");
    capture("result", "结果阅读", "直接阅读带标题、列表和代码样式的结果。", component.render(width), width, terminal.rows);
    component.handleInput("\u001b"); terminal.rows = 16;
    capture("compact", "小窗口", "宽度 60 列、高度 16 行时的实际组件布局。", component.render(60), 60, terminal.rows);
  } finally { component.dispose(); }
  return { action: "关闭" };
} } };
await showAgentPanel(ctx);
capture("fleet", "主界面摘要", "选配、运行、排队、等答复分别计数；输入 /agents 查看详情。", renderFleet(runs.filter((run) => run.status !== "已完成"), width, 24, theme), width, 24);

function captureDialog(id: string, title: string, caption: string) {
  return async (factory: any) => {
    let result: any;
    const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, (value: any) => { result = value; });
    capture(id, title, caption, component.render(width), width, 30);
    component.handleInput("\u001b");
    return result;
  };
}
ctx.ui.custom = captureDialog("global", "全局设置", "Jev 自动选配独立开关，时限用分钟；改好后统一保存。 ");
await editGlobalConfig(ctx, () => {});
const roleFile = path.join(getAgentDir(), "agents", "reviewer.md");
const roleText = "---\nname: 代码审查员\ndescription: 检查逻辑错误和边界情况\nmodel: inherit\nthinking: high\ntools: [read, grep, find, ls]\ntimeoutMs: 0\n---\n只读审查代码，返回文件位置、证据与修改建议。\n";
await fs.mkdir(path.dirname(roleFile), { recursive: true });
await fs.writeFile(roleFile, roleText);
ctx.ui.custom = captureDialog("role", "Agent 配置", "当前值直接可见；选择字段后调整，无需填写配置文件。 ");
await editAgentConfig(ctx, parseAgentDefinition(roleText, roleFile, "用户"));
ctx.ui.custom = captureDialog("tools", "工具选择", "空格勾选，Enter 应用；命令工具明确提示可修改文件。 ");
await selectAgentTools(ctx, ["read", "grep", "find", "ls"]);

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const palette = ["#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5", "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"];
function ansiColor(index: number): string {
  if (index < 16) return palette[index];
  if (index >= 232) { const value = 8 + (index - 232) * 10; return `rgb(${value},${value},${value})`; }
  const n = index - 16, values = [0, 95, 135, 175, 215, 255];
  return `rgb(${values[Math.floor(n / 36)]},${values[Math.floor(n / 6) % 6]},${values[n % 6]})`;
}
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
function ansiHtml(line: string): string {
  let fg = "#d4d4d4", bg = "transparent", bold = false, position = 0, result = "";
  const append = (text: string) => {
    for (const { segment } of segmenter.segment(text)) result += `<span style="width:${visibleWidth(segment) * 9}px;color:${fg};background:${bg};font-weight:${bold ? 700 : 400}">${escape(segment)}</span>`;
  };
  for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
    append(line.slice(position, match.index)); position = match.index! + match[0].length;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { fg = "#d4d4d4"; bg = "transparent"; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) fg = "#d4d4d4";
      else if (code === 49) bg = "transparent";
      else if (code >= 30 && code <= 37) fg = ansiColor(code - 30);
      else if (code >= 90 && code <= 97) fg = ansiColor(code - 90 + 8);
      else if (code === 38 || code === 48) {
        let color: string | undefined;
        if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4; }
        else if (codes[i + 1] === 5) { color = ansiColor(codes[i + 2]); i += 2; }
        if (color) { if (code === 38) fg = color; else bg = color; }
      }
    }
  }
  append(line.slice(position));
  return `<div class="line">${result || "&nbsp;"}</div>`;
}
const order = ["overview", "live", "role", "tools", "result", "global", "fleet", "compact"];
captures.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
const card = (item: typeof captures[number]) => `<article id="${item.id}"><h2>${escape(item.title)}</h2><p>${escape(item.caption)}</p><div class="terminal">${item.lines.map(ansiHtml).join("")}</div><small>${item.width} 列 · 终端 ${item.rows} 行 · Pi dark 主题</small></article>`;
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Agent Deck 0.9.0 · TUI 组件预览</title><style>*{box-sizing:border-box}body{margin:0;padding:40px;background:#12151a;color:#e1e6ef;font-family:Segoe UI,Microsoft YaHei,sans-serif}header{margin-bottom:30px}h1{font-size:30px;margin:0 0 12px;letter-spacing:.2px}header p{color:#a8b4c6;font-size:16px;margin:0;line-height:1.8}.badge{display:inline-block;color:#8abeb7;background:#223237;padding:5px 10px;border-radius:5px;font-size:13px;margin-bottom:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:26px}article{min-width:0}h2{font-size:19px;margin:0 0 8px}article p{font-size:14px;color:#a8b4c6;margin:0 0 14px;line-height:1.7}.terminal{background:#18181e;border:1px solid #333b47;border-radius:8px;padding:18px;overflow:auto;font:16px/24px Consolas,Microsoft YaHei,monospace}.line{height:24px;white-space:pre}.line span{display:inline-block;vertical-align:top;text-align:left}small{display:block;color:#8994a6;margin-top:10px;font-size:12px}body:has(.single){max-width:1200px}.single .terminal{display:inline-block}@media(max-width:1300px){.grid{grid-template-columns:1fr}}</style><header><div class="badge">实际组件渲染 · 模拟任务数据</div><h1>Agent Deck 0.9.0</h1><p>任务、进度和配置，在终端里直接看清楚。<br>这些预览调用插件的实际组件生成，使用隔离的模拟数据；不是当前运行会话的终端截图。</p></header><main class="grid">${captures.map(card).join("")}</main></html>`;
await fs.writeFile(path.join(directory, "tui-preview.html"), html);
await fs.writeFile(path.join(directory, "overview.html"), html.replace(/<main class="grid">[\s\S]*<\/main>/, `<main class="single">${card(captures[0])}</main>`));
await fs.writeFile(path.join(directory, "rendered-components.json"), JSON.stringify({ version: "0.9.0", provenance: "actual TUI components; isolated fixture data; not a native terminal capture", captures }, null, 2));
console.log(`Rendered ${captures.length} component previews into ${directory}`);
