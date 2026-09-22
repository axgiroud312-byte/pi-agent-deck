import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgents, validateAgentDefinition } from "../src/agents.ts";
import { buildDelegationInstruction } from "../src/instruction.ts";

test("发现三个内置 Agent，且权限配置有效", () => {
  const agents = discoverAgents(process.cwd());
  for (const id of ["scout", "worker", "reviewer"]) {
    const agent = agents.find((item) => item.id === id);
    assert.ok(agent, `缺少 ${id}`);
    assert.deepEqual(validateAgentDefinition(agent), []);
  }
  assert.equal(agents.find((item) => item.id === "worker")?.writePermission, true);
  assert.equal(agents.find((item) => item.id === "scout")?.writePermission, false);
});

test("委派指令包含可追溯信息和协议要求", () => {
  const agent = discoverAgents(process.cwd()).find((item) => item.id === "scout");
  assert.ok(agent);
  const instruction = buildDelegationInstruction("A-test", agent, {
    agent: "scout",
    objective: "调查认证流程",
    planContext: "认证稳定性计划中的调查阶段",
    batchId: "B-auth-1",
    phase: "第一批只读调查",
    background: ["用户报告偶发 401"],
    dependencies: ["现有登录接口"],
    inputs: ["错误日志显示 refresh 失败"],
    filesToRead: ["src/auth/index.ts"],
    scope: ["认证入口"],
    allowedPaths: ["src/auth/**"],
    forbiddenPaths: ["src/billing/**"],
    exclusions: ["不实现修复"],
    constraints: ["不修改文件"],
    implementationRequirements: ["提供调用链"],
    validationPolicy: ["只读验证"],
    acceptanceCriteria: ["提供调用链和行号证据"],
    expectedDeliverables: ["调查报告"],
  }, "parent-test");
  assert.match(instruction, /A-test/);
  assert.match(instruction, /parent-test/);
  assert.match(instruction, /调查认证流程/);
  assert.match(instruction, /提供调用链和行号证据/);
  assert.match(instruction, /B-auth-1/);
  assert.match(instruction, /开始前必须阅读/);
  assert.match(instruction, /允许修改的路径/);
  assert.match(instruction, /明确不做/);
  assert.match(instruction, /逐项对应上述完成标准/);
  assert.match(instruction, /agent_report/);
  assert.match(instruction, /简体中文/);
});

test("未信任项目不会加载项目级 Agent", async (t) => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-trust-"));
  const agentsDir = path.join(cwd, ".pi", "agents");
  await fs.promises.mkdir(agentsDir, { recursive: true });
  await fs.promises.writeFile(path.join(agentsDir, "project-only.md"), [
    "---",
    "id: project-only",
    "name: 项目专用 Agent",
    "writePermission: false",
    "tools: read",
    "---",
    "只读调查。",
  ].join("\n"), "utf8");
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  assert.equal(discoverAgents(cwd).some((agent) => agent.id === "project-only"), false);
  assert.equal(discoverAgents(cwd, { projectTrusted: true }).some((agent) => agent.id === "project-only"), true);
});

test("只读 Agent 配置写入工具时会被拒绝", () => {
  const base = discoverAgents(process.cwd()).find((item) => item.id === "scout");
  assert.ok(base);
  const errors = validateAgentDefinition({ ...base, tools: ["read", "bash"] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bash/);
});
