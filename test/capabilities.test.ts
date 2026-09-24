import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgents } from "../src/agents.ts";
import { roleCapabilities, roleCapabilityCatalog } from "../src/capabilities.ts";
import { parseMessageInput } from "../src/tool-contract.ts";

test("角色目录反映实际能力，旧问题工具不再启用", () => {
  const agents = discoverAgents(process.cwd(), { projectTrusted: false });
  const worker = agents.find((agent) => agent.id === "worker")!;
  const scout = agents.find((agent) => agent.id === "scout")!;
  assert.ok(roleCapabilities(worker).canExecute);
  assert.ok(!roleCapabilities(scout).canExecute);
  assert.deepEqual(roleCapabilities(scout).tools, ["read", "grep", "find", "ls", "agent_report"]);
  assert.match(roleCapabilityCatalog([scout]), /不能运行命令\/测试/);
  assert.match(roleCapabilityCatalog([{ ...scout, tools: ["unknown_tool"] }]), /不可用.*unknown_tool/);
  assert.ok(!roleCapabilities(scout).tools.includes("agent_question"));
});

test("只传消息；旧 delivery 与 reply_to 返回明确迁移提示", () => {
  assert.equal(parseMessageInput({ to: "a", message: "资料" }).message, "资料");
  for (const extra of [{ delivery: "QueueOnly" }, { delivery: "TriggerTurn" }, { reply_to: "q" }]) {
    assert.throws(() => parseMessageInput({ to: "a", message: "资料", ...extra }), /resume/);
  }
});
