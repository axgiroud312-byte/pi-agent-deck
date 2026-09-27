import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import agentDeck from "../src/index.ts";

test("图片限制进入模型可见说明和诊断，遵循项目覆盖与信任且不改配置", async (t) => {
  const cwd = await fs.mkdtemp(path.join(getAgentDir(), "image-settings-"));
  const globalFile = path.join(getAgentDir(), "settings.json");
  const projectFile = path.join(cwd, ".pi", "settings.json");
  await fs.mkdir(path.dirname(projectFile));
  const original = await fs.readFile(globalFile, "utf8").catch(() => undefined);
  t.after(async () => {
    if (original === undefined) await fs.rm(globalFile, { force: true });
    else await fs.writeFile(globalFile, original);
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const tools = new Map<string, any>(), handlers = new Map<string, any>(), commands = new Map<string, any>();
  const notices: Array<{ text: string; level: string }> = [];
  agentDeck({
    on: (name: string, fn: any) => handlers.set(name, fn),
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer() {}, getActiveTools: () => [], setActiveTools() {}, sendMessage() {},
  } as any);
  const ctx = (trusted: boolean) => ({ cwd, isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "image-settings-parent" },
    ui: { notify: (text: string, level: string) => notices.push({ text, level }) } });
  const cases = [
    { name: "默认允许", global: {}, project: {}, trusted: true, warning: false, source: "Pi 默认值" },
    { name: "全局禁图", global: { images: { blockImages: true } }, project: {}, trusted: true, warning: true, source: globalFile },
    { name: "可信项目允许覆盖全局禁止", global: { images: { blockImages: true } }, project: { images: { blockImages: false } }, trusted: true, warning: false, source: projectFile },
    { name: "未信任项目的允许被忽略", global: { images: { blockImages: true } }, project: { images: { blockImages: false } }, trusted: false, warning: true, source: globalFile },
    { name: "可信项目禁止覆盖全局允许", global: { images: { blockImages: false } }, project: { images: { blockImages: true } }, trusted: true, warning: true, source: projectFile },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const globalText = JSON.stringify(scenario.global), projectText = JSON.stringify(scenario.project);
      await fs.writeFile(globalFile, globalText);
      await fs.writeFile(projectFile, projectText);
      await handlers.get("before_agent_start")({}, ctx(scenario.trusted));
      const description = tools.get("Agent").description;
      assert.equal(description.includes("images.blockImages=true"), scenario.warning);
      if (scenario.warning) assert.ok(description.includes(scenario.source));
      await commands.get("agent-doctor").handler("", ctx(scenario.trusted));
      const notice = notices.at(-1)!;
      assert.equal(notice.level, scenario.warning ? "warning" : "info");
      assert.ok(notice.text.includes(scenario.source));
      assert.match(notice.text, /不代表运行中会话的内存设置/);
      assert.equal(await fs.readFile(globalFile, "utf8"), globalText);
      assert.equal(await fs.readFile(projectFile, "utf8"), projectText);
    });
  }
  await t.test("损坏配置不能被误报为允许传图，也不泄露解析原文", async () => {
    await fs.writeFile(globalFile, '{"privateValue":"DO_NOT_EXPOSE_THIS_SECRET", broken');
    await fs.writeFile(projectFile, "{}");
    await handlers.get("before_agent_start")({}, ctx(true));
    const description = tools.get("Agent").description;
    assert.match(description, /磁盘配置无法确认/);
    assert.ok(description.includes(globalFile));
    assert.doesNotMatch(description, /DO_NOT_EXPOSE|images.blockImages=false|配置允许传图/);
    await commands.get("agent-doctor").handler("", ctx(true));
    assert.equal(notices.at(-1)!.level, "warning");
    assert.doesNotMatch(notices.at(-1)!.text, /DO_NOT_EXPOSE/);
  });
  await t.test("无效布尔值不被当作可靠设置", async () => {
    await fs.writeFile(globalFile, JSON.stringify({ images: { blockImages: "false" } }));
    await handlers.get("before_agent_start")({}, ctx(true));
    assert.match(tools.get("Agent").description, /images.blockImages 应为布尔值/);
  });
});
