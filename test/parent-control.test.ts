import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcConnection } from "../src/rpc-connection.ts";
import { readRun } from "../src/runtime.ts";
import { DEFAULT_CONFIG, writeDeckConfig } from "../src/config.ts";

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`等待 ${label} 超时`);
}

// HTTP sees only the actual model request after Pi's conversion. It cannot read
// tool-result details to obtain an ID; the deterministic responses exercise Pi's
// parent tool loop and real child processes without an online model or account.
test("真实父 Pi 从正文控制两个无名称后台任务，补充和停止准确寻址", async (t) => {
  const cwd = await fs.mkdtemp(path.join(getAgentDir(), "parent-control-"));
  await writeDeckConfig({ enabled: true, routing: { enabled: false } });
  const ids: string[] = [];
  const errors: unknown[] = [];
  const parentRequests: any[] = [];
  let childrenStarted = 0;
  let step = 0;
  const toolCall = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const respond = (res: http.ServerResponse, calls?: object[], content = "PARENT_CONTROL_DONE") => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "local-response", object: "chat.completion.chunk", model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk(calls ? { role: "assistant", tool_calls: calls.map((call, index) => ({ index, ...call })) } : { role: "assistant", content }, null)
      + chunk({}, calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (!JSON.stringify(body.messages).includes("DECK_PARENT_CONTROL_CASE")) {
        childrenStarted++;
        // Keep each child streaming until the parent explicitly stops it.
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.flushHeaders();
        return;
      }
      parentRequests.push(body);
      const outputs = body.messages.filter((message: any) => message.role === "tool");
      const receipt = (callId: string): string => {
        const output = outputs.find((message: any) => message.tool_call_id === callId);
        assert.ok(output, `缺少 ${callId} 的模型可见回执`);
        assert.equal(typeof output.content, "string");
        return output.content;
      };
      switch (step++) {
        case 0:
          return respond(res, [0, 1].map((index) => toolCall(`launch_${index}`, "Agent", {
            description: `受控后台任务 ${index}`, prompt: `LOCAL_CHILD_WAIT_${index}`, run_in_background: true,
          })));
        case 1:
          for (const index of [0, 1]) {
            const id = receipt(`launch_${index}`).match(/^agentId: (A-[A-Za-z0-9_-]+)$/m)?.[1];
            assert.ok(id, "父模型必须从正文而非 details 取得 ID");
            ids.push(id);
          }
          assert.notEqual(ids[0], ids[1]);
          await until(async () => childrenStarted === 2 ? true : undefined, "两个真实子模型开始请求");
          return respond(res, [toolCall("steer_first", "SendMessage", { to: ids[0], message: "补充只给第一个任务" })]);
        case 2:
          assert.ok(receipt("steer_first").includes(`agentId: ${ids[0]}`));
          assert.match(receipt("steer_first"), /queued/);
          return respond(res, [toolCall("stop_second", "TaskStop", { task_id: ids[1] })]);
        case 3: {
          assert.ok(receipt("stop_second").includes(`agentId: ${ids[1]}`));
          assert.match(receipt("stop_second"), /已停止/);
          const first = await readRun(ids[0]);
          const second = await readRun(ids[1]);
          assert.equal(first?.status, "运行中", "停止第二个任务不能停止第一个任务");
          assert.equal(second?.status, "已停止");
          assert.equal(second?.resourceState, "released");
          return respond(res, [toolCall("stop_first", "TaskStop", { task_id: ids[0] })]);
        }
        case 4:
          assert.ok(receipt("stop_first").includes(`agentId: ${ids[0]}`));
          assert.match(receipt("stop_first"), /已停止/);
          return respond(res);
        default:
          throw new Error("父模型出现意外的额外轮次");
      }
    } catch (error) {
      errors.push(error);
      respond(res, undefined, "PARENT_CONTROL_FAILURE");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const config = { name: "Local control fixture", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-fixture-only", api: "openai-completions",
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }] };
  const extension = path.join(cwd, "local-provider.ts");
  await fs.writeFile(extension, `export default function(pi) { pi.registerProvider("parent-control-fixture", ${JSON.stringify(config)}); }`);
  const piCli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
  const events: any[] = [];
  const exits: Error[] = [];
  const rpc = new RpcConnection(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", extension,
    "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--model", "parent-control-fixture/scripted", "--thinking", "off"],
    cwd, undefined, (event) => events.push(event), (error) => exits.push(error));
  t.after(async () => {
    try { await rpc.close(); }
    finally { server.closeAllConnections(); server.close(); await writeDeckConfig(structuredClone(DEFAULT_CONFIG)); }
  });
  await rpc.request("get_state", {}, 15000);
  await rpc.request("prompt", { message: "DECK_PARENT_CONTROL_CASE" });
  await until(async () => {
    if (exits.length) throw exits[0];
    return events.some((event) => event.type === "agent_settled") ? true : undefined;
  }, "父 Pi 完成调度");
  assert.deepEqual(errors, []);
  assert.equal(parentRequests.length, 5);
  assert.ok(events.some((event) => event.type === "message_end" && Array.isArray(event.message?.content)
    && event.message.content.some((block: any) => block.text === "PARENT_CONTROL_DONE")));
  for (const id of ids) {
    const run = await readRun(id);
    assert.equal(run?.status, "已停止");
    assert.equal(run?.resourceState, "released");
    assert.equal(run?.childPid, undefined);
  }
  t.diagnostic(`real-parent control: tasks=${ids.length}, parentRequests=${parentRequests.length}, childRequests=${childrenStarted}, detailsAccess=0`);
});
