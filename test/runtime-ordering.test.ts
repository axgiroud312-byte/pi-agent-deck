import { resumeFixtureRun } from "./fixtures/resume-fixture.ts";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { initializeRun, launchRunner, readRun, sendToRun, shutdownRuns } from "../src/runtime.ts";

test("同会话续跑时连续补充消息按提交顺序送达", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-review-order-"));
  const id = "review-" + randomUUID();
  t.after(async () => { await shutdownRuns(id); await fs.rm(cwd, { recursive: true, force: true }); });
  const script = path.join(cwd, "rpc.mjs");
  await fs.writeFile(script, String.raw`import readline from "node:readline";
import fs from "node:fs";
const out=x=>process.stdout.write(JSON.stringify(x)+"\n");
let busy=false,queue=[];
function start(message){busy=true;fs.appendFileSync("orders.jsonl",JSON.stringify(message)+"\n");out({type:"agent_start"});
setTimeout(()=>{out({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:message}]}});if(queue.length)start(queue.shift());else{busy=false;out({type:"agent_settled"});}},10);}
readline.createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line);
if(q.type==="get_state")return out({type:"response",id:q.id,success:true,data:{isStreaming:busy}});
out({type:"response",id:q.id,success:true,data:{}});
if(q.type==="prompt"||q.type==="steer"){if(busy)queue.push(q.message);else start(q.message);}
});`);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await initializeRun({ version: 1, runId: id, agentId: "test", agentName: "review", agentSource: "内置",
    objective: "initial", instruction: "initial", acceptanceCriteria: [], status: "运行中", model: "fake/model", thinking: "off",
    tools: [], writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: path.join(cwd, "session.jsonl"),
    cwd, startedAt: Date.now(), reports: [], events: [], usage } as any,
  { version: 1, cwd, command: process.execPath, argsPrefix: [script, "--model", "fake/model", "--thinking", "off"], prompt: "INITIAL", naturalOutput: true }, true);
  await launchRunner(id);
  const wait = async (turn?: string) => {
    for(let i=0;i<500;i++){const r=await readRun(id);if(r?.status==="已完成" && (!turn || r.turnId!==turn))return r;
      await new Promise(resolve=>setTimeout(resolve,10));}
    throw new Error("timeout");
  };
  let previous = await wait();
  for (let i=0;i<5;i++) {
    await resumeFixtureRun(id, `FIRST-${i}`);
    await sendToRun(id, `SECOND-${i}`);
    previous = await wait(previous.turnId);
  }
  const orders=(await fs.readFile(path.join(cwd,"orders.jsonl"),"utf8")).trim().split(/\r?\n/).map((line)=>JSON.parse(line) as string);
  assert.equal(orders[0],"INITIAL");
  const transcript=orders.join("\n");
  for(let i=0;i<5;i++){
    const first=`FIRST-${i}`, second=`SECOND-${i}`;
    assert.equal(transcript.split(first).length-1,1);
    assert.equal(transcript.split(second).length-1,1);
    assert.ok(transcript.indexOf(first)<transcript.indexOf(second), `第 ${i+1} 次续跑先处理了后提交的消息`);
  }
});

