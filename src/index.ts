import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type Theme,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { listWriterLeases } from "./admission.ts";
import { discoverAgentCandidates, discoverAgents, validateAgentDefinition } from "./agents.ts";
import { buildChildSystemPrompt } from "./instruction.ts";
import {
  sendToRun,
  startFollowUp,
  reconcileRun,
  inboxPath,
  initializeRun,
  isTerminalStatus,
  launchRunner,
  listRuns,
  readRun,
  reconcileRuns,
  runDirectory,
  stopRun,
  type RunnerRequest,
} from "./runtime.ts";
import { showAgentPanel, type AgentPanelAction } from "./ui.ts";
import { RESULT_MESSAGE, resultMessage, statusLabel } from "./delivery.ts";
import { readDeckConfig, writeDeckConfig } from "./config.ts";
import { registerConfiguration } from "./configuration-ui.ts";
import { agentAuthoringContext, createAgentFromDescription } from "./agent-creation.ts";
import { renderFleet } from "./presentation.ts";
import { prepareRouting } from "./routing.ts";
import { prepareChildProviders, saveChildProviders } from "./child-providers.ts";
import { registerRouting } from "./routing-ui.ts";
import { persistCompletion, readCompletions } from "./persistence.mjs";
import { AgentParameters, SendMessageParameters, TaskStopParameters, parseAgentInput, parseMessageInput, parseStopInput, resolveAgentRole, resolveModelOverride, requireAvailableModel, taskToolResult, runTitle, runRoleLabel } from "./tool-contract.ts";
import { resolveTaskTarget, withTaskCreation } from "./task-identity.ts";
import { AGENT_DECK_VERSION, buildFingerprint, CHILD_RUNTIME_PROTOCOL_VERSION, LOADED_BUILD_FINGERPRINT, packageVersionFromDisk, RUNNER_PROTOCOL_VERSION, RUN_SCHEMA_VERSION } from "./version.ts";
import type {
  AgentDefinition,
  DelegationRequest,
  RunDetails,
  RunIndexEvent,
  RunStatus,
} from "./types.ts";

const DEFAULT_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];
const DEFAULT_WRITE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const CHILD_SUPPORTED_TOOLS = new Set([...DEFAULT_READ_ONLY_TOOLS, ...DEFAULT_WRITE_TOOLS, "agent_report", "agent_question"]);
const MAX_EVENTS = 200;
const DECK_STATUS_KEY = "agent-deck";

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function shortTask(text: string, max = 54): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) return { command: process.execPath, args };
  return { command: "pi", args };
}

function childRuntimePath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "child-runtime.ts");
}

async function appendIndex(event: RunIndexEvent): Promise<void> {
  const indexPath = path.join(getAgentDir(), "agent-deck", "runs.jsonl");
  await withFileMutationQueue(indexPath, async () => {
    await fs.promises.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.promises.appendFile(indexPath, `${JSON.stringify(event)}\n`, "utf8");
  });
}

function pushEvent(details: RunDetails, kind: RunDetails["events"][number]["kind"], text: string): void {
  details.events.push({ at: Date.now(), kind, text });
  if (details.events.length > MAX_EVENTS) details.events.splice(0, details.events.length - MAX_EVENTS);
}

