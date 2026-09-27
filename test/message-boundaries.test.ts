import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { initializeRun, launchRunner, readRun, sendToRun, shutdownRuns, stopRun } from "../src/runtime.ts";
import { messagesPath, readMessages, recordMessage, submitMessages } from "../src/message-store.ts";

async function until<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`等待超时：${label}`);
}

async function fixture(t: any, settleAfter = 2, beforeLaunch?: (runId: string) => Promise<void>) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-message-boundary-"));
  const runId = `boundary-${randomUUID()}`;
  t.after(async () => { await shutdownRuns(runId); await fs.rm(cwd, { recursive: true, force: true }); });
  const session = path.join(cwd, "session.jsonl");
  await fs.writeFile(session, JSON.stringify({ type: "session", id: runId, version: 3 }) + "\n");
  const script = path.join(cwd, "rpc.mjs");
  await fs.writeFile(script, `import readline from 'node:readline'; import fs from 'node:fs';
const out = x => process.stdout.write(JSON.stringify(x)+'\\n');
let queue=[], prompts=0;
const input = text => {const message={role:'user',content:[{type:'text',text}]}; fs.appendFileSync('session.jsonl',JSON.stringify({type:'message',message})+'\\n');out({type:'message_end',message});};
readline.createInterface({input:process.stdin}).on('line', line => {
 const q=JSON.parse(line);
 fs.appendFileSync('requests.jsonl',JSON.stringify(q.type)+'\\n');
 if(q.type==='get_state') return out({type:'response',id:q.id,success:true,data:{isStreaming:false}});
 if(q.type==='clear_queue') { const pending=queue;queue=[];return out({type:'response',id:q.id,success:true,data:{steering:pending,followUp:[]}}); }
 out({type:'response',id:q.id,success:true,data:{}});
 if(q.type==='steer') {queue.push(q.message); if(queue.length===${settleAfter})out({type:'agent_settled'});}
 if(q.type==='prompt') {prompts++;input(q.message);fs.appendFileSync('prompts.jsonl',JSON.stringify(q.message)+'\\n');
   out({type:'message_end',message:{role:'assistant',stopReason:'stop',content:[{type:'text',text:prompts===1?'INITIAL_RESULT':'SUPPLEMENTS_DONE'}]}});
   if(prompts===1)fs.writeFileSync('ready','1');else out({type:'agent_settled'});
 }
});`);
  await initializeRun({ version: 3, runId, roleId: "worker", agentName: "工作", agentSource: "内置", objective: "initial", instruction: "initial", status: "运行中", model: "fake/model", thinking: "off", tools: [], extensions: [], parentSessionId: runId, childSessionId: runId, childSessionPath: session, cwd, startedAt: Date.now(), events: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
    { version: 3, cwd, command: process.execPath, argsPrefix: [script], prompt: "INITIAL" }, true);
  if (beforeLaunch) await beforeLaunch(runId);
  await launchRunner(runId);
  if (!beforeLaunch) await until(async () => fs.access(path.join(cwd, "ready")).then(() => true, () => undefined), "收尾前");
  return { cwd, runId };
}

