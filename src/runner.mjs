import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { atomicJson, withDiskLock, persistCompletion, releaseCapacity, releaseWriter } from "./persistence.mjs";
import { selectExecution, decisionText, applyExecutionArgs } from "./router.mjs";

const args = process.argv.slice(2);
const marker = args.indexOf("--run-dir");
if (marker < 0 || !args[marker + 1]) throw new Error("缺少 --run-dir");
const runDir = path.resolve(args[marker + 1]);
const requestPath = path.join(runDir, "request.json");
const statusPath = path.join(runDir, "status.json");
const eventsPath = path.join(runDir, "events.jsonl");
const stderrPath = path.join(runDir, "stderr.log");
const MAX_STDERR = 128 * 1024;
const MAX_EVENTS = 200;

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const request = readJson(requestPath);
let status = readJson(statusPath);
let writeChain = Promise.resolve();
const routingAbort = new AbortController();
const cancelled = () => routingAbort.signal.aborted || fs.existsSync(path.join(runDir, "stop-requested")) || readJson(statusPath).stopRequested;

function atomicWrite(value) {
  status = { ...value, updatedAt: Date.now() };
  const snapshot = JSON.stringify(status, null, 2);
  writeChain = writeChain.then(async () => {
    const temporary = `${statusPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, `${snapshot}\n`, "utf8");
      for (let attempt = 0; ; attempt++) {
        try { await fs.promises.rename(temporary, statusPath); break; }
        catch (error) {
          if (attempt >= 5 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 40 * (attempt + 1)));
        }
      }
    } finally { await fs.promises.rm(temporary, { force: true }).catch(() => {}); }
  }).catch((error) => {
    fs.appendFileSync(stderrPath, `\n状态保存失败：${error.message}\n`, "utf8");
    throw error;
  });
  // The final await still receives the failure; event handlers must not cause unhandled rejections.
  void writeChain.catch(() => {});
  return writeChain;
}

function appendEvent(kind, text, data = undefined) {
  const event = { at: Date.now(), kind, text, data };
  status.events = [...(status.events ?? []), { at: event.at, kind: kind === "文本" ? "状态" : kind, text }].slice(-MAX_EVENTS);
  fs.appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function appendInbox(statusValue, at) {
  if (!request.inboxPath) return;
  fs.mkdirSync(path.dirname(request.inboxPath), { recursive: true });
  const inboxEvent = {
    version: 1,
    eventId: `${status.runId}:${at}:${statusValue}`,
    runId: status.runId,
    parentSessionId: status.parentSessionId,
    status: statusValue,
    agentName: status.agentName,
    objective: status.objective,
    at,
  };
  fs.appendFileSync(request.inboxPath, `${JSON.stringify(inboxEvent)}\n`, "utf8");
}

async function releaseWriterLease() {
  if (request.writerLease) await releaseWriter(request.writerLease);
}

function getText(message) {
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n");
}

function shorten(text, max = 1000) {
  const value = String(text ?? "");
  return value.length > max ? `${value.slice(0, max)}\n…（已截断）` : value;
}

function toolAction(name, data = {}) {
  const labels = { read: "读取文件", grep: "搜索内容", find: "查找文件", ls: "列出目录", bash: "执行命令", powershell: "执行 PowerShell", edit: "编辑文件", write: "写入文件", agent_report: "提交报告" };
  const label = labels[name] ?? name;
  if (["read", "write", "edit"].includes(name)) return `${label} ${data.path ?? data.file_path ?? ""}`.trim();
  if (["grep", "find"].includes(name)) return `${label} ${data.pattern ?? ""} ${data.path ?? ""}`.trim();
  if (["bash", "powershell"].includes(name)) return `${label}：${shorten(data.command, 100).replace(/\s+/g, " ")}`;
  if (name === "agent_report") return `${label}：${data.title ?? data.type ?? ""}`;
  return label;
}

function addUsage(source) {
  if (!source) return;
  const target = status.usage;
  target.input += source.input ?? 0;
  target.output += source.output ?? 0;
  target.cacheRead += source.cacheRead ?? 0;
  target.cacheWrite += source.cacheWrite ?? 0;
  target.totalTokens += source.totalTokens ?? 0;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"]) target.cost[key] += source.cost?.[key] ?? 0;
}

// Cancellation is durable even if it happens before this process records its PID.
if (cancelled() || ["已取消", "已停止", "停止中", "停止未确认", "已完成", "失败"].includes(status.status)) process.exit(0);
if (request.routingDecision) status = { ...status, model: request.routingDecision.model, thinking: request.routingDecision.thinking, routing: request.routingDecision, routingPending: false };
await atomicWrite({ ...status, runnerPid: process.pid, status: request.routing && !request.routingDecision && !request.routing.immediate ? "选配中" : "运行中", currentAction: request.routing && !request.routingDecision ? "正在确定模型与思考强度" : "正在启动子 Agent" });
appendEvent("状态", "Runner 已启动");

let child;
let stderr = "";
let buffer = "";
let assistantError = false;
let terminalReport = false;
let blockingReport = false;
let closing = false;
let naturalFinal = false;
let executionTimer;
let timedOut = false;
const decoder = new StringDecoder("utf8");

function processEvent(event) {
  if (event.type === "tool_execution_start") {
    status.currentAction = toolAction(event.toolName, event.args);
    appendEvent("工具", status.currentAction, { toolName: event.toolName, args: event.args });
    void atomicWrite(status);
    return;
  }
  if (event.type === "tool_execution_end") {
    if (["agent_report", "agent_question"].includes(event.toolName) && !event.isError && event.result?.details) {
      const report = event.result.details;
      status.reports = [...(status.reports ?? []), report];
      status.currentAction = `${report.type}：${report.title}`;
      appendEvent("报告", status.currentAction, report);
      if (report.type === "最终") terminalReport = true;
      if (report.type === "问题" && report.blocking) blockingReport = true;
    } else {
      appendEvent("工具", `${toolAction(event.toolName)} · ${event.isError ? "失败" : "完成"}`, { toolName: event.toolName, isError: event.isError });
    }
    void atomicWrite(status);
    return;
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    addUsage(event.message.usage);
    const text = getText(event.message);
    naturalFinal = Boolean(text.trim()) && event.message.stopReason === "stop";
    if (text) {
      status.finalText = text;
      appendEvent("文本", shorten(text, 8000));
    }
    if (event.message.stopReason === "error") {
      assistantError = true;
      appendEvent("错误", event.message.errorMessage ?? "模型返回错误");
    }
    void atomicWrite(status);
  }
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    routingAbort.abort();
    try { child?.kill("SIGTERM"); } catch {}
    const stopped = { ...status, status: "已停止", endedAt: Date.now(), currentAction: undefined, stopRequested: true };
    await persistCompletion(runDir, stopped);
    await atomicWrite(stopped);
    process.exit(0);
  });
}

try {
  const decision = request.routing && !request.routingDecision
    ? await selectExecution(request.routing, { signal: routingAbort.signal }) : undefined;
  let childClosed;
  // Serialize only the launch commit with cancellation, never the remote judgment.
  await withDiskLock(path.join(runDir, "spawn.lock"), async () => {
    if (closing || cancelled()) throw new Error("任务已取消");
    if (decision) {
      request.argsPrefix = applyExecutionArgs(request.argsPrefix, decision);
      request.routingDecision = decision;
      delete request.routing;
      await atomicJson(requestPath, request);
      appendEvent("状态", decisionText(decision));
      await atomicWrite({ ...status, model: decision.model, thinking: decision.thinking, routing: decision, routingPending: false, status: "运行中", currentAction: "模型已确定，正在启动子 Agent" });
    }
    const childArgs = [...request.argsPrefix, "--", request.prompt];
    child = spawn(request.command, childArgs, { cwd: request.cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(request.env ?? {}) } });
    childClosed = new Promise((resolve) => {
      child.once("close", (code) => resolve(code ?? 1));
      child.once("error", (error) => {
        stderr = `${stderr}\n${error.message}`.trim().slice(-MAX_STDERR);
        resolve(1);
      });
    });
    await atomicWrite({ ...status, childPid: child.pid, currentAction: "子 Agent 正在思考" });
  });
  if (request.timeoutMs > 0) executionTimer = setTimeout(() => {
    timedOut = true;
    appendEvent("错误", "任务执行超时，正在停止；可用原 task_id 继续。");
    if (process.platform === "win32" && child.pid) {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.on("error", () => child.kill("SIGTERM"));
    } else child.kill("SIGTERM");
  }, request.timeoutMs);
  child.stdout.on("data", (chunk) => {
    buffer += decoder.write(chunk);
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { processEvent(JSON.parse(line)); } catch { /* 忽略非 JSON 行 */ }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-MAX_STDERR);
    fs.writeFileSync(stderrPath, stderr, "utf8");
  });
  const exitCode = await childClosed;
  buffer += decoder.end();
  if (buffer.trim()) {
    try { processEvent(JSON.parse(buffer)); } catch { /* 忽略 */ }
  }
  closing = true;
  const latest = (() => { try { return readJson(statusPath); } catch { return status; } })();
  const stopRequested = latest.stopRequested === true;
  let finalStatus;
  if (stopRequested) finalStatus = "已停止";
  else if (blockingReport) finalStatus = "等待决定";
   else if (exitCode !== 0 || assistantError || timedOut) finalStatus = "失败";
    else if (!terminalReport && !(request.naturalOutput && naturalFinal)) {
    finalStatus = "失败";
    appendEvent("错误", "子 Agent 未按协议提交最终报告");
  } else finalStatus = "已完成";
  const endedAt = Date.now();
  const completed = { ...status, status: finalStatus, exitCode, stderr: stderr || undefined, endedAt, currentAction: undefined };
  await persistCompletion(runDir, completed);
  await atomicWrite(completed);
  appendEvent("状态", `Runner 结束：${finalStatus}`);
  await atomicWrite(status);
  await releaseWriterLease();
  appendInbox(finalStatus, endedAt);
} catch (error) {
  closing = true;
  const stopped = cancelled();
  appendEvent(stopped ? "状态" : "错误", stopped ? "任务已取消，未启动后续执行" : error instanceof Error ? error.message : String(error));
  const endedAt = Date.now();
  const failed = { ...status, status: stopped ? "已停止" : "失败", ...(stopped ? { stopRequested: true } : {}), endedAt, currentAction: undefined, stderr: stderr || undefined };
  await persistCompletion(runDir, failed);
  await atomicWrite(failed);
  appendInbox(failed.status, endedAt);
} finally {
  clearTimeout(executionTimer);
  await writeChain;
  await releaseWriterLease();
  await releaseCapacity(request.capacityLease);
}
