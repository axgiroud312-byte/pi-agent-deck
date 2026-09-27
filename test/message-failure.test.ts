import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeRun, launchRunner, readRun, runDirectory, sendToRun, shutdownRuns, waitForRunTurn } from "../src/runtime.ts";
import { readMessages } from "../src/message-store.ts";

async function waitForFile(file: string): Promise<void> {
  // This observes an explicit child-process barrier; elapsed time never releases it.
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await fs.access(file).then(() => true, () => false)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`子进程未到达屏障：${file}`);
}

test("启动前补充入队后保存失败，恢复执行时不派发已关闭的消息", { timeout: 10000 }, async t => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-message-failure-"));
  const runId = `message-failure-${randomUUID()}`;
  t.after(async () => {
    t.mock.restoreAll();
    try { await shutdownRuns(runId); }
    finally { await fs.rm(cwd, { recursive: true, force: true }); }
  });
  const session = path.join(cwd, "session.jsonl");
  await fs.writeFile(session, JSON.stringify({ type: "session", id: runId, version: 3 }) + "\n");
  const script = path.join(cwd, "rpc.mjs");
  await fs.writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs';
const out = value => process.stdout.write(JSON.stringify(value) + '\\n');
let firstState = true;
readline.createInterface({input: process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.type === 'get_state') {
    const respond = () => out({type: 'response', id: request.id, success: true, data: {isStreaming: false}});
    if (!firstState) return respond();
    firstState = false;
    fs.writeFileSync('ready', '1');
    const barrier = setInterval(() => {
      if (fs.existsSync('release')) { clearInterval(barrier); respond(); }
    }, 5);
    return;
  }
  out({type: 'response', id: request.id, success: true, data: request.type === 'clear_queue' ? {steering: [], followUp: []} : {}});
  if (request.type === 'prompt') {
    fs.appendFileSync('prompts.jsonl', JSON.stringify(request.message) + '\\n');
    const input = {role: 'user', content: [{type: 'text', text: request.message}], timestamp: Date.now()};
    fs.appendFileSync('session.jsonl', JSON.stringify({type: 'message', message: input}) + '\\n');
    out({type: 'message_end', message: input});
    out({type: 'message_end', message: {role: 'assistant', content: [{type: 'text', text: 'DONE'}], stopReason: 'stop'}});
    out({type: 'agent_settled'});
  }
});`);
  await initializeRun({
    version: 3, runId, roleId: "worker", agentName: "工作", agentSource: "内置", objective: "initial", instruction: "initial",
    status: "运行中", model: "fake/model", thinking: "off", tools: [], extensions: [], parentSessionId: runId,
    childSessionId: runId, childSessionPath: session, cwd, startedAt: Date.now(), events: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }, { version: 3, cwd, command: process.execPath, argsPrefix: [script], prompt: "INITIAL" }, true);
  await launchRunner(runId);
  await waitForFile(path.join(cwd, "ready"));
  const turnId = (await readRun(runId))!.turnId!;

  // The child is blocked before readiness, so this is precisely the save after
  // SendMessage appends to entry.messages. Other files and later saves still work.
  const status = path.join(runDirectory(runId), "status.json");
  const rename = fs.rename;
  let injected = false;
  const failingRename = t.mock.method(fs, "rename", async (from: Parameters<typeof fs.rename>[0], to: Parameters<typeof fs.rename>[1]) => {
    if (!injected && path.resolve(String(to)) === status) {
      injected = true;
      throw Object.assign(new Error("INJECTED_MESSAGE_STATUS_SAVE_FAILURE"), { code: "EIO" });
    }
    return rename(from, to);
  });
  await assert.rejects(sendToRun(runId, "SHOULD_NOT_RUN", undefined, undefined, "failed-supplement"), /INJECTED_MESSAGE_STATUS_SAVE_FAILURE/);
  failingRename.mock.restore();
  assert.equal(injected, true);
  const failed = (await readMessages(runId)).find(record => record.id === "failed-supplement")!;
  assert.equal(failed.state, "closed");
  assert.equal(failed.submittedAt, undefined);
  assert.match(failed.reason!, /INJECTED_MESSAGE_STATUS_SAVE_FAILURE/);

  await fs.writeFile(path.join(cwd, "release"), "1");
  const completed = await waitForRunTurn(runId, turnId, { signal: t.signal, pollMs: 10 });
  assert.equal(completed.status, "已完成", completed.failureReason);
  assert.equal(completed.resourceState, "released");
  const prompts = (await fs.readFile(path.join(cwd, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(prompts, ["INITIAL"], "报错后已关闭的补充不能在恢复启动时被偷偷执行");
  assert.equal((await readMessages(runId)).find(record => record.id === "failed-supplement")?.state, "closed");
});