test("已被 RPC 接受但尚未消费的两条消息，在收尾时按序继续同一轮", async t => {
  const { cwd, runId } = await fixture(t);
  const firstTurn = (await readRun(runId))!.turnId;
  const first = await sendToRun(runId, "FIRST_SUPPLEMENT", undefined, undefined, "first-call");
  assert.equal((await readMessages(runId)).find(x => x.id === first.messageId)?.state, "pending");
  await sendToRun(runId, "SECOND_SUPPLEMENT", undefined, undefined, "second-call");
  const result = await until(async () => { const run = await readRun(runId); return run?.resourceState === "released" ? run : undefined; }, "完整收尾");
  assert.equal(result.status, "已完成", result.failureReason);
  assert.equal(result.turnId, firstTurn, "边界补充继续原轮次，前台等待者也能收到最终结果");
  assert.match(result.finalText!, /INITIAL_RESULT[\s\S]*SUPPLEMENTS_DONE/);
  const prompts = (await fs.readFile(path.join(cwd, "prompts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1].indexOf("FIRST_SUPPLEMENT") < prompts[1].indexOf("SECOND_SUPPLEMENT"));
  assert.ok((await readMessages(runId)).every(x => x.state === "consumed"));
  const again = await sendToRun(runId, "FIRST_SUPPLEMENT", undefined, undefined, "first-call");
  assert.equal(again.delivery, "existing");
  assert.equal(again.messageState, "consumed");
  assert.equal((await readRun(runId))!.turnId, firstTurn, "同一调用重试不再续接已执行任务");
});

test("明确停止关闭未消费消息，并保留取消原因", async t => {
  const { cwd, runId } = await fixture(t, 99);
  const sent = await sendToRun(runId, "PENDING_AT_STOP");
  const stopped = await stopRun(runId);
  assert.equal(stopped.status, "已停止");
  const record = (await readMessages(runId)).find(x => x.id === sent.messageId)!;
  assert.equal(record.state, "closed");
  assert.match(record.reason!, /停止/);
  assert.equal((await fs.readFile(path.join(cwd, "prompts.jsonl"), "utf8")).trim().split("\n").length, 1);
});

test("启动提交记录阻塞时停止，解除阻塞后也不会发出旧 prompt", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let lock!: Promise<void>;
  const { cwd, runId } = await fixture(t, 99, async id => {
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    lock = withFileMutationQueue(messagesPath(id), async () => { entered(); await gate; });
    await ready;
  });
  try {
    await until(async () => {
      const text = await fs.readFile(path.join(cwd, "requests.jsonl"), "utf8").catch(() => "");
      return text.includes("set_steering_mode") ? true : undefined;
    }, "启动已到提交边界");
    const stopping = stopRun(runId);
    await until(async () => (await readRun(runId))?.stopRequested ? true : undefined, "停止意图已生效");
    release();
    await lock;
    const stopped = await stopping;
    assert.equal(stopped.resourceState, "released");
    const requests = (await fs.readFile(path.join(cwd, "requests.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.ok(!requests.includes("prompt"), "停止期间不启动模型请求");
  } finally { release(); await lock; }
});

test("消息记录损坏时仍能停止子进程，保存失败原因且保留损坏原件", async t => {
  const { runId } = await fixture(t, 99);
  await sendToRun(runId, "PENDING_AT_FAILURE");
  await fs.writeFile(messagesPath(runId), "{broken");
  const stopped = await stopRun(runId);
  assert.equal(stopped.resourceState, "released");
  assert.equal(stopped.childPid, undefined);
  assert.match(stopped.persistenceError!, /消息/);
  assert.equal(await fs.readFile(messagesPath(runId), "utf8"), "{broken");
});

test("子进程在队列消费前退出，缺少证据的消息留为待核实", async t => {
  const { runId } = await fixture(t, 99);
  const sent = await sendToRun(runId, "PENDING_AT_CRASH");
  process.kill((await readRun(runId))!.childPid!);
  const failed = await until(async () => { const run = await readRun(runId); return run?.resourceState === "released" ? run : undefined; }, "异常退出收口");
  assert.equal(failed.status, "失败");
  const record = (await readMessages(runId)).find(item => item.id === sent.messageId)!;
  assert.equal(record.state, "unknown");
  assert.match(record.reason!, /消费证据/);
});

test("重载后明确续接只带入确定未提交的输入，未知消息保留供核对", async t => {
  const { cwd, runId } = await fixture(t, 1);
  await sendToRun(runId, "COMPLETE_FIRST");
  const done = await until(async () => { const run = await readRun(runId); return run?.resourceState === "released" ? run : undefined; }, "首轮完成");
  const unsent = await recordMessage(done, "to-child", "NEVER_SUBMITTED");
  const ambiguous = await recordMessage(done, "to-child", "UNCERTAIN_INPUT");
  await submitMessages(runId, [ambiguous.id]);
  await shutdownRuns(runId);
  await sendToRun(runId, "NEW_INSTRUCTION");
  await until(async () => {
    const text = await fs.readFile(path.join(cwd, "prompts.jsonl"), "utf8");
    return text.includes("NEW_INSTRUCTION") ? text : undefined;
  }, "新轮派发");
  const records = await readMessages(runId);
  const lastPrompt = JSON.parse((await fs.readFile(path.join(cwd, "prompts.jsonl"), "utf8")).trim().split("\n").at(-1)!);
  assert.ok(lastPrompt.indexOf("NEVER_SUBMITTED") < lastPrompt.indexOf("NEW_INSTRUCTION"));
  assert.doesNotMatch(lastPrompt, /UNCERTAIN_INPUT/);
  assert.equal(records.find(record => record.id === ambiguous.id)?.state, "unknown");
  await until(async () => (await readMessages(runId)).find(record => record.id === unsent.id)?.state === "consumed" ? true : undefined, "续接输入消费");
});
