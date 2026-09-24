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
import { discoverAgentCandidates, discoverAgents, validateAgentDefinition } from "./agents.ts";
import { buildChildSystemPrompt } from "./instruction.ts";
import {
  sendToRun,
  resumeRun,
  reconcileRun,
  subscribeRunEvents,
  shutdownRuns,
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
import { RESULT_MESSAGE, resultMessage, statusLabel, labelHistoricalMessage } from "./delivery.ts";
import { readDeckConfig, writeDeckConfig } from "./config.ts";
import { registerConfiguration } from "./configuration-ui.ts";
import { agentAuthoringContext, createAgentFromDescription } from "./agent-creation.ts";
import { renderFleet } from "./presentation.ts";
import { prepareRouting } from "./routing.ts";
import { prepareChildProviders, saveChildProviders } from "./child-providers.ts";
import { registerRouting } from "./routing-ui.ts";
import { AgentParameters, SendMessageParameters, TaskStopParameters, parseAgentInput, parseMessageInput, parseStopInput, resolveAgentRole, resolveModelOverride, requireAvailableModel, taskToolResult, runTitle, runRoleLabel } from "./tool-contract.ts";
import { resolveTaskTarget, withTaskCreation } from "./task-identity.ts";
import { AGENT_DECK_VERSION } from "./version.ts";
import { roleCapabilities, roleCapabilityCatalog } from "./capabilities.ts";
import { activeRunCount, reserveRunSlot } from "./run-capacity.ts";
import type {
  AgentDefinition,
  DelegationRequest,
  RunDetails,
  RunIndexEvent,
  RunStatus,
} from "./types.ts";

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

  let activeContext: any;
  let unsubscribe: (() => void) | undefined;
  let refreshScheduled = false;
  let fleetRefresh = 0;

  const refreshFleet = async (ctx: any): Promise<void> => {
    const refreshId = ++fleetRefresh;
    const parent = ctx.sessionManager.getSessionId();
    const runs = await listRuns(Number.MAX_SAFE_INTEGER, parent);
    if (refreshId !== fleetRefresh || activeContext?.sessionManager.getSessionId() !== parent) return;
    const visible = runs.filter((run) => !isTerminalStatus(run.status));
    ctx.ui.setWidget("agent-deck-fleet", visible.length ? (tui: TUI, theme: Theme) => ({
      render: (width: number) => renderFleet(visible, width, tui.terminal?.rows ?? 24, theme), invalidate() {},
    }) : undefined);
  };

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    deckEnabled = readDeckConfig().enabled;
    applyDeckState(ctx);
    unsubscribe?.();
    unsubscribe = subscribeRunEvents(({ kind, run }) => {
      if (run.parentSessionId !== activeContext?.sessionManager.getSessionId()) return;
      if (!refreshScheduled) {
        refreshScheduled = true;
        queueMicrotask(() => {
          refreshScheduled = false;
          void refreshFleet(activeContext).catch((error) => activeContext?.ui.setStatus("agent-deck-error", String(error)));
        });
      }
      if (kind === "result") {
        const message = resultMessage(run, run.parentSessionId);
        if (message) pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
      }
    });
    await reconcileRuns(ctx.sessionManager.getSessionId());
    await refreshFleet(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    activeContext = undefined;
    await shutdownRuns();
  });

  pi.on("context", async (event) => ({
    messages: await Promise.all(event.messages.map(async (message) => {
      if (message.role !== "custom" || message.customType !== RESULT_MESSAGE) return message;
      const id = (message.details as { taskId?: string } | undefined)?.taskId;
      return id ? labelHistoricalMessage(message, await readRun(id)) : message;
    })),
  }));
  pi.on("before_agent_start", async (_event, ctx) => ({
    message: {
      customType: "agent-roles", display: false,
      content: [agentAuthoringContext(), deckEnabled ? `角色实际能力（subagent_type；不继承主 Agent 的其他扩展）：\n${roleCapabilityCatalog(discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() }))}\n本会话槽位 ${activeRunCount(ctx.sessionManager.getSessionId())}/8。Agent 新建；Agent.resume 明确续接；SendMessage 只补充；TaskStop 中断。` : "派遣已关闭，仍可停止任务、创建和编辑角色；开启派遣使用 /agent-deck 开启。"].join("\n"),
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
    name: "SendMessage", label: "联系 Agent", description: "向任务 ID 或实例名称补充信息。运行中在 Pi 工具边界接收；已结束时仅暂存，不启动任务。开始下一次执行请明确调用 Agent({resume, prompt})。",
    parameters: SendMessageParameters,
    async execute(_id, raw, _signal, _update, ctx) {
      if (!deckEnabled) throw new Error("Agent 已关闭，请在 /agent-deck 开启后重试。");
      const params = parseMessageInput(raw);
      const run = await resolveTaskTarget(params.to, ctx.sessionManager.getSessionId());
      await reconcileRun(run.runId);
      const sent = await sendToRun(run.runId, params.message, params.summary);
      return taskToolResult(sent.run, (sent.delivery === "deferred" ? "信息已暂存于当前主 Pi 进程，任务未启动；继续请调用 Agent({resume, prompt})。退出或重载不会重放暂存消息。" : "补充已接收或排队，将在 Pi 消息边界送入；这不表示模型已经读到。") + ` 摘要：${params.summary}`, sent.delivery, true);
    },
  });

  pi.registerTool({
    name: "Agent",
    label: "派遣子 Agent",
    description: "创建独立子任务并返回 agentId；明确传 resume 可复用已结束任务的 Pi 子会话。general-purpose 实现，Explore 只读调查，reviewer 审查。结果自动返回，进程自动释放，由主 Agent 验收。",
    promptSnippet: "派发明确任务；Agent.resume 续接，SendMessage 只补充，TaskStop 停止",
    promptGuidelines: [
      "你负责理解需求、澄清影响任务方向的关键歧义、分工、依赖和验收。常规可逆选择自主处理，只有必要的用户决定才询问用户。",
      "简单工作直接完成；有明确分工价值时委派。每项任务的 prompt 写清目标、范围、预期交付和验收方法，任务数量按实际需要决定。",
      "派发前核对角色的实际工具能力；只读角色不能运行测试。独立工作可并行，有依赖或共享接口的工作顺序执行；避免重复子 Agent 的工作。所有子任务共享工作目录。",
      "最多 8 个活跃子任务，满额报错、不自动排队。Jev 只选择模型和思考强度，默认省略 model；用户明确指定时覆盖。审查只用 5.6 Sol 且最低 xhigh；6 Sol/Luna 最低 high；Astra 禁用。",
      "新目标新建任务。同一任务的返工或补查明确 Agent({resume: agentId, prompt})，沿用原角色、模型和会话；运行中补充用 SendMessage。任务 ID 或实例 name 用于寻址，角色名不是任务 ID。",
      "子 Agent 自主执行并返回结果；阻塞原因由你处理，必要时由你向用户澄清。完成通知自动送回，等待期间可做其他独立工作。",
      "执行结束后进程自动释放。子 Agent 的完成和检查报告不是验收结论；你核对实际证据、必要的检查及整体兼容性，再向用户汇报。",
    ],
    parameters: AgentParameters,

    async execute(_toolCallId, raw, signal, onUpdate, ctx) {
      if (!deckEnabled) throw new Error("Agent 已关闭，请在 /agent-deck 开启后重试。");
      const params = parseAgentInput(raw);
      if (params.resume !== undefined) {
        const original = await resolveTaskTarget(params.resume, ctx.sessionManager.getSessionId());
        const resumed = await resumeRun(original.runId, params.prompt, params.description);
        return taskToolResult(resumed, "已明确续接原任务和 Pi 子会话；本轮结果会自动返回。", "resumed", true);
      }
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
      const capability = roleCapabilities(agent);
      if (capability.errors.length) throw new Error(`Agent“${agent.name}”不可用：${capability.errors.join("；")}`);
      const tools = capability.tools;
      const routing = prepareRouting(agent, request.objective, ctx, config, pi.getThinkingLevel?.() ?? "off", { model });
      const resolved = routing.immediate ?? routing.fallback;
      const providers = prepareChildProviders(ctx.modelRegistry, [resolved.model, ...routing.candidates.map((candidate) => candidate.model)]);

      const parent = ctx.sessionManager.getSessionId();
      const created = await withTaskCreation(parent, params.name, async () => {
        const runId = `A-${randomUUID().slice(0, 8)}`;
        const release = reserveRunSlot(parent, runId);
        try {
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
          // Pi defers the first disk write until an assistant message. Materialize
          // its native header before another process opens this new session.
          await fs.promises.writeFile(childSessionPath, [childManager.getHeader(), ...childManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
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
          const childTools = tools;
          const childArgs = [
            "--mode", "rpc",
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
          const runnerRequest: RunnerRequest = {
            version: 1,
            cwd: ctx.cwd,
            command: invocation.command,
            argsPrefix: invocation.args,
            prompt: instruction,
            naturalOutput: true,
            timeoutMs: agent.timeoutMs ?? config.timeoutMs,
            routing, review: routing.state.review,
            env: {
              ...(providerSnapshot ? { PI_AGENT_DECK_PROVIDERS: providerSnapshot } : {}),
              PI_AGENT_DECK_RUN_ID: runId,
              PI_AGENT_DECK_SIMPLE: "1",
            },
          };
          await initializeRun(details, runnerRequest, background);
          return details;
        } catch (error) { release(); throw error; }
      });
      await launchRunner(created.runId);
      const current = (await readRun(created.runId)) ?? created;
      return taskToolResult(current, `${current.status === "选配中" ? "Jev 正在选配模型与思考强度。" : current.status === "排队中" ? "正在等待工作区可用。" : `当前状态：${current.status}。`} 结果会自动返回；可以继续其他独立工作。`);
    },

    renderCall(args, theme) {
      return new Text([
        theme.fg("toolTitle", theme.bold(`↗ 派遣 Agent：${args.resume ?? args.name ?? args.subagent_type ?? "general-purpose"}`)),
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

  };

  const openAgentPanel = async (ctx: any): Promise<void> => {
    while (true) {
      const action = await showAgentPanel(ctx);
      await handlePanelAction(action, ctx);
      if (action.action !== "创建" && action.action !== "配置") return;
    }
  };

  pi.registerCommand("agent-panel", {
    description: "打开只读 Agent 进度与子会话查看页",
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
    description: "旧续接入口已移除；请在主会话要求主 Agent 明确 resume 原任务。",
    handler: async (_args, ctx) => { ctx.ui.notify("请在主会话说明继续哪个任务及本次要求，由主 Agent 调用 Agent({resume, prompt})。此命令未启动任务。", "info"); },
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
            ? `多 Agent 工具当前为：开启。版本 ${AGENT_DECK_VERSION}。可调用 Agent、SendMessage、TaskStop。`
            : `多 Agent 工具当前为：关闭。版本 ${AGENT_DECK_VERSION}。Agent 和 SendMessage 已停用，TaskStop 仍可使用。`,
          "info",
        );
        return;
      }
      ctx.ui.notify("用法：/agent-deck [开启|关闭|状态]；不带参数切换开关。", "warning");
    },
  });

  pi.registerCommand("agent-doctor", {
    description: "查看 Agent Deck 通信方式、当前任务和角色工具能力",
    handler: async (_args, ctx) => {
      const agents = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
      const definitionProblems = agents.flatMap((agent) => {
        return roleCapabilities(agent).errors.map((error) => `${agent.id}：${error}`);
      });
      const runs = await listRuns(Number.MAX_SAFE_INTEGER, ctx.sessionManager.getSessionId());
      const lines = [
        `Agent Deck ${AGENT_DECK_VERSION} · 主 Pi 管理 RPC 子会话`,
        `Pi 宿主：${process.execPath} · ${process.version} · 模式：${ctx.mode}`,
        `项目：${ctx.cwd} · 信任：${ctx.isProjectTrusted() ? "已信任" : "未信任（项目 Agent 已忽略）"}`,
        `当前会话任务：${runs.length} · 需求澄清与验收由主 Agent 负责`,
        `槽位 ${activeRunCount(ctx.sessionManager.getSessionId())}/8 · 数量由主 Agent 决定 · Jev 只选模型/思考：${readDeckConfig().routing.enabled ? "开启" : "关闭"}`,
        "结果、失败、中断与进程资源分开记录；返回结果后自动释放进程，主 Agent 独立验收。",
        "关闭或重载主 Pi 会结束它管理的子进程；会话记录保留，之后可手动继续。",
        ...definitionProblems.map((problem) => `• ${problem}`),
      ];
      ctx.ui.notify(lines.join("\n"), definitionProblems.length ? "warning" : "info");    },
  });

  pi.registerCommand("agents", {
    description: "查看任务进度、真实子会话和结果",
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
      const visible = `${roleCapabilityCatalog(agents)}\n\n${text}`;
      if (ctx.mode !== "tui") return void ctx.ui.notify(visible, "info");
      await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => ({
        render: (width) => new Text(`${theme.fg("accent", theme.bold("可用 Agent"))}\n\n${visible}\n\n${theme.fg("dim", "按 Esc 关闭")}`, 1, 1).render(width),
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
