import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const runnerPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/runner.mjs");

function baseStatus(runId: string) {
  return {
    version: 1,
    runId,
    agentId: "test",
    agentName: "测试 Agent",
    agentSource: "内置",
    objective: "测试 Runner",
    instruction: "测试",
    status: "运行中",
    model: "test/model",
    thinking: "off",
    tools: ["agent_report"],
    writePermission: false,
    parentSessionId: "parent",
    childSessionId: "child",
    childSessionPath: "child.jsonl",
    startedAt: Date.now(),
    reports: [],
    events: [],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    updatedAt: Date.now(),
  };
}

async function waitForTerminal(statusPath: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const status = JSON.parse(await fs.promises.readFile(statusPath, "utf8"));
      if (["已完成", "失败", "已停止"].includes(status.status)) return status;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Runner 测试超时");
}

async function setupRun(fakeSource: string, naturalOutput = false): Promise<{ directory: string; statusPath: string }> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-agent-deck-runner-test-"));
  const fakePath = path.join(directory, "fake-child.mjs");
  const statusPath = path.join(directory, "status.json");
  await fs.promises.writeFile(fakePath, fakeSource, "utf8");
  await fs.promises.writeFile(statusPath, JSON.stringify(baseStatus(path.basename(directory))), "utf8");
  await fs.promises.writeFile(path.join(directory, "request.json"), JSON.stringify({
    version: 1,
    cwd: directory,
    command: process.execPath,
    argsPrefix: [fakePath],
    prompt: "测试任务",
    naturalOutput,
    inboxPath: path.join(directory, "inbox.jsonl"),
  }), "utf8");
  return { directory, statusPath };
}

test("Runner 捕获最终报告并收敛为已完成", async (t) => {
  const { directory, statusPath } = await setupRun(`
console.log(JSON.stringify({type:"tool_execution_start",toolName:"read",args:{path:"a.ts"}}));
console.log(JSON.stringify({type:"tool_execution_end",toolName:"agent_report",isError:false,result:{details:{type:"最终",title:"完成",summary:"测试完成",evidence:[],completed:[],filesRead:["a.ts"],filesChanged:[],commands:[],tests:[],risks:[],unknowns:[],recommendations:[],options:[],blocking:false}}}));
`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = spawn(process.execPath, [runnerPath, "--run-dir", directory], { stdio: "ignore" });
  const status = await waitForTerminal(statusPath);
  if (runner.exitCode === null) await new Promise((resolve) => runner.once("close", resolve));
  assert.equal(status.status, "已完成");
  assert.equal(status.reports[0].summary, "测试完成");
  assert.match(fs.readFileSync(path.join(directory, "events.jsonl"), "utf8"), /读取文件 a\.ts/);
  const inbox = fs.readFileSync(path.join(directory, "inbox.jsonl"), "utf8");
  assert.match(inbox, /"status":"已完成"/);
});

test("简洁模式接受自然语言结束，不把中途工具调用文本当作完成", async (t) => {
  for (const reason of ["stop", "toolUse", "error"]) {
    const { directory, statusPath } = await setupRun(`console.log(JSON.stringify({type:"message_end",message:{role:"assistant",stopReason:${JSON.stringify(reason)},content:[{type:"text",text:"中文调查结论"}]}}));`, true);
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const runner = spawn(process.execPath, [runnerPath, "--run-dir", directory], { stdio: "ignore" });
    await new Promise((resolve) => runner.once("close", resolve));
    const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
    assert.equal(status.status, reason === "stop" ? "已完成" : "失败");
    assert.equal(status.finalText, "中文调查结论");
  }
});

test("Runner 拒绝没有最终报告的伪成功", async (t) => {
  const { directory, statusPath } = await setupRun(`console.log(JSON.stringify({type:"agent_start"}));`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = spawn(process.execPath, [runnerPath, "--run-dir", directory], { stdio: "ignore" });
  const status = await waitForTerminal(statusPath);
  if (runner.exitCode === null) await new Promise((resolve) => runner.once("close", resolve));
  assert.equal(status.status, "失败");
  assert.ok(status.events.some((event: any) => event.text.includes("未按协议提交最终报告")));
});

test("子程序无法启动时落盘失败状态而不是一直运行", async (t) => {
  const { directory, statusPath } = await setupRun("", true);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const requestPath = path.join(directory, "request.json");
  const request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
  fs.writeFileSync(requestPath, JSON.stringify({ ...request, command: path.join(directory, "missing-program") }));
  const runner = spawn(process.execPath, [runnerPath, "--run-dir", directory], { stdio: "ignore" });
  await new Promise((resolve) => runner.once("close", resolve));
  const status = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  assert.equal(status.status, "失败");
  assert.match(status.stderr, /ENOENT/);
});

test("Runner 能识别阻塞问题并保持原运行可继续", async (t) => {
  const { directory, statusPath } = await setupRun(`
console.log(JSON.stringify({type:"tool_execution_end",toolName:"agent_report",isError:false,result:{details:{type:"问题",title:"需要决定",summary:"是否兼容旧接口",evidence:[],completed:[],filesRead:[],filesChanged:[],commands:[],tests:[],risks:[],unknowns:[],recommendations:[],question:"是否兼容旧接口？",options:["是","否"],blocking:true}}}));
`);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runner = spawn(process.execPath, [runnerPath, "--run-dir", directory], { stdio: "ignore" });
  const deadline = Date.now() + 10_000;
  let status: any;
  while (Date.now() < deadline) {
    status = JSON.parse(await fs.promises.readFile(statusPath, "utf8"));
    if (status.status === "等待决定") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(status.status, "等待决定");
  assert.equal(status.reports[0].blocking, true);
  if (runner.exitCode === null) await new Promise((resolve) => runner.once("close", resolve));
});