export default function agentDeck(pi: ExtensionAPI) {
  let deckEnabled = readDeckConfig().enabled;

  const applyDeckState = (ctx: any): void => {
    const active = pi.getActiveTools().filter((name) => !["Agent", "SendMessage", "TaskStop", "agent_task", "agent_cancel", "delegate_agent", "wait_for_agents", "get_agent_results"].includes(name));
    pi.setActiveTools([...new Set([...active, "TaskStop", ...(deckEnabled ? ["Agent", "SendMessage"] : [])])]);
    ctx.ui.setStatus(
      DECK_STATUS_KEY,
      deckEnabled
        ? ctx.ui.theme.fg("success", `多 Agent ${AGENT_DECK_VERSION}：开启`)
        : ctx.ui.theme.fg("dim", `多 Agent ${AGENT_DECK_VERSION}：关闭`),
    );
  };

  const setDeckEnabled = async (enabled: boolean, ctx: any): Promise<void> => {
    deckEnabled = enabled;
    await writeDeckConfig({ enabled });
    applyDeckState(ctx);
    ctx.ui.notify(
      enabled
        ? "多 Agent 工具已开启，主 Agent 现在可以派遣独立子 Agent。"
        : "多 Agent 已关闭：创建和补充工具已停用，TaskStop 和管理命令仍可使用。",
      "info",
    );
  };

  const openConfiguration = registerConfiguration(pi, (ctx) => { deckEnabled = readDeckConfig().enabled; applyDeckState(ctx); });
  registerRouting(pi);

  let fleetTimer: NodeJS.Timeout | undefined;
  const knownStatuses = new Map<string, RunStatus>();
  const pendingDeliveries = new Set<string>();
  let refreshing = false;
  let generation = 0;

  const refreshFleet = async (ctx: any): Promise<void> => {
    if (refreshing) return;
    refreshing = true;
    const epoch = generation;
    const parent = ctx.sessionManager.getSessionId();
    try {
    const configured = readDeckConfig().enabled;
    if (configured !== deckEnabled) { deckEnabled = configured; applyDeckState(ctx); }
    const runs = (await listRuns(Number.MAX_SAFE_INTEGER, parent)).sort((a, b) => a.startedAt - b.startedAt);
    for (let i = 0; i < runs.length; i++) {
      if (epoch !== generation || ctx.sessionManager.getSessionId() !== parent) return;
      const reconciled = await reconcileRun(runs[i].runId);
      if (reconciled) runs[i] = reconciled;
      if (deckEnabled && runs[i].status === "排队中") {
        await launchRunner(runs[i].runId);
        runs[i] = (await readRun(runs[i].runId))!;
      }
    }
    if (epoch !== generation || ctx.sessionManager.getSessionId() !== parent) return;
    const received = new Set<string>(ctx.sessionManager.getBranch()
      .filter((entry: any) => entry.type === "custom_message" && entry.customType === RESULT_MESSAGE)
      .map((entry: any) => entry.details?.deliveryId).filter(Boolean));
    for (const id of received) pendingDeliveries.delete(id);
    // Aborting a parent turn may clear Pi's in-memory queue without reloading the extension.
    if (ctx.isIdle?.() && ctx.hasPendingMessages?.() === false) pendingDeliveries.clear();
    for (const run of runs) {
      await persistCompletion(runDirectory(run.runId), run);
      for (const result of await readCompletions(runDirectory(run.runId))) {
        if (epoch !== generation || ctx.sessionManager.getSessionId() !== parent) return;
        const message = resultMessage({ ...result, agentId: result.agentId ?? run.agentId, instanceName: result.instanceName ?? run.instanceName, description: result.description ?? run.description }, parent, received, pendingDeliveries);
        if (!message) continue;
        pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
        pendingDeliveries.add(message.details.deliveryId);
      }
    }
    for (const run of runs) {
      if (epoch !== generation || ctx.sessionManager.getSessionId() !== parent) return;
      if (!deckEnabled || !run.autoDeliver || (!isTerminalStatus(run.status) && run.status !== "等待决定")) continue;
      try { await startFollowUp(run.runId); }
      catch (error) { ctx.ui.setStatus("agent-follow-up", `补充任务待重试：${error instanceof Error ? error.message : error}`); }
    }
    const visible = runs.filter((run) => !isTerminalStatus(run.status) || run.status === "等待决定");
    if (visible.length === 0) {
      ctx.ui.setWidget("agent-deck-fleet", undefined);
    } else {
      ctx.ui.setWidget("agent-deck-fleet", (tui: TUI, theme: Theme) => ({
        render: (width: number) => renderFleet(visible, width, tui.terminal?.rows ?? 24, theme),
        invalidate() {},
      }));
    }
    for (const run of runs) {
      const previous = knownStatuses.get(run.runId);
      knownStatuses.set(run.runId, run.status);
      if (!previous || previous === run.status) continue;
      if (run.status === "等待决定") ctx.ui.notify(`${run.agentName} 正在等待决定：${run.reports.at(-1)?.title ?? run.objective}`, "warning");
      else if (run.status === "已完成") ctx.ui.notify(`${run.agentName} 已返回结果：${run.reports.at(-1)?.title ?? run.objective}`, "info");
      else if (run.status === "已停止") ctx.ui.notify(`${run.agentName} 已停止：${run.runId}`, "info");
      else if (run.status === "停止未确认" || run.status === "失败" || run.status === "失联") ctx.ui.notify(`${run.agentName} ${run.status}：${run.runId}`, "error");
    }
    } catch (error) {
      ctx.ui.setStatus("agent-deck-error", `Agent 状态更新失败：${error instanceof Error ? error.message : error}`);
    } finally { refreshing = false; }
  };

  pi.on("session_start", async (_event, ctx) => {
    deckEnabled = readDeckConfig().enabled;
    generation++;
    pendingDeliveries.clear();
    knownStatuses.clear();
    applyDeckState(ctx);
    if (fleetTimer) clearInterval(fleetTimer);
    await reconcileRuns();
    await refreshFleet(ctx);
    fleetTimer = setInterval(() => void refreshFleet(ctx), 1000);
  });

  pi.on("session_shutdown", () => {
    generation++;
    if (fleetTimer) clearInterval(fleetTimer);
    fleetTimer = undefined;
  });

  pi.on("before_agent_start", async (_event, ctx) => ({
    message: {
      customType: "agent-roles", display: false,
      content: [agentAuthoringContext(), deckEnabled ? `可用 Agent 角色（subagent_type）：${discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() }).map((agent) => `${agent.id}${agent.id === "worker" ? " / general-purpose" : agent.id === "scout" ? " / Explore" : ""}：${agent.description}`).join("；")}。Agent 只创建新任务；SendMessage 用返回的 agentId 或实例 name 继续；TaskStop 停止任务。` : "派遣已关闭，仍可停止任务、创建和编辑角色；开启派遣使用 /agent-deck 开启。"].join("\n"),
    },
  }));

  pi.registerMessageRenderer("agent-created", (message, _options, theme) =>
    new Text(`${theme.fg("success", "✓ ")}${typeof message.content === "string" ? message.content : "Agent 已创建"}`, 0, 0));

  pi.registerMessageRenderer(RESULT_MESSAGE, (message, _options, theme) => {
    const details = message.details as { title?: string; status?: string; summary?: string } | undefined;
    return new Text(`${theme.fg("accent", details?.title ?? "Agent 结果")} · ${details?.status ?? ""}\n${details?.summary ?? ""}`, 0, 0);
  });

  pi.registerTool({
    name: "TaskStop", label: "停止 Agent", description: "用任务 ID 或实例名称停止当前会话的任务，并取消其排队消息。已经结束的任务保留原状态。",
    parameters: TaskStopParameters,
    async execute(_id, raw, _signal, _update, ctx) {
      const params = parseStopInput(raw);
      const run = await resolveTaskTarget(params.task_id, ctx.sessionManager.getSessionId());
      const stopped = await stopRun(run.runId);
      return taskToolResult(stopped, stopped.status === "停止未确认" ? "停止未确认；仍需核对进程状态。" : isTerminalStatus(run.status) ? `任务已经结束，保留原状态：${stopped.status}；排队消息已清除。` : `任务${stopped.status}；排队消息已清除。`, undefined, stopped.status !== "停止未确认");
    },
  });

  pi.registerTool({
    name: "SendMessage", label: "补充 Agent 任务", description: "向当前会话的任务 ID 或实例名称发送完整补充要求。运行、排队或选配中的任务会排队收信，当前执行结束后处理；已结束或等待答复的任务在原会话恢复，沿用原模型与强度。",
    parameters: SendMessageParameters,
    async execute(_id, raw, _signal, _update, ctx) {
      if (!deckEnabled) throw new Error("Agent 已关闭，请在 /agent-deck 开启后重试。");
      const params = parseMessageInput(raw);
      const run = await resolveTaskTarget(params.to, ctx.sessionManager.getSessionId());
      await reconcileRun(run.runId);
      const sent = await sendToRun(run.runId, params.message, params.summary);
      const message = sent.delivery === "queued" ? "消息已排队，将在当前执行结束后处理；尚未即时送入子 Agent。" : `已在原子会话恢复；当前状态：${sent.run.status}。`;
      return taskToolResult(sent.run, `${message} 结果会自动返回。摘要：${params.summary}`, sent.delivery, true);
    },
  });

  pi.registerTool({
    name: "Agent",
    label: "派遣子 Agent",
    description: "创建独立后台 Agent 任务，返回实例 agentId，结果自动送回当前会话。general-purpose 负责实现，Explore 负责只读调查。继续已有任务请用 SendMessage。",
    promptSnippet: "创建后台任务并自动接收结果；SendMessage 继续，TaskStop 停止",
    promptGuidelines: [
      "独立任务可并行派遣；不要重复执行已经交给子 Agent 的工作。",
      "你决定子任务数量、角色、分工、依赖和验收。没有人为并发数量上限；同一工作区的写任务按顺序执行。",
      "默认省略 model，由 Jev 为新子任务选配模型和思考强度；仅在用户明确指定模型时传入覆盖值。Agent 不接受 thinking 参数。SendMessage 沿用符合当前策略的原配置。",
      "审查任务使用 reviewer 或 reportProfile: 审查 的自定义角色，只能用 GPT-5.6 Sol / xhigh 或 max。非审查角色禁止 GPT-5.6 Sol；GPT-6 Sol/Luna 最低 high。Jev、显式配置和关闭选配均遵守该策略。",
      "description 是简短标题；prompt 是完整任务；subagent_type 是角色；name 是可选实例名称。同一主会话内名称唯一，任务结束后仍保留绑定。",
      "完成和提问会自动返回，不要轮询或使用 sleep 等待；有独立工作就继续，否则告知用户正在等待。",
      "根据证据判断结果，补充调查或返工调用 SendMessage，to 使用返回的 agentId 或实例 name，不能使用角色名。子 Agent 提问能根据已有授权回答时直接回复，只把真正缺少的用户决定交给用户。",
    ],
    parameters: AgentParameters,

    async execute(_toolCallId, raw, signal, onUpdate, ctx) {
      if (!deckEnabled) throw new Error("Agent 已关闭，请在 /agent-deck 开启后重试。");
      const params = parseAgentInput(raw);
      const agents = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
      const agent = resolveAgentRole(params.subagent_type, agents);
      const request: DelegationRequest = {
        agent: agent.id,
        objective: params.prompt,
        acceptanceCriteria: [],
      };
      const definitionErrors = validateAgentDefinition(agent);
      if (definitionErrors.length > 0) throw new Error(`Agent“${agent.name}”配置无效：${definitionErrors.join("；")}`);
      const config = readDeckConfig();
      const model = resolveModelOverride(params.model, config);
      requireAvailableModel(model ?? agent.model, ctx);
      const tools = agent.tools ?? (agent.writePermission ? DEFAULT_WRITE_TOOLS : DEFAULT_READ_ONLY_TOOLS);
      const unsupportedTools = tools.filter((tool) => !CHILD_SUPPORTED_TOOLS.has(tool));
      if (unsupportedTools.length) throw new Error(`Agent“${agent.name}”配置了 child runtime 不支持的工具：${unsupportedTools.join("、")}`);
      const routing = prepareRouting(agent, request.objective, ctx, config, pi.getThinkingLevel?.() ?? "off", { model });
      const resolved = routing.immediate ?? routing.fallback;
      const providers = prepareChildProviders(ctx.modelRegistry, [resolved.model, ...routing.candidates.map((candidate) => candidate.model)]);

      const parent = ctx.sessionManager.getSessionId();
      const created = await withTaskCreation(parent, params.name, async () => {
        const runId = `A-${randomUUID().slice(0, 8)}`;
        const providerSnapshot = await saveChildProviders(runId, providers);
        const childSessionId = randomUUID();
        const parentSessionPath = ctx.sessionManager.getSessionFile();
        const childManager = SessionManager.create(ctx.cwd, undefined, {
          id: childSessionId,
          parentSession: parentSessionPath,
        });
        childManager.appendSessionInfo(`子Agent｜${params.name ?? agent.name}｜${shortTask(params.description, 36)}`);
        const childSessionPath = childManager.getSessionFile();
        if (!childSessionPath) throw new Error("无法创建持久化子 Session");
        const instruction = request.objective;
        const details: RunDetails = {
          autoDeliver: true,
          version: 1,
          runId,
          agentId: agent.id,
          agentName: agent.name,
          agentSource: agent.source,
          instanceName: params.name,
          description: params.description,
          objective: shortTask(request.objective, 80),
          instruction,
          planContext: request.planContext,
          batchId: request.batchId,
          phase: request.phase,
          acceptanceCriteria: request.acceptanceCriteria,
          status: routing.immediate ? "运行中" : "选配中",
          model: resolved.model,
          thinking: resolved.thinking,
          routing: routing.immediate,
          routingPending: !routing.immediate,
          tools,
          writePermission: agent.writePermission,
          parentSessionId: parent,
          parentSessionPath,
          childSessionId,
          childSessionPath,
          cwd: ctx.cwd,
          startedAt: Date.now(),
          reports: [],
          events: [],
          usage: emptyUsage(),
        };
        const background = true;
        pushEvent(details, "状态", "已创建独立子 Session");
        await appendIndex({
          version: 1, event: "started", at: details.startedAt, runId, agentId: agent.id, agentName: agent.name,
          objective: request.objective, status: details.status, model: details.model, thinking: details.thinking,
          parentSessionId: details.parentSessionId, parentSessionPath, childSessionId, childSessionPath,
        });
        const directory = runDirectory(runId);
        await fs.promises.mkdir(directory, { recursive: true });
        const systemPath = path.join(directory, "SYSTEM.md");
        await fs.promises.writeFile(systemPath, buildChildSystemPrompt(agent), { encoding: "utf8", mode: 0o600 });
        const childTools = [...new Set([...tools.filter((tool) => tool !== "agent_report"), "agent_question"])];
        const childArgs = [
          "--mode", "json",
          "--print",
          "--session", childSessionPath,
          "--name", `子Agent｜${params.name ?? agent.name}｜${shortTask(params.description, 36)}`,
          "--model", details.model,
          "--thinking", details.thinking,
          "--no-extensions",
          "--extension", childRuntimePath(),
          "--tools", childTools.join(","),
          "--append-system-prompt", systemPath,
        ];
        const invocation = getPiInvocation(childArgs);
        const runtimeAckToken = randomUUID();
        const runnerRequest: RunnerRequest = {
          version: 1,
          cwd: ctx.cwd,
          command: invocation.command,
          argsPrefix: invocation.args,
          prompt: instruction,
          naturalOutput: true,
          timeoutMs: agent.timeoutMs ?? config.timeoutMs,
          routing, review: routing.state.review,
          inboxPath: inboxPath(),
          env: {
            ...(providerSnapshot ? { PI_AGENT_DECK_PROVIDERS: providerSnapshot } : {}),
            PI_AGENT_DECK_RUN_ID: runId,
            PI_AGENT_DECK_SIMPLE: "1",
            PI_AGENT_DECK_RUNTIME_ACK_PATH: path.join(directory, "runtime-ack.json"),
            PI_AGENT_DECK_RUNTIME_ACK_TOKEN: runtimeAckToken,
            PI_AGENT_DECK_PROTOCOL_VERSION: String(CHILD_RUNTIME_PROTOCOL_VERSION),
            PI_AGENT_DECK_EXTENSION_VERSION: AGENT_DECK_VERSION,
          },
        };
        await initializeRun(details, runnerRequest, background);
        return details;
      });
      await launchRunner(created.runId);
      const current = (await readRun(created.runId)) ?? created;
      return taskToolResult(current, `${current.status === "选配中" ? "Jev 正在选配模型与思考强度。" : current.status === "排队中" ? "正在等待工作区可用。" : `当前状态：${current.status}。`} 结果会自动返回；可以继续其他独立工作。`);
    },

    renderCall(args, theme) {
      return new Text([
        theme.fg("toolTitle", theme.bold(`↗ 派遣 Agent：${args.name ?? args.subagent_type ?? "general-purpose"}`)),
        theme.fg("muted", `  ${shortTask(args.description ?? "等待任务", 100)}`),
      ].join("\n"), 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = (result.details as { run?: RunDetails } | undefined)?.run;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      const icon = details.status === "已完成" ? theme.fg("success", "✓")
        : details.status === "等待决定" ? theme.fg("warning", "◐")
        : details.status === "运行中" || details.status === "排队中" || details.status === "选配中" ? theme.fg("accent", "●")
        : theme.fg("error", "✗");
      return new Text([
        `${icon} ${theme.fg("toolTitle", theme.bold(runRoleLabel(details)))} · ${statusLabel(details.status)}`,
        theme.fg("muted", `  ${shortTask(runTitle(details), 100)}`),
      ].join("\n"), 0, 0);
    },
  });

  const handlePanelAction = async (action: AgentPanelAction, ctx: any): Promise<void> => {
    if (action.action === "关闭") return;
    if (action.action === "创建") return createAgentFromDescription(pi, ctx);
    if (action.action === "配置") return openConfiguration("", ctx);
    const run = await readRun(action.runId);
    if (!run) return void ctx.ui.notify(`找不到运行：${action.runId}`, "error");
    if (run.parentSessionId !== ctx.sessionManager.getSessionId()) return void ctx.ui.notify("只能操作当前会话的任务。", "warning");
    if (action.action === "停止") {
      const approved = await ctx.ui.confirm(
        "停止子 Agent？",
        `${run.agentName}\n${run.objective}\n\n停止不会删除子 Session、报告或运行记录。`,
      );
      if (!approved) return;
      const stopped = await stopRun(run.runId);
      ctx.ui.notify(`${run.agentName}：${stopped.status}`, stopped.status === "停止未确认" ? "warning" : "info");
      return;
    }
    if (action.action === "继续") {
      if (!readDeckConfig().enabled) return void ctx.ui.notify("多 Agent 已关闭，请先 /agent-deck 开启。", "warning");
      const report = [...run.reports].reverse().find((item) => item.type === "问题" && item.blocking);
      const answer = await ctx.ui.editor(
        `继续 ${run.agentName}`,
        report ? `${report.question ?? report.summary}\n\n请填写答复：\n` : "",
      );
      if (!answer?.trim()) return;
      const sent = await sendToRun(run.runId, answer);
      ctx.ui.notify(sent.delivery === "queued" ? `${runRoleLabel(run)}：消息已排队，当前执行结束后处理。` : `${runRoleLabel(run)}：已在原会话恢复，${sent.run.status}。`, "info");
      return;
    }
  };

  const openAgentPanel = async (ctx: any): Promise<void> => {
    while (true) {
      const action = await showAgentPanel(ctx);
      await handlePanelAction(action, ctx);
      if (action.action !== "创建" && action.action !== "配置") return;
    }
  };

  pi.registerCommand("agent-panel", {
    description: "打开可交互 Agent 控制台",
    handler: async (_args, ctx) => openAgentPanel(ctx),
  });

  pi.registerCommand("agent-stop", {
    description: "停止正在运行的子 Agent：/agent-stop A-xxxxxxxx",
    handler: async (args, ctx) => {
      const runId = args.trim();
      if (!runId) return void ctx.ui.notify("请提供运行编号，例如 /agent-stop A-12345678", "warning");
      await handlePanelAction({ action: "停止", runId }, ctx);
    },
  });

  pi.registerCommand("agent-continue", {
    description: "回答阻塞问题并在原子 Session 中继续：/agent-continue A-xxxxxxxx [答复]",
    handler: async (args, ctx) => {
      if (!readDeckConfig().enabled) return void ctx.ui.notify("多 Agent 已关闭，请先 /agent-deck 开启。", "warning");
      const [runId, ...answerParts] = args.trim().split(/\s+/);
      if (!runId) return void ctx.ui.notify("请提供运行编号，例如 /agent-continue A-12345678 保持兼容", "warning");
      const run = await readRun(runId);
      if (!run) return void ctx.ui.notify(`找不到运行：${runId}`, "error");
      if (run.parentSessionId !== ctx.sessionManager.getSessionId()) return void ctx.ui.notify("只能操作当前会话的任务。", "warning");
      let answer = answerParts.join(" ").trim();
      if (!answer) answer = (await ctx.ui.editor(`回答 ${run.agentName}`, "请填写主会话决定：\n"))?.trim() ?? "";
      if (!answer) return;
      const sent = await sendToRun(runId, answer);
      ctx.ui.notify(sent.delivery === "queued" ? `${runRoleLabel(run)}：消息已排队，当前执行结束后处理。` : `${runRoleLabel(run)}：已在原会话恢复，${sent.run.status}。`, "info");
    },
  });

  pi.registerCommand("agent-deck", {
     description: "切换、开启或关闭多 Agent：/agent-deck [开启|关闭|状态]",
    getArgumentCompletions: (prefix) => {
      const primary = deckEnabled
        ? { value: "关闭", label: "关闭多 Agent（当前开启，回车执行）" }
        : { value: "开启", label: "开启多 Agent（当前关闭，回车执行）" };
      const secondary = deckEnabled
        ? { value: "开启", label: "开启多 Agent（当前已开启）" }
        : { value: "关闭", label: "关闭多 Agent（当前已关闭）" };
      const values = [
        primary,
        { value: "状态", label: "查看状态（不改变开关）" },
        secondary,
        { value: "切换", label: deckEnabled ? "切换：关闭多 Agent" : "切换：开启多 Agent" },
      ];
      const query = prefix.trim().toLowerCase();
      const matches = values.filter((item) => item.value.toLowerCase().startsWith(query) || item.label.toLowerCase().includes(query));
      return matches.length ? matches : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim().toLowerCase();
      if (!action) {
        await setDeckEnabled(!deckEnabled, ctx);
        return;
      }
      if (["开启", "开", "on", "enable", "enabled"].includes(action)) {
        await setDeckEnabled(true, ctx);
        return;
      }
      if (["关闭", "关", "off", "disable", "disabled"].includes(action)) {
        await setDeckEnabled(false, ctx);
        return;
      }
      if (["切换", "toggle"].includes(action)) {
        await setDeckEnabled(!deckEnabled, ctx);
        return;
      }
      if (["状态", "status"].includes(action)) {
        ctx.ui.notify(
          deckEnabled
            ? `多 Agent 工具当前为：开启。版本 ${AGENT_DECK_VERSION}，构建 ${buildFingerprint()}。可调用 Agent、SendMessage、TaskStop。`
            : `多 Agent 工具当前为：关闭。版本 ${AGENT_DECK_VERSION}，构建 ${buildFingerprint()}。Agent 和 SendMessage 已停用，TaskStop 仍可使用。`,
          "info",
        );
        return;
      }
      ctx.ui.notify("用法：/agent-deck [开启|关闭|状态]；不带参数切换开关。", "warning");
    },
  });

  pi.registerCommand("agent-doctor", {
    description: "检查 Agent Deck 版本、运行时确认、信任、租约和工具能力",
    handler: async (_args, ctx) => {
      const supportedChildTools = CHILD_SUPPORTED_TOOLS;
      const agents = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
      const definitionProblems = agents.flatMap((agent) => {
        const errors = validateAgentDefinition(agent);
        const unsupported = (agent.tools ?? []).filter((tool) => !supportedChildTools.has(tool));
        return [
          ...errors.map((error) => `${agent.id}：${error}`),
          ...(unsupported.length ? [`${agent.id}：child runtime 未提供工具 ${unsupported.join("、")}`] : []),
        ];
      });
      const leases = listWriterLeases();
      const runs = await listRuns(20);
      const activeRuns = runs.filter((run) => !isTerminalStatus(run.status) && run.status !== "等待决定");
      const ackProblems: string[] = [];
      for (const run of activeRuns) {
        try {
          const request = JSON.parse(await fs.promises.readFile(path.join(runDirectory(run.runId), "request.json"), "utf8")) as RunnerRequest;
          const ackPath = request.env?.PI_AGENT_DECK_RUNTIME_ACK_PATH;
          const expectedToken = request.env?.PI_AGENT_DECK_RUNTIME_ACK_TOKEN;
          if (!ackPath || !expectedToken) {
            ackProblems.push(`${run.runId}：旧版请求没有 child runtime 确认信息`);
            continue;
          }
          const ack = JSON.parse(await fs.promises.readFile(ackPath, "utf8")) as { token?: string; extensionVersion?: string; protocolVersion?: number; pid?: number; acknowledgedAt?: number };
          const staleAck = typeof ack.acknowledgedAt !== "number" || ack.acknowledgedAt < (run.attemptStartedAt ?? run.startedAt);
          const wrongPid = run.childPid !== undefined && ack.pid !== run.childPid;
          if (ack.token !== expectedToken || ack.extensionVersion !== AGENT_DECK_VERSION || ack.protocolVersion !== CHILD_RUNTIME_PROTOCOL_VERSION || staleAck || wrongPid) {
            ackProblems.push(`${run.runId}：child runtime 版本、PID、时间或确认 token 不匹配`);
          }
        } catch {
          ackProblems.push(`${run.runId}：尚未收到 child runtime 确认`);
        }
      }
      const runnerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "runner.mjs");
      const runnerExists = fs.existsSync(runnerPath);
      const diskVersion = packageVersionFromDisk();
      const diskFingerprint = buildFingerprint();
      const reloadRequired = diskVersion !== AGENT_DECK_VERSION || diskFingerprint !== LOADED_BUILD_FINGERPRINT;
      let inboxHealth = "尚无事件";
      try {
        const inboxLines = (await fs.promises.readFile(inboxPath(), "utf8")).split(/\r?\n/).filter(Boolean);
        const malformed = inboxLines.filter((line) => { try { JSON.parse(line); return false; } catch { return true; } }).length;
        inboxHealth = `${inboxLines.length} 条 · 损坏 ${malformed} 条`;
      } catch { /* 尚无 legacy inbox */ }
      const lines = [
        `Agent Deck ${AGENT_DECK_VERSION} · 已加载构建 ${LOADED_BUILD_FINGERPRINT}`,
        `磁盘版本：${diskVersion ?? "未知"} · 磁盘构建：${diskFingerprint} · 需要 /reload：${reloadRequired ? "是" : "否"}`,
        `Run schema：v${RUN_SCHEMA_VERSION} · Runner protocol：v${RUNNER_PROTOCOL_VERSION} · Child protocol：v${CHILD_RUNTIME_PROTOCOL_VERSION}`,
        `Pi 宿主：${process.execPath} · ${process.version} · 模式：${ctx.mode}`,
        `项目：${ctx.cwd} · 信任：${ctx.isProjectTrusted() ? "已信任" : "未信任（项目 Agent 已忽略）"}`,
        `Runner：${runnerExists ? runnerPath : `缺失：${runnerPath}`}`,
        `活动运行：${activeRuns.length} · writer 租约：${leases.length} · legacy inbox：${inboxHealth}`,
        `数量由主 Agent 决定 · Jev 选配：${readDeckConfig().routing.enabled ? "开启" : "关闭"} · 默认时限：${readDeckConfig().timeoutMs === 0 ? "不限时" : `${readDeckConfig().timeoutMs} ms`} · /agent-config 可编辑`,
        `Agent 定义：${agents.length} · 能力问题：${definitionProblems.length} · runtime 确认问题：${ackProblems.length}`,
      ];
      if (leases.length) lines.push("", "Writer 租约：", ...leases.map((item) => `• ${item.lease?.runId ?? "未知所有者"} · ${item.lease?.cwd ?? item.leasePath}`));
      if (definitionProblems.length) lines.push("", "Agent 能力问题：", ...definitionProblems.map((item) => `• ${item}`));
      if (ackProblems.length) lines.push("", "运行时确认问题：", ...ackProblems.map((item) => `• ${item}`));
      lines.push("", "修改扩展源码后必须执行 /reload；版本或协议不一致时不要继续派遣写 Agent。");
      ctx.ui.notify(lines.join("\n"), definitionProblems.length || ackProblems.length || !runnerExists || reloadRequired ? "warning" : "info");
    },
  });

  pi.registerCommand("agents", {
    description: "查看当前会话任务、结果，继续或停止 Agent",
    handler: async (_args, ctx) => openAgentPanel(ctx),
  });

  pi.registerCommand("agent-roles", {
    description: "查看可用的自定义 Agent",
    handler: async (_args, ctx) => {
      const projectTrusted = ctx.isProjectTrusted();
      const agents = discoverAgents(ctx.cwd, { projectTrusted });
      const candidates = discoverAgentCandidates(ctx.cwd, { projectTrusted });
      const trustNotice = projectTrusted
        ? "\n\n项目状态：已信任，项目 Agent 可以参与覆盖。"
        : "\n\n项目状态：未信任，已忽略项目级 .pi/agents。使用 /trust 后重启 Pi 才会加载。";
      const text = agents.length
        ? agents.map((agent) => {
            const chain = candidates.filter((candidate) => candidate.id === agent.id).map((candidate) => candidate.source);
            const override = chain.length > 1 ? `\n  覆盖链：${chain.join(" → ")}（当前使用 ${agent.source}）` : "";
            const timeout = agent.timeoutMs ?? readDeckConfig().timeoutMs;
            return `${agent.id}｜${agent.name}｜${agent.source}｜${agent.model ?? "自动选配（遵守角色策略）"}｜${agent.writePermission ? "允许写入" : "只读"}\n  ${agent.description}\n  思考：${agent.thinking ?? "自动选配"} · 工具：${agent.tools?.join(", ") ?? "默认"}\n  时限：${timeout === 0 ? "不限时" : `${timeout} ms`}\n  文件：${agent.filePath}\n  编辑：/agent-config ${agent.id}${override}`;
          }).join("\n\n") + trustNotice
        : `没有发现 Agent 定义。${trustNotice}`;
      if (ctx.mode !== "tui") return void ctx.ui.notify(text, "info");
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => ({
        render: (width) => new Text(`${theme.fg("accent", theme.bold("可用 Agent"))}\n\n${text}\n\n${theme.fg("dim", "按 Esc 关闭")}`, 1, 1).render(width),
        handleInput: (data) => { if (data === "\u001b" || data === "\u0003") done(); },
        invalidate: () => {},
      }));
    },
  });

  pi.registerCommand("agent-runs", {
    description: "查看最近的子 Agent 运行索引",
    handler: async (_args, ctx) => {
      const rows = await listRuns(20, ctx.sessionManager.getSessionId());
      const text = rows.length
        ? rows.map((item) => `${item.runId}｜${item.agentName}｜${item.status}｜${item.childSessionId.slice(0, 8)}\n  ${shortTask(item.objective, 90)}`).join("\n\n")
        : "还没有子 Agent 运行记录。";
      ctx.ui.notify(text, "info");
    },
  });

}
