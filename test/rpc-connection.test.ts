import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RpcConnection } from "../src/rpc-connection.ts";

async function createFixture(source: string): Promise<{ directory: string; script: string }> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-rpc-connection-"));
  const script = path.join(directory, "child.mjs");
  await fs.promises.writeFile(script, source, "utf8");
  return { directory, script };
}

test("薄 RPC 连接关联响应并转发事件", async (t) => {
  const fixture = await createFixture(`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: { echoed: request.value } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "progress", value: request.value }) + "\\n");
});
lines.on("close", () => process.exit(0));
`);
  const events: any[] = [];
  const exits: Error[] = [];
  const connection = new RpcConnection(process.execPath, [fixture.script], fixture.directory, undefined, (event) => events.push(event), (error) => exits.push(error));
  t.after(async () => {
    await connection.close();
    await fs.promises.rm(fixture.directory, { recursive: true, force: true });
  });
  assert.deepEqual(await connection.request("echo", { value: "hello" }), { echoed: "hello" });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(events, [{ type: "progress", value: "hello" }]);
  assert.deepEqual(exits, []);
});

test("子进程快速退出时保留 stderr 并拒绝尚未完成的请求", async (t) => {
  const fixture = await createFixture(`
process.stdin.once("data", () => {
  process.stderr.write("fixture failed immediately");
  process.exit(7);
});
`);
  const exits: Error[] = [];
  const connection = new RpcConnection(process.execPath, [fixture.script], fixture.directory, undefined, () => {}, (error) => exits.push(error));
  t.after(() => fs.promises.rm(fixture.directory, { recursive: true, force: true }));
  await assert.rejects(connection.request("never-answered"), /子 Pi 已退出/);
  await connection.closed;
  assert.match(connection.stderr, /fixture failed immediately/);
  assert.equal(exits.length, 1);
  assert.match(exits[0].message, /fixture failed immediately/);
});

test("close 会结束仍在等待输入的实际子进程", async (t) => {
  const fixture = await createFixture(`
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} }) + "\\n");
});
lines.on("close", () => process.exit(0));
`);
  const connection = new RpcConnection(process.execPath, [fixture.script], fixture.directory, undefined, () => {}, () => {});
  t.after(() => fs.promises.rm(fixture.directory, { recursive: true, force: true }));
  const pid = connection.child.pid;
  assert.deepEqual(await connection.request("ready"), {});
  await connection.close();
  assert.ok(pid);
  assert.throws(() => process.kill(pid!, 0));
});
