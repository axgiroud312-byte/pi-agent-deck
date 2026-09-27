import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcConnection } from "../src/rpc-connection.ts";
import { DEFAULT_CONFIG, writeDeckConfig } from "../src/config.ts";

// Real parent and child Pi loops against a local HTTP model. Assertions inspect
// the model-visible requests, including notifications after the parent settles.
test("真实父子 Pi：澄清后交付、消息续接与历史原文覆盖前后台两种派发", async (t) => {
  const cwd = await fs.mkdtemp(path.join(getAgentDir(), "parent-messaging-"));
  await writeDeckConfig({ enabled: true, routing: { enabled: false } });
  const errors: unknown[] = [];
  let background = false, originalReport = "", childCalls = 0, resumed = false;
  const finalReport = "CHILD_COMPLETE:已按主 Agent 回答完成并验证 artifact.json";
  const call = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const respond = (res: http.ServerResponse, calls?: object[], content = "WAITING") => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "communication", object: "chat.completion.chunk", model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk(calls ? { role: "assistant", tool_calls: calls.map((item, index) => ({ index, ...item })) } : { role: "assistant", content }, null)
      + chunk({}, calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw), transcript = JSON.stringify(body.messages);
      const result = (id: string) => body.messages.find((m: any) => m.role === "tool" && m.tool_call_id === id);
      if (transcript.includes("DECK_COMMUNICATION_PARENT")) {
        if (!result("launch")) return respond(res, [call("launch", "Agent", {
          description: "澄清并写入验证文件", prompt: "DECK_COMMUNICATION_CHILD", run_in_background: background,
        })]);
        const question = transcript.match(/reply_to=([a-zA-Z0-9-]+)/)?.[1];
        const task = transcript.match(/agentId: (A-[a-zA-Z0-9-]+)/)?.[1];
        assert.ok(task, "派发返回可用于通信的任务编号");
        if (!question) return respond(res);
        if (!result("answer")) return respond(res, [call("answer", "SendMessage", { to: task, reply_to: question, message: "JSON，内容为 {\"ok\":true}" })]);
        const report = body.messages.find((m: any) => JSON.stringify(m.content).includes(finalReport));
        if (!report) return respond(res);
        if (!originalReport) originalReport = JSON.stringify(report.content);
        assert.equal(JSON.stringify(report.content), originalReport, "续接后模型仍看到相同的历史报告原文");
        assert.ok(!transcript.includes("不据此启动或续接任务"));
        if (!result("resume")) return respond(res, [call("resume", "SendMessage", { to: task, message: "DECK_COMMUNICATION_CONTINUE：复核上一轮的格式决定和文件" })]);
        if (!transcript.includes("CHILD_CONTINUED")) return respond(res);
        assert.ok(resumed);
        return respond(res, undefined, "PARENT_COMMUNICATION_DONE");
      }
      childCalls++;
      const names = body.tools.map((tool: any) => tool.function.name);
      assert.ok(names.includes("SendMessage"));
      assert.ok(!names.includes("Agent"));
      if (transcript.includes("DECK_COMMUNICATION_CONTINUE")) {
        assert.ok(transcript.includes("主 Agent 回答"));
        assert.ok(transcript.includes(finalReport));
        assert.ok(result("write_artifact"));
        resumed = true;
        return respond(res, undefined, "CHILD_CONTINUED:原会话中的回答与交付记录完整");
      }
      if (!result("question")) return respond(res, [call("question", "SendMessage", { to: "main", message: "输出格式与内容是什么？", wait_for_reply: true })]);
      assert.match(JSON.stringify(result("question").content), /主 Agent 回答/);
      assert.match(JSON.stringify(result("question").content), /JSON/);
      if (!result("write_artifact")) return respond(res, [call("write_artifact", "write", { path: path.join(cwd, "artifact.json"), content: '{"ok":true}\n' })]);
      return respond(res, undefined, finalReport);
    } catch (error) { errors.push(error); respond(res, undefined, "COMMUNICATION_TEST_FAILURE"); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const provider = { name: "Communication fixture", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-only", api: "openai-completions",
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }] };
  const extension = path.join(cwd, "provider.ts");
  await fs.writeFile(extension, `export default function(pi) { pi.registerProvider("communication-fixture", ${JSON.stringify(provider)}); }`);
  const piCli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
  t.after(async () => {
    server.closeAllConnections(); server.close();
    await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
    await fs.rm(cwd, { recursive: true, force: true });
  });
  for (const mode of [false, true]) {
    background = mode; originalReport = ""; childCalls = 0; resumed = false;
    const events: any[] = [], exits: Error[] = [];
    const rpc = new RpcConnection(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", extension,
      "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--model", "communication-fixture/scripted", "--thinking", "off"],
      cwd, undefined, event => events.push(event), error => exits.push(error));
    try {
      await rpc.request("get_state", {}, 15000);
      await rpc.request("prompt", { message: "DECK_COMMUNICATION_PARENT" });
      const deadline = Date.now() + 20000;
      while (!events.some(event => event.type === "message_end" && event.message?.role === "assistant"
        && event.message.content.some((block: any) => block.text === "PARENT_COMMUNICATION_DONE"))) {
        assert.deepEqual(errors, []);
        if (exits.length) throw exits[0];
        if (Date.now() > deadline) throw new Error(`问答闭环超时；background=${background}, childCalls=${childCalls}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(cwd, "artifact.json"), "utf8")), { ok: true });
      assert.equal(childCalls, 4);
      assert.ok(originalReport.includes(finalReport));
      t.diagnostic(`background=${background}: question answered, artifact verified, original context resumed, report unchanged`);
    } finally { await rpc.close(); }
  }
});
