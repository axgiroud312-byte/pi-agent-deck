import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import agentDeck from "../src/index.ts";
import { AGENT_DECK_VERSION } from "../src/version.ts";

const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

test("package 版本与运行时代码版本一致", () => {
  assert.equal(packageJson.version, AGENT_DECK_VERSION);
});

test("doctor 展示当前 RPC 运行方式、任务概况和角色能力诊断", async () => {
  const commands = new Map<string, any>();
  const notifications: Array<{ message: string; level: string }> = [];
  agentDeck({
    on() {},
    registerTool() {},
    registerCommand: (name: string, command: any) => commands.set(name, command),
    registerMessageRenderer() {},
    getActiveTools: () => [],
    setActiveTools() {},
    sendMessage() {},
  } as any);
  const doctor = commands.get("agent-doctor");
  assert.ok(doctor);
  assert.match(doctor.description, /通信方式/);
  assert.match(doctor.description, /角色工具能力/);
  await doctor.handler("", {
    mode: "tui",
    cwd: getAgentDir(),
    isProjectTrusted: () => false,
    sessionManager: { getSessionId: () => "doctor-parent" },
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
  });
  assert.equal(notifications.length, 1);
  const output = notifications[0].message;
  assert.match(output, new RegExp(`Agent Deck ${AGENT_DECK_VERSION}`));
  assert.match(output, /主 Pi 管理 RPC 子会话/);
  assert.match(output, /当前会话任务：0/);
  assert.match(output, /并发数量由主 Agent 与实际环境决定/);
  assert.match(output, /关闭或重载主 Pi会结束|关闭或重载主 Pi 会结束/);
  assert.doesNotMatch(output, /runtime-ack|协议版本|构建指纹|Runner/);
});
