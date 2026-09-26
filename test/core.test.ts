import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgents, parseAgentDefinition, validateAgentDefinition } from "../src/agents.ts";
import { buildChildSystemPrompt } from "../src/instruction.ts";
import { agentToolDescription } from "../src/index.ts";

test("发现三个内置 Agent，worker 使用 Pi 默认工具，调查与审查只排除 edit/write", () => {
  const agents = discoverAgents(process.cwd());
  for (const id of ["scout", "worker", "reviewer"]) {
    const agent = agents.find((item) => item.id === id);
    assert.ok(agent, `缺少 ${id}`);
    assert.deepEqual(validateAgentDefinition(agent), []);
  }
  assert.equal(agents.find((item) => item.id === "worker")?.tools, undefined);
  assert.deepEqual(agents.find((item) => item.id === "scout")?.disallowedTools, ["edit", "write"]);
  assert.deepEqual(agents.find((item) => item.id === "reviewer")?.disallowedTools, ["edit", "write"]);
});

test("子 Agent 提示词依赖角色行为约束，阻塞时直接返回普通最终文本", () => {
  const agents = discoverAgents(process.cwd());
  const scout = buildChildSystemPrompt(agents.find((agent) => agent.id === "scout")!);
  const worker = buildChildSystemPrompt(agents.find((agent) => agent.id === "worker")!);
  assert.match(scout, /不(?:要)?修改、创建或删除任何文件/);
  assert.match(worker, /谨慎的实现工程师/);
  assert.match(scout, /最终文本中说明阻塞原因/);
  assert.doesNotMatch(scout, /agent_report/);
  assert.doesNotMatch(scout, /agent_question|等待答复/);
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

test("工具范围只由 tools 与 disallowedTools 表达，不推断角色身份", () => {
  const base = discoverAgents(process.cwd()).find((item) => item.id === "scout");
  assert.ok(base);
  assert.deepEqual(validateAgentDefinition({ ...base, tools: ["read", "bash"] }), []);
  assert.deepEqual(validateAgentDefinition({ ...base, tools: ["read", "edit"], disallowedTools: [] }), []);
  const description = agentToolDescription([
    { ...base, id: "default-tools", tools: undefined },
    { ...base, id: "no-tools", tools: [] },
  ]);
  assert.match(description, /default-tools.*tools=Pi 默认工具/);
  assert.match(description, /no-tools.*tools=无/);
});

test("角色扩展路径相对角色文件解析去重，自定义工具保留大小写，内置别名规范化", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "deck-role-extension-"));
  const extension = path.join(directory, "fixture-extension.ts");
  const roleFile = path.join(directory, "role.md");
  await fs.promises.writeFile(extension, "export default function fixture() {}\n");
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const role = parseAgentDefinition(`---\nid: mixed-tool\nname: 混合工具\ntools: [BASH, Glob, RoleProbe]\ndisallowedTools: [HiddenProbe]\nextensions: [./fixture-extension.ts, ./fixture-extension.ts]\nwritePermission: false\n---\n检查。\n`, roleFile, "用户");
  assert.deepEqual(role.tools, ["bash", "find", "RoleProbe"]);
  assert.deepEqual(role.disallowedTools, ["HiddenProbe", "edit", "write"]);
  assert.deepEqual(role.extensions, [fs.realpathSync(extension)]);
  assert.deepEqual(validateAgentDefinition(role), []);
  const invalid = parseAgentDefinition(`---\nname: 无效扩展\ntools: RoleProbe\nextensions: ./missing.ts\n---\n检查。\n`, roleFile, "用户");
  assert.deepEqual(validateAgentDefinition(invalid), []);
  assert.equal(invalid.extensions[0], path.resolve(directory, "missing.ts"));
});

test("旧角色的字符串 false 仍迁移为 edit/write 排除项", () => {
  for (const value of ["false", "no", "0", "否"]) {
    const role = parseAgentDefinition(`---\nid: legacy-readonly\nname: 旧只读角色\nwritePermission: ${value}\n---\n只读检查。\n`, "legacy-readonly.md", "用户");
    assert.deepEqual(role.disallowedTools, ["edit", "write"]);
    assert.deepEqual(validateAgentDefinition(role), []);
  }
});
