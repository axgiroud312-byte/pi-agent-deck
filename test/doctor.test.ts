import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import childRuntime from "../src/child-runtime.ts";
import { AGENT_DECK_VERSION, CHILD_RUNTIME_PROTOCOL_VERSION } from "../src/version.ts";

const packageJson = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

test("package 版本与运行时代码版本一致", () => {
  assert.equal(packageJson.version, AGENT_DECK_VERSION);
});

test("child runtime 写入带版本和 token 的确认文件", async (t) => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-ack-"));
  const ackPath = path.join(directory, "runtime-ack.json");
  const previousPath = process.env.PI_AGENT_DECK_RUNTIME_ACK_PATH;
  const previousToken = process.env.PI_AGENT_DECK_RUNTIME_ACK_TOKEN;
  process.env.PI_AGENT_DECK_RUNTIME_ACK_PATH = ackPath;
  process.env.PI_AGENT_DECK_RUNTIME_ACK_TOKEN = "test-token";
  t.after(() => {
    if (previousPath === undefined) delete process.env.PI_AGENT_DECK_RUNTIME_ACK_PATH;
    else process.env.PI_AGENT_DECK_RUNTIME_ACK_PATH = previousPath;
    if (previousToken === undefined) delete process.env.PI_AGENT_DECK_RUNTIME_ACK_TOKEN;
    else process.env.PI_AGENT_DECK_RUNTIME_ACK_TOKEN = previousToken;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let registered = false;
  childRuntime({ registerTool: () => { registered = true; } } as any);
  assert.equal(registered, true);
  const ack = JSON.parse(await fs.promises.readFile(ackPath, "utf8"));
  assert.equal(ack.token, "test-token");
  assert.equal(ack.extensionVersion, AGENT_DECK_VERSION);
  assert.equal(ack.protocolVersion, CHILD_RUNTIME_PROTOCOL_VERSION);
});