test("结束边界上的补充只暂存，明确 resume 后再执行", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-review-settle-"));
  const id = "review-" + randomUUID();
  t.after(async () => { await shutdownRuns(id); await fs.rm(cwd, { recursive: true, force: true }); });
  const script = path.join(cwd, "rpc.mjs");
  await fs.writeFile(script, String.raw`import readline from "node:readline";
import fs from "node:fs";
const out=x=>process.stdout.write(JSON.stringify(x)+"\n");
let busy=false,settled=false,promptCount=0;
function start(message){
  busy=true;out({type:"agent_start"});
  setTimeout(()=>{out({type:"message_end",message:{role:"assistant",stopReason:"stop",content:[{type:"text",text:message}]}});
    busy=false;settled=true;out({type:"agent_settled"});},20);
}
readline.createInterface({input:process.stdin}).on("line",line=>{const q=JSON.parse(line);
if(q.type==="get_state"){
  const state={isStreaming:busy};
  if(settled){fs.writeFileSync("state-in-flight","1");setTimeout(()=>out({type:"response",id:q.id,success:true,data:state}),100);}
  else out({type:"response",id:q.id,success:true,data:state});
  return;
}
out({type:"response",id:q.id,success:true,data:{}});
if(q.type==="prompt"){
  promptCount++;
  if(promptCount===1)start(q.message);
  else setTimeout(()=>start(q.message),150);
}
});`);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await initializeRun({ version: 1, runId: id, agentId: "test", agentName: "review", agentSource: "内置",
    objective: "initial", instruction: "initial", acceptanceCriteria: [], status: "运行中", model: "fake/model", thinking: "off",
    tools: [], writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: path.join(cwd, "session.jsonl"),
    cwd, startedAt: Date.now(), reports: [], events: [], usage } as any,
  { version: 1, cwd, command: process.execPath, argsPrefix: [script, "--model", "fake/model", "--thinking", "off"], prompt: "INITIAL", naturalOutput: true }, true);
  await launchRunner(id);
  let inFlight = false;
  for(let i=0;i<500;i++){
    try { await fs.access(path.join(cwd,"state-in-flight")); inFlight = true; break; } catch { /* wait */ }
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(inFlight, "应先观察到旧 agent_settled 正在核对空闲状态");
  const sent=await sendToRun(id,"FOLLOWUP");
  assert.equal(sent.delivery,"deferred", "完成边界之后只暂存，不自动启动");
  await resumeFixtureRun(id, "EXPLICIT_RESUME");
  let result;
  for(let i=0;i<500;i++){
    const run=await readRun(id);
    if(run?.status==="已完成" && run.finalText?.includes("FOLLOWUP")){result=run;break;}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.match(result?.finalText ?? "", /FOLLOWUP/, "补充随明确 resume 送入新执行");
});

test("执行超时进入停止流程后拒绝补充消息", async (t) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "deck-review-stop-"));
  const id = "review-" + randomUUID();
  t.after(async () => { await shutdownRuns(id); await fs.rm(cwd, { recursive: true, force: true }); });
  const script = path.join(cwd, "rpc.mjs");
  await fs.writeFile(script, String.raw`import fs from "node:fs";
import readline from "node:readline";
const out=x=>process.stdout.write(JSON.stringify(x)+"\n");
readline.createInterface({input:process.stdin}).on("line",line=>{
 const q=JSON.parse(line);
 if(q.type==="get_state")return out({type:"response",id:q.id,success:true,data:{isStreaming:true}});
 if(q.type==="clear_queue"){fs.writeFileSync("stopping","1");setTimeout(()=>out({type:"response",id:q.id,success:true,data:{}}),250);return;}
 if(q.type==="prompt"){fs.appendFileSync("prompts.jsonl",JSON.stringify(q.message)+"\n");out({type:"response",id:q.id,success:true,data:{}});return;}
 out({type:"response",id:q.id,success:true,data:{}});
});`);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await initializeRun({ version: 1, runId: id, agentId: "test", agentName: "review", agentSource: "内置",
    objective: "hang", instruction: "hang", acceptanceCriteria: [], status: "运行中", model: "fake/model", thinking: "off",
    tools: [], writePermission: false, parentSessionId: id, childSessionId: id, childSessionPath: path.join(cwd, "session.jsonl"),
    cwd, startedAt: Date.now(), reports: [], events: [], usage } as any,
  { version: 1, cwd, command: process.execPath, argsPrefix: [script, "--model", "fake/model", "--thinking", "off"],
    prompt: "INITIAL", naturalOutput: true, timeoutMs: 100 }, true);
  await launchRunner(id);
  let stopping = false;
  for(let i=0;i<500;i++){
    try { await fs.access(path.join(cwd,"stopping")); stopping = true; break; } catch { /* wait */ }
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.ok(stopping, "应先观察到超时停止已进入 clear_queue");
  await assert.rejects(sendToRun(id,"AFTER_TIMEOUT"), /停止|中止|不可|结束/);
  const prompts=(await fs.readFile(path.join(cwd,"prompts.jsonl"),"utf8")).trim().split(/\r?\n/).map((line)=>JSON.parse(line));
  assert.deepEqual(prompts,["INITIAL"], "停止开始后不能向子进程提交新 prompt");
  let failed;
  for(let i=0;i<500;i++){
    const run=await readRun(id);
    if(run?.status==="失败"){failed=run;break;}
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(failed?.status,"失败");
});
