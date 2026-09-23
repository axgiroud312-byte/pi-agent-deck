import assert from "node:assert/strict";
import test from "node:test";
import { discoverAgents } from "../src/agents.ts";
import { roleCapabilities, roleCapabilityCatalog } from "../src/capabilities.ts";
import { parseMessageInput } from "../src/tool-contract.ts";

test("主 Agent 的角色目录显示实际命令、写入、提问能力及不可用原因", () => {
  const agents = discoverAgents(process.cwd(), { projectTrusted: false });
  const worker = agents.find((agent) => agent.id === "worker")!;
  const scout = agents.find((agent) => agent.id === "scout")!;
  assert.ok(roleCapabilities(worker).canExecute);
  assert.ok(!roleCapabilities(scout).canExecute);
  assert.deepEqual(roleCapabilities(scout).tools, ["read", "grep", "find", "ls", "agent_question"]);
  assert.match(roleCapabilityCatalog([scout]), /不能运行命令\/测试/);
  assert.match(roleCapabilityCatalog([{ ...scout, tools: ["unknown_tool"] }]), /不可用.*unknown_tool/);
  assert.ok(!roleCapabilities({ ...scout, disallowedTools: ["agent_question"] }).canAsk);
});

test("两种 delivery 严格解析；与 reply_to 冲突、未知值在操作任务前拒绝", () => {
  assert.equal(parseMessageInput({ to: "a", message: "资料", delivery: "QueueOnly" }).delivery, "QueueOnly");
  assert.equal(parseMessageInput({ to: "a", message: "继续", delivery: "TriggerTurn" }).delivery, "TriggerTurn");
  assert.throws(() => parseMessageInput({ to: "a", message: "答复", delivery: "QueueOnly", reply_to: "q" }), /不能/);
  assert.throws(() => parseMessageInput({ to: "a", message: "答复", delivery: "TriggerTurn", reply_to: "q" }), /不能/);
  assert.throws(() => parseMessageInput({ to: "a", message: "资料", delivery: "queue" }), /delivery/);
});
