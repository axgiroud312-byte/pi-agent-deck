// Render real TUI components with isolated credentials and a simulated metadata response.
// node --import ./test/environment.mjs --import tsx scripts/render-jev-preview.ts
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { initTheme, theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { editJevConfig } from "../src/jev-ui.ts";
import { chooseRenderedMenu } from "../test/menu-harness.ts";

assert.ok(path.basename(getAgentDir()).startsWith("agent-deck-tests-"), "Requires test/environment.mjs");
process.env.COLORTERM = "truecolor";
initTheme("dark", false);
const captures: Array<{ title: string; caption: string; width: number; lines: string[] }> = [];
const fakeKey = "preview-only-not-a-real-key";
function capture(component: any, title: string, caption: string, width = 82) {
  const lines = component.render(width);
  assert.ok(lines.every((line: string) => visibleWidth(line) <= width));
  assert.ok(!lines.join("\n").includes(fakeKey));
  captures.push({ title, caption, width, lines });
}
const steps: Array<(component: any) => void> = [
  (c) => { capture(c, "1. 打开 Jev 配置", "输入 /agent-router，或从 /agent-config 进入。密钥、模型和连接状态集中显示。"); choose(c, "① API 密钥"); },
  (c) => { c.handleInput("\u001b[200~" + fakeKey + "\u001b[201~"); capture(c, "2. 粘贴 API 密钥", "内容始终遮挡；Enter 应用到草稿，Ctrl+U 清空。此处是假密钥。"); c.handleInput("\r"); },
  (c) => choose(c, "② Jev 模型"),
  (c) => { capture(c, "3. 选择 Jev 模型", "固定版本保持一致；也可选择稳定版、预览版，或填写官方版本 ID。"); choose(c, "最新稳定版"); },
  (c) => choose(c, "③ 测试连接"),
  () => {},
  (c) => { capture(c, "4. 检查后保存", "这里用模拟模型列表展示成功状态。列表连通后仍可试选，再保存当前草稿。"); capture(c, "较窄的终端", "60 列布局；↑↓ 选择，Enter 确认，Esc 返回。", 60); choose(c, "保存并返回"); },
];
function choose(component: any, prefix: string) {
  chooseRenderedMenu({ render: (width: number) => component.render(width).map(stripAnsi), handleInput: (data: string) => component.handleInput(data) }, prefix);
}
globalThis.fetch = async (url) => {
  assert.equal(url, "https://api.typesafe.ai/v1/models");
  return Response.json({ models: [{ name: "jev-latest" }, { name: "jev-preview" }] });
};
const ctx: any = { mode: "tui", ui: {
  notify: () => {},
  custom: (factory: any) => new Promise((resolve, reject) => {
    const component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, undefined, resolve);
    try { const step = steps.shift(); assert.ok(step, "Unexpected dialog"); step(component); } catch (error) { reject(error); }
  }),
} };
await editJevConfig(ctx);
assert.equal(steps.length, 0);

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
function ansiHtml(line: string) {
  let color = "#d4d4d4", background = "transparent", bold = false, offset = 0, result = "";
  const append = (text: string) => {
    for (const { segment } of segmenter.segment(text)) result += `<span style="width:${visibleWidth(segment) * 8.5}px;color:${color};background:${background};font-weight:${bold ? 700 : 400}">${escape(segment)}</span>`;
  };
  for (const match of line.matchAll(/\x1b\[([\d;]*)m/g)) {
    append(line.slice(offset, match.index)); offset = match.index! + match[0].length;
    const codes = (match[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0) { color = "#d4d4d4"; background = "transparent"; bold = false; }
      else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39) color = "#d4d4d4";
      else if (code === 49) background = "transparent";
      else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
        const value = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`; i += 4;
        if (code === 38) color = value; else background = value;
      }
    }
  }
  append(line.slice(offset)); return `<div class="line">${result || "&nbsp;"}</div>`;
}
const cards = captures.map((c) => `<article><h2>${escape(c.title)}</h2><p>${escape(c.caption)}</p><div class="terminal">${c.lines.map(ansiHtml).join("")}</div><small>${c.width} 列 · Pi dark 主题</small></article>`).join("");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jev 可视化配置 · Agent Deck 0.9.3</title><style>*{box-sizing:border-box}body{margin:0;padding:32px;background:#12151a;color:#e1e6ef;font-family:Segoe UI,Microsoft YaHei,sans-serif}header{margin-bottom:30px}h1{font-size:28px;margin:10px 0}p{line-height:1.8;color:#a8b4c6}.badge{color:#8abeb7;font-size:14px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:32px}article{min-width:0}h2{font-size:19px;margin:0}article p{font-size:14px;margin:8px 0 14px}.terminal{background:#18181e;border:1px solid #333b47;border-radius:8px;padding:16px;overflow:auto;font:15px/24px Consolas,Microsoft YaHei,monospace}.line{height:24px;white-space:pre}.line span{display:inline-block;vertical-align:top;text-align:left}small{color:#8994a6;display:block;margin-top:8px}@media(max-width:1500px){.grid{grid-template-columns:1fr}}code{color:#b8dce0}</style><header><span class="badge">实际 TUI 组件 · 假密钥与模拟连接结果</span><h1>Jev 配置，现在可以直接在 Pi 里完成</h1><p><code>/reload</code> → <code>/agent-router</code> → 填密钥 → 选模型 → 检查并保存。<br>这些预览调用插件实际组件生成，不是原生终端截图，也不代表个人账号已连通。</p></header><main class="grid">${cards}</main></html>`;
assert.ok(!html.includes(fakeKey));
const directory = path.resolve("docs/evidence/0.9.3");
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, "jev-config-preview.html"), html);
await fs.writeFile(path.join(directory, "rendered-components.json"), JSON.stringify({ version: "0.9.3", provenance: "actual TUI components; simulated credentials and metadata; not native terminal screenshot", captures }, null, 2));
console.log(`Rendered ${captures.length} Jev component previews into ${directory}`);
