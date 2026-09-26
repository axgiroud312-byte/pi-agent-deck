import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import * as runtime from "../src/runtime.ts";
import { taskOutput, resultMessage } from "../src/delivery.ts";
import { showAgentPanel } from "../src/ui.ts";
import { conversationBlocks } from "../src/conversation.ts";
import { parseAgentDefinition, validateAgentDefinition } from "../src/agents.ts";
import { readCompletions } from "../src/persistence.mjs";

const piMain = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piCli = path.join(path.dirname(piMain), "bundle", "cli.js");
const providerExtension = fileURLToPath(new URL("./fixtures/rpc-faux-provider.ts", import.meta.url));
const childExtension = fileURLToPath(new URL("../src/child-runtime.ts", import.meta.url));
const roleProbeExtension = fileURLToPath(new URL("./fixtures/role-probe-extension.ts", import.meta.url));

interface RunOptions {
  tools?: string[];
  disallowedTools?: string[];
  extensions?: string[];
  cwd?: string;
  parentSessionId?: string;
}

async function until<T>(read: () => Promise<T | undefined>, label: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 ${label} 超时`);
}

function alive(pid?: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function lines(file: string): Promise<any[]> {
  try {
    return (await fs.readFile(file, "utf8")).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function createRun(t: any, prompt: string, options: RunOptions = {}) {
  const ownedCwd = !options.cwd;
  const cwd = options.cwd ?? await fs.mkdtemp(path.join(os.tmpdir(), "deck-real-rpc-"));
  const runId = `rpc-integration-${randomUUID()}`;
  const parentSessionId = options.parentSessionId ?? randomUUID();
  const childSessionId = randomUUID();
  const childManager = SessionManager.create(cwd, undefined, { id: childSessionId });
  childManager.appendSessionInfo(`real RPC fixture ${runId}`);
  const childSessionPath = childManager.getSessionFile();
  assert.ok(childSessionPath);
  await fs.writeFile(childSessionPath, [childManager.getHeader(), ...childManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const log = path.join(cwd, `${runId}-provider.jsonl`);
  const turnId = randomUUID();
  const startedAt = Date.now();
  const extensions = options.extensions ?? [];
  const disallowedTools = options.disallowedTools ?? [];
  const details: any = {
    version: 3, runId, turnId,
    roleId: "scout", agentName: "local RPC fixture", agentSource: "内置",
    objective: prompt, instruction: prompt, status: "运行中",
    model: "deck-local-fixture/scripted", thinking: "off",
    tools: options.tools, disallowedTools, extensions,
    parentSessionId, childSessionId, childSessionPath, cwd, startedAt, events: [],
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  const argsPrefix = [
    piCli, "--mode", "rpc", "--session", childSessionPath,
    "--model", details.model, "--thinking", details.thinking,
    "--no-extensions", "--extension", providerExtension,
    ...extensions.flatMap((extension) => ["--extension", extension]),
    "--extension", childExtension,
    ...(options.tools ? ["--tools", options.tools.join(",")] : []),
    ...(disallowedTools.length ? ["--exclude-tools", disallowedTools.join(",")] : []),
  ];
  const runDir = runtime.runDirectory(runId);
  await runtime.initializeRun(details, {
    version: 3, cwd, command: process.execPath, argsPrefix, prompt, timeoutMs: 0,
    env: { PI_AGENT_DECK_RUN_ID: runId, PI_AGENT_DECK_FIXTURE_LOG: log },
  }, true);
  t.after(async () => {
    try { await runtime.stopRun(runId); } catch { /* already settled */ }
    await runtime.shutdownRuns(parentSessionId);
    await fs.rm(runDir, { recursive: true, force: true });
    if (ownedCwd) await fs.rm(cwd, { recursive: true, force: true });
  });
  return { runId, parentSessionId, childSessionId, childSessionPath, cwd, log };
}

test("真实 Pi RPC：自然文本完成、运行中补充、空闲不暗启及明确 resume", async (t) => {
  const fixture = await createRun(t, "DECK_TOOL_CASE", { tools: ["deck_pause"] });
  await runtime.launchRunner(fixture.runId);
  const live = await until(async () => (await lines(fixture.log)).some((item) => item.type === "long_tool_start") ? runtime.readRun(fixture.runId) : undefined, "工具开始");
  await assert.rejects(runtime.resumeRun(fixture.runId, "不得并行恢复"), /运行/);
  await runtime.sendToRun(fixture.runId, "DECK_EARLY_STEER");
  const result = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.resourceState === "released" ? run : undefined;
  }, "返回自然文本并释放");
  assert.equal(result.status, "已完成");
  assert.equal(result.finalText, "DECK_TOOL_DONE");
  assert.equal(alive(live?.childPid), false);
  const rawStatus = JSON.parse(await fs.readFile(runtime.statusPath(fixture.runId), "utf8"));
  for (const retired of ["effectiveConfig", "writePermission", "result", "resultCompleteness", "toolEvidence", "writerLease", "capabilities"]) {
    assert.equal(retired in rawStatus, false, `v3 不应写入旧字段 ${retired}`);
  }
  const calls = (await lines(fixture.log)).filter((item) => item.type === "provider_call");
  assert.equal(calls.length, 2, "工具结束后由下一次模型输出自然最终文本");
  assert.match(calls[1].transcript, /DECK_EARLY_STEER/);

  const sessionBefore = await fs.readFile(fixture.childSessionPath, "utf8");
  const view = conversationBlocks(result, true).map((block) => block.text).join("\n");
  assert.match(view, /DECK_TOOL_CASE/);
  assert.match(view, /工具调用：deck_pause/);
  assert.match(view, /tool completed/);
  assert.match(view, /DECK_TOOL_DONE/);
  const actions: unknown[] = [];
  await showAgentPanel({
    mode: "tui",
    sessionManager: { getSessionId: () => fixture.parentSessionId },
    ui: { custom: async (factory: any) => {
      const theme = { fg: (_: string, value: string) => value, bg: (_: string, value: string) => value, bold: (value: string) => value };
      const component = factory({ terminal: { rows: 48 }, requestRender() {} }, theme, undefined, (action: unknown) => actions.push(action));
      try {
        const list = component.render(120).join("\n");
        assert.match(list, /进程已释放/);
        component.handleInput("\r");
        component.handleInput("\u001b[H");
        const screen = component.render(120).join("\n");
        assert.match(screen, /子会话 · 只读/);
        assert.match(screen, /DECK_TOOL_CASE/);
        for (const key of ["c", "m", "a"]) component.handleInput(key);
        assert.deepEqual(actions, []);
      } finally { component.dispose(); }
      return { action: "关闭" };
    } },
  } as any);
  assert.equal(await fs.readFile(fixture.childSessionPath, "utf8"), sessionBefore, "只读查看不能改写子会话");

  const deferred = await runtime.sendToRun(fixture.runId, "DECK_IDLE_INFORMATION");
  assert.equal(deferred.delivery, "deferred");
  assert.equal(deferred.run.resourceState, "released");
  assert.equal((await lines(fixture.log)).filter((item) => item.type === "provider_call").length, 2, "SendMessage 不暗中启动新轮次");
  await runtime.resumeRun(fixture.runId, "DECK_CONTINUE_CASE", "补充验证");
  const resumed = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.resourceState === "released" && run.turnId !== result.turnId ? run : undefined;
  }, "resume 完成");
  assert.equal(resumed.status, "已完成");
  assert.equal(resumed.finalText, "DECK_CONTINUE_DONE");
  assert.equal(resumed.childSessionId, fixture.childSessionId);
  assert.equal(resumed.childSessionPath, fixture.childSessionPath);
  assert.equal(resumed.description, "补充验证");
  const last = (await lines(fixture.log)).filter((item) => item.type === "provider_call").at(-1);
  assert.match(last.transcript, /DECK_IDLE_INFORMATION/);
  assert.match(last.transcript, /DECK_CONTINUE_CASE/);
  assert.equal(resumed.queuedMessageCount, 0);
});

test("真实 Pi 宿主：角色扩展实际加载和调用，工具选择与续接配置生效", async (t) => {
  const roleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "deck-role-config-"));
  const roleFile = path.join(roleDirectory, "probe.md");
  const markdown = `---\nid: role-probe\nname: 扩展探针\ntools: ["read", "RoleProbe", "HiddenProbe"]\ndisallowedTools: ["HiddenProbe", "edit", "write"]\nextensions: [${JSON.stringify(roleProbeExtension)}]\n---\n调用扩展工具并返回证据。\n`;
  await fs.writeFile(roleFile, markdown);
  t.after(() => fs.rm(roleDirectory, { recursive: true, force: true }));
  const role = parseAgentDefinition(markdown, roleFile, "用户");
  assert.deepEqual(validateAgentDefinition(role), []);
  assert.deepEqual(role.tools, ["read", "RoleProbe"]);
  assert.deepEqual(role.disallowedTools, ["HiddenProbe", "edit", "write"]);
  assert.deepEqual(role.extensions, [roleProbeExtension]);

  const fixture = await createRun(t, "DECK_ROLE_EXTENSION_CASE", {
    tools: role.tools, extensions: role.extensions, disallowedTools: role.disallowedTools,
  });
  await runtime.launchRunner(fixture.runId);
  const first = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.resourceState === "released" ? run : undefined;
  }, "角色扩展首轮完成");
  assert.equal(first.finalText, "ROLE_EXTENSION_DONE");
  const firstLog = await lines(fixture.log);
  const roleCalls = firstLog.filter((item) => item.type === "role_probe");
  assert.equal(roleCalls.length, 1, "必须执行真实扩展工具，而非只检查启动参数");
  assert.equal(roleCalls[0].value, "configured-role-extension");
  assert.ok(!firstLog.some((item) => item.type === "hidden_probe_called"));
  const active = firstLog.find((item) => item.type === "active_tools");
  const providerCalls = firstLog.filter((item) => item.type === "provider_call");
  assert.ok(active.tools.includes("RoleProbe"));
  assert.ok(!active.tools.includes("HiddenProbe"));
  assert.ok(!active.tools.includes("edit"));
  assert.ok(!active.tools.includes("write"));
  assert.match(providerCalls[1].transcript, /ROLE_PROBE_RESULT:configured-role-extension/);
  const session = conversationBlocks(first, true).map((block) => block.text).join("\n");
  assert.match(session, /工具调用：RoleProbe/);
  assert.match(session, /ROLE_PROBE_RESULT:configured-role-extension/);

  // 修改角色源文件只影响新任务；resume 继续使用任务已保存的工具和扩展快照。
  await fs.writeFile(roleFile, "---\nid: role-probe\nname: 已修改角色\ntools: read\n---\n不再使用扩展。\n");
  const previousTurn = first.turnId;
  await runtime.resumeRun(fixture.runId, "DECK_ROLE_EXTENSION_CASE");
  const second = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.turnId !== previousTurn ? run : undefined;
  }, "角色扩展续接完成");
  assert.deepEqual(second.extensions, [roleProbeExtension]);
  assert.deepEqual(second.tools, ["read", "RoleProbe"]);
  assert.equal((await lines(fixture.log)).filter((item) => item.type === "role_probe").length, 2);

  const updatedMarkdown = await fs.readFile(roleFile, "utf8");
  const updatedRole = parseAgentDefinition(updatedMarkdown, roleFile, "用户");
  const fresh = await createRun(t, "DECK_CAPABILITY_CASE", {
    tools: updatedRole.tools, extensions: updatedRole.extensions, disallowedTools: updatedRole.disallowedTools,
  });
  await runtime.launchRunner(fresh.runId);
  const freshRun = await until(async () => {
    const run = await runtime.readRun(fresh.runId);
    return run?.status === "已完成" && run.resourceState === "released" ? run : undefined;
  }, "修改后的角色用于新任务");
  assert.deepEqual(freshRun.tools, ["read"]);
  assert.deepEqual(freshRun.extensions, []);
  const freshLog = await lines(fresh.log);
  assert.ok(!freshLog.find((item) => item.type === "active_tools").tools.includes("RoleProbe"));
  assert.ok(!freshLog.some((item) => item.type === "role_probe"));
});

test("真实 Pi 宿主：扩展加载失败明确结束且释放进程", async (t) => {
  const invalidDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "deck-invalid-extension-"));
  const invalidExtension = path.join(invalidDirectory, "broken-extension.ts");
  await fs.writeFile(invalidExtension, "export default function broken( { this is not valid TypeScript");
  t.after(() => fs.rm(invalidDirectory, { recursive: true, force: true }));
  const fixture = await createRun(t, "BROKEN_EXTENSION_MUST_FAIL", { extensions: [invalidExtension] });
  await runtime.launchRunner(fixture.runId);
  const failed = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "失败" && run.resourceState === "released" ? run : undefined;
  }, "扩展加载失败收口");
  assert.match(failed.failureReason ?? failed.stderr ?? "", /扩展|Unexpected|Transform|加载|parse/i);
  assert.equal(failed.childPid, undefined);
});

test("真实 Pi 组合：并行探索、一个实施角色、带 Bash 的并行审查、扩展与 resume", async (t) => {
  const started = Date.now();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-real-workflow-"));
  const parentSessionId = randomUUID();
  t.after(() => fs.rm(cwd, { recursive: true, force: true }));
  const shared = { cwd, parentSessionId };
  const scoutOne = await createRun(t, "DECK_CONTINUE_CASE SCOUT_ONE", { ...shared, disallowedTools: ["edit", "write"] });
  const scoutTwo = await createRun(t, "DECK_CONTINUE_CASE SCOUT_TWO", { ...shared, disallowedTools: ["edit", "write"] });
  const worker = await createRun(t, "DECK_WORKFLOW_WORKER_CASE", {
    ...shared, tools: ["RoleProbe", "deck_pause"], extensions: [roleProbeExtension],
  });
  const reviewerOne = await createRun(t, "DECK_BASH_REVIEW_CASE REVIEW_ONE", { ...shared, disallowedTools: ["edit", "write"] });
  const reviewerTwo = await createRun(t, "DECK_BASH_REVIEW_CASE REVIEW_TWO", { ...shared, disallowedTools: ["edit", "write"] });

  await Promise.all([runtime.launchRunner(scoutOne.runId), runtime.launchRunner(scoutTwo.runId)]);
  await until(async () => {
    const runs = await Promise.all([scoutOne, scoutTwo].map((item) => runtime.readRun(item.runId)));
    return runs.every((run) => run?.resourceState === "released" && run.status === "已完成") ? runs as any : undefined;
  }, "并行探索完成");

  await Promise.all([runtime.launchRunner(worker.runId), runtime.launchRunner(reviewerOne.runId), runtime.launchRunner(reviewerTwo.runId)]);
  await until(async () => {
    const reviewerLogs = await Promise.all([reviewerOne, reviewerTwo].map((item) => lines(item.log)));
    const runs = await Promise.all([reviewerOne, reviewerTwo].map((item) => runtime.readRun(item.runId)));
    const bothInsideControlledTool = reviewerLogs.every((log) => log.some((entry) => entry.type === "long_tool_start") && !log.some((entry) => entry.type === "long_tool_end"));
    const bothAlive = runs.every((run) => run?.status === "运行中" && alive(run.childPid));
    return bothInsideControlledTool && bothAlive ? true : undefined;
  }, "两个 Bash reviewer 生命周期重叠");
  await until(async () => {
    const runs = await Promise.all([worker, reviewerOne, reviewerTwo].map((item) => runtime.readRun(item.runId)));
    return runs.every((run) => run?.resourceState === "released" && run.status === "已完成") ? runs as any : undefined;
  }, "实施与并行审查完成");
  assert.ok((await lines(worker.log)).some((entry) => entry.type === "role_probe"));
  for (const reviewer of [reviewerOne, reviewerTwo]) {
    const log = await lines(reviewer.log);
    const active = log.find((entry) => entry.type === "active_tools");
    assert.ok(active.tools.includes("bash"));
    assert.ok(!active.tools.includes("edit"));
    assert.ok(!active.tools.includes("write"));
    const calls = log.filter((entry) => entry.type === "provider_call");
    assert.match(calls.at(-1).transcript, /node --version/);
    assert.match(calls.at(-1).transcript, /toolName[^}]*bash/);
  }

  const previous = (await runtime.readRun(worker.runId))!;
  const resumed = await runtime.resumeRun(worker.runId, "DECK_WORKFLOW_FIX_CASE");
  const finalWorker = await until(async () => {
    const run = await runtime.readRun(worker.runId);
    return run?.resourceState === "released" && run.status === "已完成" && run.turnId === resumed.turnId ? run : undefined;
  }, "真实组合实施任务续接");
  assert.equal(finalWorker.childSessionId, previous.childSessionId);
  assert.equal(finalWorker.finalText, "WORKFLOW_RESUME_DONE");
  assert.equal((await lines(worker.log)).filter((entry) => entry.type === "role_probe").length, 2);

  const workflow = [worker, scoutOne, scoutTwo, reviewerOne, reviewerTwo];
  const providerCallCount = (await Promise.all(workflow.map((item) => lines(item.log))))
    .flat().filter((entry) => entry.type === "provider_call").length;
  const histories = (await Promise.all(workflow.map((item) => readCompletions(runtime.runDirectory(item.runId))))).flat();
  const totalTokens = histories.reduce((sum, run: any) => sum + (run.usage?.totalTokens ?? 0), 0);
  t.diagnostic(`real-Pi workflow: tasks=5 turns=6 providerCalls=${providerCallCount} elapsedMs=${Date.now() - started} totalTokens=${totalTokens} resumeFixes=1`);
});

test("真实 Pi RPC：停止会中断本地模型并清空待发送消息", async (t) => {
  const fixture = await createRun(t, "DECK_STOP_CASE");
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await lines(fixture.log)).some((entry) => entry.type === "provider_call") ? true : undefined, "待中止的本地模型调用");
  await runtime.sendToRun(fixture.runId, "DECK_QUEUED_BEFORE_STOP");
  const stopped = await runtime.stopRun(fixture.runId);
  assert.ok(["已停止", "已取消"].includes(stopped.status));
  await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run && !alive(run.runnerPid) && !alive(run.childPid) ? run : undefined;
  }, "停止进程");
  const calls = (await lines(fixture.log)).filter((entry) => entry.type === "provider_call");
  assert.equal(calls.length, 1);
  assert.ok(!calls.some((entry) => String(entry.transcript).includes("DECK_QUEUED_BEFORE_STOP")));
});

test("真实 Pi RPC：长工具调用后接收补充，同一次执行结束", async (t) => {
  const fixture = await createRun(t, "DECK_TOOL_CASE", { tools: ["deck_pause"] });
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await lines(fixture.log)).some((entry) => entry.type === "long_tool_start") ? true : undefined, "长工具开始");
  const turn = (await runtime.readRun(fixture.runId))!.turnId;
  await runtime.sendToRun(fixture.runId, "AT_TOOL_BOUNDARY");
  const completed = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.resourceState === "released" ? run : undefined;
  }, "工具边界收消息后完成");
  assert.equal(completed.turnId, turn);
  assert.equal(completed.finalText, "DECK_TOOL_DONE");
  const calls = (await lines(fixture.log)).filter((entry) => entry.type === "provider_call");
  assert.equal(calls.length, 2);
  assert.match(calls[1].transcript, /AT_TOOL_BOUNDARY/);
});

test("真实 Pi RPC：内置角色只排除 edit/write，Pi 默认的其他工具仍可用", async (t) => {
  let workerTools: string[] | undefined;
  for (const roleId of ["worker", "scout", "reviewer"] as const) {
    const file = path.join(process.cwd(), "agents", `${roleId}.md`);
    const role = parseAgentDefinition(await fs.readFile(file, "utf8"), file, "内置");
    const fixture = await createRun(t, "DECK_CAPABILITY_CASE", {
      tools: role.tools, disallowedTools: role.disallowedTools, extensions: role.extensions,
    });
    await runtime.launchRunner(fixture.runId);
    await until(async () => (await runtime.readRun(fixture.runId))?.resourceState === "released" ? true : undefined, `${roleId} 完成`);
    const active = (await lines(fixture.log)).find((entry) => entry.type === "active_tools").tools;
    assert.ok(active.includes("read"));
    assert.ok(active.includes("bash"));
    if (roleId === "worker") {
      workerTools = active;
      assert.ok(active.includes("edit"));
      assert.ok(active.includes("write"));
    } else {
      assert.ok(!active.includes("edit"));
      assert.ok(!active.includes("write"));
      for (const name of workerTools ?? []) {
        if (!["edit", "write"].includes(name)) assert.ok(active.includes(name), `${roleId} 不应额外排除 ${name}`);
      }
    }
    assert.ok(!active.includes("agent_report"));
    assert.ok(!active.includes("agent_question"));
  }
});

test("真实 Pi RPC：阻塞说明和空文本都按正常 Pi 结束标记 completed", async (t) => {
  const blockedFixture = await createRun(t, "DECK_BLOCK_CASE", { disallowedTools: ["edit", "write"] });
  await runtime.launchRunner(blockedFixture.runId);
  const blocked = await until(async () => {
    const run = await runtime.readRun(blockedFixture.runId);
    return run?.resourceState === "released" ? run : undefined;
  }, "阻塞说明返回");
  assert.equal(blocked.status, "已完成");
  assert.match(blocked.finalText ?? "", /我做不到/);
  assert.match(taskOutput(blocked), /主 Agent 需要处理范围决定/);
  assert.equal(blocked.legacy?.pendingQuestion, undefined);
  const active = (await lines(blockedFixture.log)).find((item) => item.type === "active_tools");
  assert.ok(!active.tools.includes("agent_question"));
  assert.ok(!active.tools.includes("agent_report"));

  const emptyFixture = await createRun(t, "DECK_EMPTY_CASE");
  await runtime.launchRunner(emptyFixture.runId);
  const empty = await until(async () => {
    const run = await runtime.readRun(emptyFixture.runId);
    return run?.resourceState === "released" ? run : undefined;
  }, "空文本返回");
  assert.equal(empty.status, "已完成");
  assert.equal(empty.finalText ?? "", "");
  assert.equal(empty.failureReason, undefined);
  const history = await readCompletions(runtime.runDirectory(emptyFixture.runId));
  assert.equal(history.at(-1)?.status, "已完成");
  assert.equal(history.at(-1)?.finalText ?? "", "");
});

test("真实 Pi RPC：结果保存失败仍释放进程并通知真实错误", async (t) => {
  const fixture = await createRun(t, "DECK_TOOL_CASE", { tools: ["deck_pause"] });
  await fs.writeFile(path.join(runtime.runDirectory(fixture.runId), "results"), "故障注入：阻止创建结果目录");
  const notices: any[] = [];
  const unsubscribe = runtime.subscribeRunEvents((event) => {
    if (event.kind === "result" && event.run.runId === fixture.runId) notices.push(event);
  });
  t.after(unsubscribe);
  await runtime.launchRunner(fixture.runId);
  const result = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.resourceState === "released" ? run : undefined;
  }, "故障后清理");
  assert.equal(result.childPid, undefined);
  assert.equal(result.status, "失败");
  assert.match(result.finalText ?? "", /DECK_TOOL_DONE/);
  assert.match(result.persistenceError ?? "", /保存失败/);
  assert.match(resultMessage(result, fixture.parentSessionId)!.content, /保存失败/);
  await until(async () => notices.length === 1 ? true : undefined, "结果通知");
});

test("真实 Pi RPC：会话丢失时 resume 明确报错，不创建空白替代", async (t) => {
  const fixture = await createRun(t, "DECK_BLOCK_CASE");
  await runtime.launchRunner(fixture.runId);
  await until(async () => (await runtime.readRun(fixture.runId))?.resourceState === "released" ? true : undefined, "完成");
  await fs.unlink(fixture.childSessionPath);
  await assert.rejects(runtime.resumeRun(fixture.runId, "继续"), /子会话不存在/);
});

test("真实 Pi 宿主：v1 等待决定记录只在明确 resume 时迁移并复用原 Session", async (t) => {
  const fixture = await createRun(t, "DECK_CONTINUE_CASE");
  await runtime.launchRunner(fixture.runId);
  const original = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.resourceState === "released" ? run : undefined;
  }, "v1 迁移准备轮完成");
  await runtime.shutdownRuns(fixture.parentSessionId);

  const legacy: any = structuredClone(original);
  legacy.version = 1;
  legacy.agentId = legacy.roleId;
  delete legacy.roleId;
  delete legacy.deliveryMode;
  delete legacy.legacy;
  legacy.status = "等待决定";
  legacy.pendingQuestion = { id: "legacy-question", turnId: legacy.turnId, question: "旧问题", options: ["继续"] };
  legacy.result = { outcome: "阻塞", summary: "旧结构结果" };
  legacy.toolEvidence = ["旧工具证据"];
  legacy.writePermission = false;
  legacy.tools = ["read", "agent_report", "agent_question"];
  const requestFile = path.join(runtime.runDirectory(fixture.runId), "request.json");
  const legacyRequest: any = JSON.parse(await fs.readFile(requestFile, "utf8"));
  legacyRequest.version = 1;
  legacyRequest.argsPrefix.push("--tools", "read,agent_report,agent_question");
  // This fixture now represents a genuinely old waiting task. Remove the
  // synthetic v3 preparation result for the same turn before writing v1 state.
  await fs.rm(path.join(runtime.runDirectory(fixture.runId), "results"), { recursive: true, force: true });
  await runtime.writeJsonAtomic(runtime.statusPath(fixture.runId), legacy);
  await runtime.writeJsonAtomic(requestFile, legacyRequest);
  const before = await fs.readFile(runtime.statusPath(fixture.runId), "utf8");
  const reconciled = await runtime.reconcileRun(fixture.runId);
  assert.equal(reconciled?.version, 1);
  assert.equal(reconciled?.legacy?.pendingQuestion?.question, "旧问题");
  assert.equal(await fs.readFile(runtime.statusPath(fixture.runId), "utf8"), before, "启动核对不能迁移 v1");

  const resumed = await runtime.resumeRun(fixture.runId, "DECK_CONTINUE_CASE LEGACY_RESUME");
  assert.equal(resumed.version, 3);
  assert.equal(resumed.childSessionId, original.childSessionId);
  const migrated = await until(async () => {
    const run = await runtime.readRun(fixture.runId);
    return run?.status === "已完成" && run.turnId === resumed.turnId ? run : undefined;
  }, "v1 明确续接完成");
  assert.equal(migrated.version, 3);
  assert.equal(migrated.childSessionPath, original.childSessionPath);
  assert.deepEqual(migrated.tools, ["read"]);
  assert.equal((migrated.legacy?.structuredResult as any)?.summary, "旧结构结果");
  assert.deepEqual(migrated.legacy?.toolEvidence, ["旧工具证据"]);
  const history = await readCompletions(runtime.runDirectory(fixture.runId));
  const waiting = history.find((item) => item.status === "等待决定");
  assert.ok(waiting, "resume 前的旧等待决定必须作为历史事实保留");
  assert.equal(waiting.legacy?.pendingQuestion?.id, "legacy-question");
  const rawMigrated = JSON.parse(await fs.readFile(runtime.statusPath(fixture.runId), "utf8"));
  for (const oldField of ["agentId", "pendingQuestion", "result", "toolEvidence", "writePermission"]) assert.equal(rawMigrated[oldField], undefined);
  assert.ok((await lines(fixture.log)).filter((entry) => entry.type === "provider_call").length >= 2);
});

test("真实 Pi RPC：模型失败和中断不会冒充完成，并自动释放资源", async (t) => {
  for (const [prompt, status] of [["DECK_FAILURE_CASE", "失败"], ["DECK_ABORTED_CASE", "已停止"]] as const) {
    const fixture = await createRun(t, prompt);
    await runtime.launchRunner(fixture.runId);
    const result = await until(async () => {
      const run = await runtime.readRun(fixture.runId);
      return run?.resourceState === "released" ? run : undefined;
    }, `${prompt} 结束`);
    assert.equal(result.status, status);
    if (status === "失败") {
      assert.match(taskOutput(result), /运行原因：/);
      assert.match(taskOutput(result), /尚未验证/);
    }
    assert.equal(result.childPid, undefined);
  }
});

test("只读会话查看折叠长工具参数和输出，展开后仍保留原文", async (t) => {
  const fixture = await createRun(t, "只读显示测试");
  const records = await fs.readFile(fixture.childSessionPath, "utf8");
  const tail = "UNIQUE_TOOL_TAIL";
  const assistant = {
    type: "message", id: "large-call", parentId: null, timestamp: new Date().toISOString(),
    message: {
      role: "assistant", timestamp: 1,
      content: [{ type: "toolCall", id: "large", name: "write", arguments: { path: "demo.ts", content: "x".repeat(1000) + tail } }],
      stopReason: "toolUse",
    },
  };
  await fs.appendFile(fixture.childSessionPath, JSON.stringify(assistant) + "\n");
  const run = (await runtime.readRun(fixture.runId))!;
  assert.match(conversationBlocks(run).map((block) => block.text).join(""), /已折叠/);
  assert.doesNotMatch(conversationBlocks(run).map((block) => block.text).join(""), new RegExp(tail));
  assert.match(conversationBlocks(run, true).map((block) => block.text).join(""), new RegExp(tail));
  assert.equal(await fs.readFile(fixture.childSessionPath, "utf8"), records + JSON.stringify(assistant) + "\n");
  assert.equal((await runtime.readRun(fixture.runId))?.childPid, undefined);
});
