import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { RpcConnection } from "../src/rpc-connection.ts";
import { DEFAULT_CONFIG, writeDeckConfig } from "../src/config.ts";

// Assert at the HTTP boundary: neither private tool details nor stored image
// blocks prove what the model actually received after Pi's image filtering.
test("真实父子 Pi：模型收到禁图提示，read 图片是否送达遵循 Pi 设置", async (t) => {
  const cwd = await fs.mkdtemp(path.join(getAgentDir(), "image-delivery-"));
  const settingsFile = path.join(getAgentDir(), "settings.json");
  const original = await fs.readFile(settingsFile, "utf8").catch(() => undefined);
  const imageFile = path.join(cwd, "sample.png");
  await fs.writeFile(imageFile, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
  await writeDeckConfig({ enabled: true, routing: { enabled: false } });
  let blocked = true, parentCalls = 0, childCalls = 0;
  const errors: unknown[] = [];
  const call = (id: string, name: string, args: object) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
  const respond = (res: http.ServerResponse, calls?: object[], content = "IMAGE_POLICY_DONE") => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta: object, finish_reason: string | null) => `data: ${JSON.stringify({ id: "local-image", object: "chat.completion.chunk", model: "scripted", choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    res.end(chunk(calls ? { role: "assistant", tool_calls: calls.map((entry, index) => ({ index, ...entry })) } : { role: "assistant", content }, null)
      + chunk({}, calls ? "tool_calls" : "stop") + "data: [DONE]\n\n");
  };
  const server = http.createServer(async (req, res) => {
    try {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (JSON.stringify(body.messages).includes("DECK_IMAGE_POLICY_PARENT")) {
        parentCalls++;
        const agent = body.tools.find((tool: any) => tool.function?.name === "Agent");
        assert.ok(agent, "父模型请求必须包含 Agent 工具");
        assert.equal(agent.function.description.includes("images.blockImages=true"), blocked);
        if (blocked) assert.ok(agent.function.description.includes(settingsFile));
        const output = body.messages.find((message: any) => message.role === "tool" && message.tool_call_id === "launch_reader");
        if (!output) return respond(res, [call("launch_reader", "Agent", {
          description: "读取图片验证传图", prompt: "DECK_IMAGE_POLICY_CHILD", subagent_type: "Explore",
        })]);
        assert.match(output.content, /agentId: A-/);
        assert.ok(output.content.includes(blocked ? "IMAGE_FILTERED" : "IMAGE_RECEIVED"));
        return respond(res);
      }
      childCalls++;
      const output = body.messages.find((message: any) => message.role === "tool" && message.tool_call_id === "read_sample");
      if (!output) return respond(res, [call("read_sample", "read", { path: imageFile })]);
      const messages = JSON.stringify(body.messages);
      assert.equal(messages.includes('"type":"image_url"'), !blocked, "读取成功后必须在真实模型请求中检查图像");
      assert.equal(messages.includes("Image reading is disabled."), blocked);
      return respond(res, undefined, blocked ? "IMAGE_FILTERED" : "IMAGE_RECEIVED");
    } catch (error) {
      errors.push(error);
      respond(res, undefined, "IMAGE_POLICY_FAILURE");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const provider = { name: "Local image fixture", baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: "local-fixture-only", api: "openai-completions",
    models: [{ id: "scripted", name: "Scripted", reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65536, maxTokens: 1024 }] };
  const extension = path.join(cwd, "local-provider.ts");
  await fs.writeFile(extension, `export default function(pi) { pi.registerProvider("image-policy-fixture", ${JSON.stringify(provider)}); }`);
  const piCli = path.join(path.dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "bundle", "cli.js");
  t.after(async () => {
    server.closeAllConnections(); server.close();
    if (original === undefined) await fs.rm(settingsFile, { force: true });
    else await fs.writeFile(settingsFile, original);
    await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
    await fs.rm(cwd, { recursive: true, force: true });
  });
  for (const value of [true, false]) {
    blocked = value; parentCalls = 0; childCalls = 0;
    await fs.writeFile(settingsFile, JSON.stringify({ images: { blockImages: blocked }, defaultProjectTrust: "never" }));
    const events: any[] = [], exits: Error[] = [];
    const rpc = new RpcConnection(process.execPath, [piCli, "--mode", "rpc", "--no-extensions", "--extension", extension,
      "--extension", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "--model", "image-policy-fixture/scripted", "--thinking", "off"],
      cwd, undefined, (event) => events.push(event), (error) => exits.push(error));
    try {
      await rpc.request("get_state", {}, 15000);
      await rpc.request("prompt", { message: "DECK_IMAGE_POLICY_PARENT" });
      const deadline = Date.now() + 20000;
      while (!events.some((event) => event.type === "agent_settled")) {
        if (exits.length) throw exits[0];
        if (Date.now() > deadline) throw new Error("图片传递检查超时");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.deepEqual(errors, []);
      assert.equal(parentCalls, 2);
      assert.equal(childCalls, 2);
      assert.ok(events.some((event) => event.type === "message_end"
        && Array.isArray(event.message?.content)
        && event.message.content.some((block: any) => block.text === "IMAGE_POLICY_DONE")));
      t.diagnostic(`blockImages=${blocked}: parentRequests=${parentCalls}, childRequests=${childCalls}, imageDelivered=${!blocked}`);
    } finally { await rpc.close(); }
  }
});
