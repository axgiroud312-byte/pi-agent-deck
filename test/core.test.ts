import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgents, validateAgentDefinition } from "../src/agents.ts";
import { buildChildSystemPrompt } from "../src/instruction.ts";

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

test("实际子 Agent 提示词按权限执行、阻塞交回主 Agent、最终提交证据", () => {
  const agents = discoverAgents(process.cwd());
  const scout = buildChildSystemPrompt(agents.find((agent) => agent.id === "scout")!);
  const worker = buildChildSystemPrompt(agents.find((agent) => agent.id === "worker")!);
  assert.match(scout, /只读调查/);
  assert.match(worker, /任务范围内修改/);
  assert.match(scout, /阻塞原因、已完成部分和证据/);
  assert.match(scout, /agent_report/);
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

test("只读 Agent 配置写入工具时会被拒绝", () => {
  const base = discoverAgents(process.cwd()).find((item) => item.id === "scout");
  assert.ok(base);
  const errors = validateAgentDefinition({ ...base, tools: ["read", "bash"] });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /bash/);
});
