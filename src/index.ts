import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text, type TUI } from "@earendil-works/pi-tui";
import { discoverAgentCandidates, discoverAgents, validateAgentDefinition } from "./agents.ts";
import { buildChildSystemPrompt, buildTaskText, taskSummary } from "./instruction.ts";
import { imageSettingsDiagnostic } from "./image-settings.ts";
import {
  sendToRun,
  resumeRun,
  reconcileRun,
  subscribeRunEvents,
  shutdownRuns,
  initializeRun,
  discardUninitializedRun,
  isTerminalStatus,
  launchRunner,
  listRuns,
  readRun,
  reconcileRuns,
  runDirectory,
  stopRun,
  waitForRunTurn,
  type RunnerRequest,
} from "./runtime.ts";
import { showAgentPanel, type AgentPanelAction } from "./ui.ts";
import { RESULT_MESSAGE, PARENT_MESSAGE, statusLabel, taskOutput } from "./delivery.ts";
import { createBackgroundDelivery } from "./background-delivery.ts";
import { readDeckConfig, writeDeckConfig } from "./config.ts";
import { registerConfiguration } from "./configuration-ui.ts";
import { createAgentFromDescription } from "./agent-creation.ts";
import { renderFleet } from "./presentation.ts";
import { prepareRouting } from "./routing.ts";
import { canPrepareChildProvider, prepareChildProviders, saveChildProviders } from "./child-providers.ts";
import { registerRouting } from "./routing-ui.ts";
import { AgentParameters, SendMessageParameters, TaskStopParameters, parseAgentInput, parseMessageInput, parseStopInput, resolveAgentRole, resolveModelOverride, taskToolResult, taskMessage, runTitle, runRoleLabel } from "./tool-contract.ts";
import { resolveTaskTarget, withTaskCreation } from "./task-identity.ts";
import { AGENT_DECK_VERSION } from "./version.ts";
import type {
  AgentDefinition,
  RunDetails,
  PersistedRun,
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

const BACKGROUND_WAIT = "结果会自动通知并唤醒主 Agent。可以继续独立工作；当前只需等待时，结束本轮回复即可，收到通知后继续验收。";

export function agentToolDescription(agents: AgentDefinition[], environmentWarning?: string): string {
  const roles = agents.map((agent) => {
    const aliases = agent.id === "worker" ? " / general-purpose" : agent.id === "scout" ? " / Explore" : "";
    const tools = agent.tools === undefined ? "Pi 默认工具" : agent.tools.length ? agent.tools.join(", ") : "无";
    const excluded = agent.disallowedTools?.length ? agent.disallowedTools.join(", ") : "无";
    return `- ${agent.id}${aliases}（${agent.name}）：${agent.description}；tools=${tools}；排除=${excluded}；extensions=${agent.extensions.length}`;
  }).join("\n");
  return [
    "创建独立 Pi 子会话来完成适合委派的工作。主 Agent 负责目标、任务安排、进度与验收；简单工作可直接完成。",
    "prompt 交代目标、范围、当前有效背景、资料入口和期望交付。独立任务可并行派发；同目录的源码和项目配置修改按实施者顺序进行，主 Agent 的修改也纳入安排。审查和调查可使用 Bash 与临时产物验证证据。",
    "省略 run_in_background 或传 false 时前台等待结果；true 时后台执行并通知所属父会话。子 Agent 提出澄清问题时，前台调用先返回问题，回答后由原子会话继续并在完成时通知。",
    "SendMessage 用于补充要求、回答澄清和续接已结束的任务，沿用原角色、模型与 Pi 上下文。Agent({resume, prompt}) 是兼容的显式续接入口。completed 表示执行已结束，主 Agent 根据交付内容验收。",
    BACKGROUND_WAIT,
    "收到结果后对照用户目标决定接受、续接、补充验证或等待必要依赖，在授权范围内推进到约定终点。审查范围按改动风险和用户要求安排，修复后优先复查原问题和受影响部分；需要扩大范围时再扩大。",
    ...(environmentWarning ? [environmentWarning] : []),
    "可用 subagent_type：",
    roles || "- 当前没有可用角色。",
  ].join("\n");
}

function pushEvent(details: RunDetails, kind: RunDetails["events"][number]["kind"], text: string): void {
  details.events.push({ at: Date.now(), kind, text });
  if (details.events.length > MAX_EVENTS) details.events.splice(0, details.events.length - MAX_EVENTS);
}

export default function agentDeck(pi: ExtensionAPI) {
  let deckEnabled = readDeckConfig().enabled;
  let agentTool: ToolDefinition<typeof AgentParameters, unknown>;
  let refreshAgentTool = (_ctx: any): void => {};
  const contextCwd = (ctx: any): string => typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
  const isProjectTrusted = (ctx: any): boolean => typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;

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

  const openConfiguration = registerConfiguration(pi, (ctx) => { deckEnabled = readDeckConfig().enabled; refreshAgentTool(ctx); applyDeckState(ctx); });
  registerRouting(pi);

  let activeContext: any;
  let unsubscribe: (() => void) | undefined;
  let refreshScheduled = false;
  let fleetRefresh = 0;
  const backgroundDelivery = createBackgroundDelivery(pi, () => activeContext);

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
    refreshAgentTool(ctx);
    applyDeckState(ctx);
    unsubscribe?.();
    unsubscribe = subscribeRunEvents((notification) => {
      const { kind, run } = notification;
      if (run.parentSessionId !== activeContext?.sessionManager.getSessionId()) return;
      if (!refreshScheduled) {
        refreshScheduled = true;
        queueMicrotask(() => {
          refreshScheduled = false;
          void refreshFleet(activeContext).catch((error) => activeContext?.ui.setStatus("agent-deck-error", String(error)));
        });
      }
      if (kind === "result") backgroundDelivery.notify(run);
      if (notification.kind === "message") pi.sendMessage({
        customType: PARENT_MESSAGE,
        content: taskMessage(run, `子 Agent 消息：\n${notification.message.message}`),
        display: true,
        details: { taskId: run.runId, turnId: run.turnId, messageId: notification.message.id },
      }, { deliverAs: "followUp", triggerTurn: true });
    });
    await reconcileRuns(ctx.sessionManager.getSessionId());
    await refreshFleet(ctx);
  });

  pi.on("session_shutdown", async () => {
    unsubscribe?.();
    unsubscribe = undefined;
    activeContext = undefined;
    backgroundDelivery.reset();
    await shutdownRuns();
  });

  pi.on("before_agent_start", async (_event, ctx) => { refreshAgentTool(ctx); });

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
      const stopped = await stopRun(run.runId, "tool-stop", run.turnId ?? null);
      return taskToolResult(stopped, stopped.status === "停止未确认" ? "停止未确认；仍需核对进程状态。" : isTerminalStatus(run.status) ? `任务已经结束，保留原状态：${stopped.status}；排队消息已清除。` : `任务${stopped.status}；排队消息已清除。`);
    },
  });

  pi.registerTool({
    name: "SendMessage", label: "联系 Agent", description: `向任务 ID 或实例名称发送补充要求、澄清回答或续接要求。运行中在消息边界接收；等待决定时交付回答；已结束时恢复原 Pi 会话并在后台执行。回答问题时可用 reply_to 对准问题编号。${BACKGROUND_WAIT}`,
    parameters: SendMessageParameters,
    async execute(_id, raw, _signal, _update, ctx) {
      if (!deckEnabled) throw new Error("Agent 已关闭，请在 /agent-deck 开启后重试。");
      const params = parseMessageInput(raw);
      const run = await resolveTaskTarget(params.to, ctx.sessionManager.getSessionId());
      await reconcileRun(run.runId);
      const gate = backgroundDelivery.acquire(run.runId);
      try {
        const sent = await sendToRun(run.runId, params.message, params.summary, params.reply_to);
        const current = (await readRun(run.runId)) ?? sent.run;
        backgroundDelivery.release(current, gate);
        const receipt = sent.delivery === "resumed" ? "已恢复原 Pi 子会话，在后台继续执行。"
          : sent.delivery === "answered" ? "回答已交付，子 Agent 在原会话继续。" : "消息已接收或排队，将在 Pi 消息边界送入。";
        return taskToolResult(current, current.pendingQuestion || isTerminalStatus(current.status) || current.status === "停止未确认"
          ? taskOutput(current) : `${receipt} 摘要：${params.summary}${current.deliveryMode === "background" ? `\n${BACKGROUND_WAIT}` : ""}`, sent.delivery);
      } catch (error) {
        backgroundDelivery.discard(run.runId, gate);
        throw error;
      }
    },
  });

  agentTool = {
    name: "Agent",
    label: "派遣子 Agent",
    description: agentToolDescription(discoverAgents(process.cwd(), { projectTrusted: false })),
    promptSnippet: "Agent 派发；SendMessage 补充、回答和续接；TaskStop 停止",
    executionMode: "parallel" as const,
    parameters: AgentParameters,

    async execute(_toolCallId, raw, signal, onUpdate, ctx) {
      if (!deckEnabled) throw new Error("Agent 已关闭，请在 /agent-deck 开启后重试。");
      const params = parseAgentInput(raw);
      if (params.resume !== undefined) {
        const original = await resolveTaskTarget(params.resume, ctx.sessionManager.getSessionId());
        const deliveryGate = params.run_in_background ? backgroundDelivery.acquire(original.runId) : undefined;
        let resumed: PersistedRun;
        try {
          const started = await resumeRun(original.runId, params.prompt, params.description, params.run_in_background, original.turnId ?? null);
          resumed = (await readRun(original.runId)) ?? started;
          if (deliveryGate) backgroundDelivery.release(resumed, deliveryGate);
        } catch (error) {
          if (deliveryGate) backgroundDelivery.discard(original.runId, deliveryGate);
          throw error;
        }
        if (isTerminalStatus(resumed.status) || resumed.status === "停止未确认" || (params.run_in_background && resumed.pendingQuestion)) {
          return taskToolResult(resumed, taskOutput(resumed), "resumed");
        }
        if (params.run_in_background) return taskToolResult(resumed, `已续接原任务和 Pi 子会话，本轮在后台执行。${BACKGROUND_WAIT}`, "resumed");
        if (!resumed.turnId) throw new Error("续接后缺少 turnId，无法前台等待。");
        const completed = await waitForRunTurn(resumed.runId, resumed.turnId, {
          signal, stopOnAbort: true,
          onUpdate: (run) => onUpdate?.(taskToolResult(run, `前台等待中：${run.status}`)),
        });
        return taskToolResult(completed, taskOutput(completed), "resumed");
      }
      const agents = discoverAgents(contextCwd(ctx), { projectTrusted: isProjectTrusted(ctx) });
      const agent = resolveAgentRole(params.subagent_type, agents);
      const definitionErrors = validateAgentDefinition(agent);
      if (definitionErrors.length > 0) throw new Error(`Agent“${agent.name}”配置无效：${definitionErrors.join("；")}`);
      const config = readDeckConfig();
      const model = resolveModelOverride(params.model, config);
      // A native/function provider from an unrelated parent extension must not
      // block every child task. Jev sees only models that an isolated child Pi
      // can actually load; an unavailable preference therefore soft-falls back.
      const compatibleModels = (ctx.modelRegistry.getAvailable?.() ?? []).filter((candidate: any) =>
        canPrepareChildProvider(ctx.modelRegistry, `${candidate.provider}/${candidate.id}`));
      const currentModel = ctx.model && canPrepareChildProvider(ctx.modelRegistry, `${ctx.model.provider}/${ctx.model.id}`)
        ? ctx.model : compatibleModels[0];
      const routingContext = {
        model: currentModel,
        modelRegistry: {
          getAvailable: () => compatibleModels,
          find: (provider: string, id: string) => compatibleModels.find((candidate: any) => candidate.provider === provider && candidate.id === id),
        },
      };
      const routing = prepareRouting(agent, params.prompt, routingContext, config, pi.getThinkingLevel?.() ?? "off", { model });
      const resolved = routing.immediate ?? routing.fallback;
      const providers = prepareChildProviders(ctx.modelRegistry, [resolved.model, ...routing.candidates.map((candidate) => candidate.model)]);

      const parent = ctx.sessionManager.getSessionId();
      const cwd = contextCwd(ctx);
      const created = await withTaskCreation(parent, params.name, async () => {
        const runId = `A-${randomUUID().slice(0, 8)}`;
        const directory = runDirectory(runId);
        let directoryCreated = false;
        let providerSnapshot: string | undefined;
        let childSessionPath: string | undefined;
        let childSessionCreated = false;
        let committed = false;
        try {
          await fs.promises.mkdir(path.dirname(directory), { recursive: true });
          await fs.promises.mkdir(directory);
          directoryCreated = true;
          providerSnapshot = await saveChildProviders(runId, providers);
          const childSessionId = randomUUID();
          const parentSessionPath = ctx.sessionManager.getSessionFile();
          const childManager = SessionManager.create(cwd, undefined, {
            id: childSessionId,
            parentSession: parentSessionPath,
          });
          childManager.appendSessionInfo(`子Agent｜${params.name ?? agent.name}｜${taskSummary(params.description, 36)}`);
          childSessionPath = childManager.getSessionFile();
          if (!childSessionPath) throw new Error("无法创建持久化子 Session");
          // Pi defers the first disk write until an assistant message. Materialize
          // its native header before another process opens this new session.
          await fs.promises.writeFile(childSessionPath, [childManager.getHeader(), ...childManager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { flag: "wx" });
          childSessionCreated = true;
          const details: RunDetails = {
            version: 3,
            runId,
            roleId: agent.id,
            agentName: agent.name,
            agentSource: agent.source,
            instanceName: params.name,
            ...buildTaskText(params.prompt, params.description),
            status: routing.immediate ? "运行中" : "选配中",
            model: resolved.model,
            thinking: resolved.thinking,
            routing: routing.immediate,
            routingPending: !routing.immediate,
            tools: agent.tools,
            disallowedTools: agent.disallowedTools ?? [],
            extensions: agent.extensions,
            deliveryMode: params.run_in_background ? "background" : "foreground",
            parentSessionId: parent,
            parentSessionPath,
            childSessionId,
            childSessionPath,
            cwd,
            startedAt: Date.now(),
            events: [],
            usage: emptyUsage(),
          };
          const background = params.run_in_background;
          pushEvent(details, "状态", "已创建独立子 Session");
          const systemPath = path.join(directory, "SYSTEM.md");
          await fs.promises.writeFile(systemPath, buildChildSystemPrompt(agent), { encoding: "utf8", mode: 0o600 });
          const childArgs = [
            "--mode", "rpc",
            "--session", childSessionPath,
            "--name", `子Agent｜${params.name ?? agent.name}｜${taskSummary(params.description, 36)}`,
            "--model", details.model,
            "--thinking", details.thinking,
            "--no-extensions",
            ...agent.extensions.flatMap((extension) => ["--extension", extension]),
            "--extension", childRuntimePath(),
            ...(agent.tools ? ["--tools", agent.tools.join(",")] : []),
            ...(agent.disallowedTools?.length ? ["--exclude-tools", agent.disallowedTools.join(",")] : []),
            "--append-system-prompt", systemPath,
          ];
          const invocation = getPiInvocation(childArgs);
          const runnerRequest: RunnerRequest = {
            version: 3,
            cwd,
            command: invocation.command,
            argsPrefix: invocation.args,
            prompt: details.instruction,
            timeoutMs: agent.timeoutMs ?? config.timeoutMs,
            routing,
            env: {
              ...(providerSnapshot ? { PI_AGENT_DECK_PROVIDERS: providerSnapshot } : {}),
              PI_AGENT_DECK_RUN_ID: runId,
            },
          };
          const initialized = await initializeRun(details, runnerRequest, background);
          committed = true;
          return initialized;
        } catch (error) {
          if (committed) throw error;
          const cleanup = await Promise.allSettled([
            ...(directoryCreated ? [discardUninitializedRun(runId, parent)] : []),
            ...(providerSnapshot ? [fs.promises.unlink(providerSnapshot).catch((failure: NodeJS.ErrnoException) => {
              if (failure.code !== "ENOENT") throw failure;
            })] : []),
            ...(childSessionCreated && childSessionPath ? [fs.promises.unlink(childSessionPath).catch((failure: NodeJS.ErrnoException) => {
              if (failure.code !== "ENOENT") throw failure;
            })] : []),
          ]);
          const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failures.length) throw new AggregateError([error, ...failures.map((failure) => failure.reason)], `任务初始化失败，且部分临时文件未能清理：${String(error)}`);
          throw error;
        }
      });
      const deliveryGate = params.run_in_background ? backgroundDelivery.acquire(created.runId) : undefined;
      let current: PersistedRun;
      try {
        await launchRunner(created.runId);
        current = (await readRun(created.runId)) ?? created;
        if (deliveryGate) backgroundDelivery.release(current, deliveryGate);
      } catch (error) {
        if (deliveryGate) backgroundDelivery.discard(created.runId, deliveryGate);
        throw error;
      }
      if (isTerminalStatus(current.status) || current.status === "停止未确认" || (params.run_in_background && current.pendingQuestion)) {
        return taskToolResult(current, taskOutput(current));
      }
      if (params.run_in_background) {
        return taskToolResult(current, `${current.status === "选配中" ? "Jev 正在选配模型与思考强度。 " : ""}本轮在后台执行；可用上述 agentId 调用 SendMessage 或 TaskStop。${BACKGROUND_WAIT}`);
      }
      if (!current.turnId) throw new Error("任务启动后缺少 turnId，无法前台等待。");
      const completed = await waitForRunTurn(current.runId, current.turnId, {
        signal, stopOnAbort: true,
        onUpdate: (run) => onUpdate?.(taskToolResult(run, `前台等待中：${run.status}`)),
      });
      return taskToolResult(completed, taskOutput(completed));
    },

    renderCall(args, theme) {
      return new Text([
        theme.fg("toolTitle", theme.bold(`↗ 派遣 Agent：${args.resume ?? args.name ?? args.subagent_type ?? "general-purpose"}`)),
        theme.fg("muted", `  ${taskSummary(args.description ?? "等待任务", 100)}`),
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
        theme.fg("muted", `  ${taskSummary(runTitle(details), 100)}`),
      ].join("\n"), 0, 0);
    },
  };
  pi.registerTool(agentTool);
  refreshAgentTool = (ctx: any) => {
    const cwd = contextCwd(ctx), projectTrusted = isProjectTrusted(ctx);
    const images = imageSettingsDiagnostic(cwd, projectTrusted);
    agentTool.description = agentToolDescription(discoverAgents(cwd, { projectTrusted }), images.warning ? images.text : undefined);
    pi.registerTool(agentTool);
  };

  const handlePanelAction = async (action: AgentPanelAction, ctx: any): Promise<void> => {
    if (action.action === "关闭") return;
    if (action.action === "创建") { await createAgentFromDescription(pi, ctx); refreshAgentTool(ctx); return; }
    if (action.action === "配置") return openConfiguration("", ctx);
    const run = await readRun(action.runId);
    if (!run) return void ctx.ui.notify(`找不到运行：${action.runId}`, "error");
    if (run.parentSessionId !== ctx.sessionManager.getSessionId()) return void ctx.ui.notify("只能操作当前会话的任务。", "warning");
    if (action.action === "停止") {
      const approved = await ctx.ui.confirm(
        "停止子 Agent？",
        `${run.agentName}\n${run.objective}\n\n停止不会删除子 Session、结果或运行记录。`,
      );
      if (!approved) return;
      const stopped = await stopRun(run.runId, "panel-stop", run.turnId ?? null);
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
      const agents = discoverAgents(contextCwd(ctx), { projectTrusted: isProjectTrusted(ctx) });
      const definitionProblems = agents.flatMap((agent) => validateAgentDefinition(agent).map((error) => `${agent.id}：${error}`));
      const images = imageSettingsDiagnostic(contextCwd(ctx), isProjectTrusted(ctx));
      const runs = await listRuns(Number.MAX_SAFE_INTEGER, ctx.sessionManager.getSessionId());
      const lines = [
        `Agent Deck ${AGENT_DECK_VERSION} · 主 Pi 管理 RPC 子会话`,
        `Pi 宿主：${process.execPath} · ${process.version} · 模式：${ctx.mode}`,
        `项目：${contextCwd(ctx)} · 信任：${isProjectTrusted(ctx) ? "已信任" : "未信任（项目 Agent 已忽略）"}`,
        images.text,
        `当前会话任务：${runs.length} · 需求澄清与验收由主 Agent 负责`,
        `并发数量由主 Agent 与实际环境决定，不设产品级固定上限 · Jev 只选模型/思考：${readDeckConfig().routing.enabled ? "开启" : "关闭"}`,
        "正常结束只表示子运行完成；最终文本、失败、中断与进程资源分开记录，由主 Agent 阅读结果并验收。",
        "关闭或重载主 Pi 会结束它管理的子进程；会话记录保留，之后可由主 Agent 明确 resume 原任务。",
        ...definitionProblems.map((problem) => `• ${problem}`),
      ];
      ctx.ui.notify(lines.join("\n"), definitionProblems.length || images.warning ? "warning" : "info");    },
  });

  pi.registerCommand("agents", {
    description: "查看任务进度、真实子会话和结果",
    handler: async (_args, ctx) => openAgentPanel(ctx),
  });

  pi.registerCommand("agent-roles", {
    description: "查看可用的自定义 Agent",
    handler: async (_args, ctx) => {
      const trusted = isProjectTrusted(ctx);
      const agents = discoverAgents(contextCwd(ctx), { projectTrusted: trusted });
      const candidates = discoverAgentCandidates(contextCwd(ctx), { projectTrusted: trusted });
      const trustNotice = trusted
        ? "\n\n项目状态：已信任，项目 Agent 可以参与覆盖。"
        : "\n\n项目状态：未信任，已忽略项目级 .pi/agents。使用 /trust 后重启 Pi 才会加载。";
      const text = agents.length
        ? agents.map((agent) => {
            const chain = candidates.filter((candidate) => candidate.id === agent.id).map((candidate) => candidate.source);
            const override = chain.length > 1 ? `\n  覆盖链：${chain.join(" → ")}（当前使用 ${agent.source}）` : "";
            const timeout = agent.timeoutMs ?? readDeckConfig().timeoutMs;
            return `${agent.id}｜${agent.name}｜${agent.source}｜${agent.model ?? "继承或 Jev 选配"}\n  ${agent.description}\n  思考：${agent.thinking ?? "继承或 Jev 选配"} · 工具：${agent.tools?.join(", ") ?? "Pi 默认工具"}\n  排除工具：${agent.disallowedTools?.join(", ") || "无"} · 扩展：${agent.extensions.length} 项\n  时限：${timeout === 0 ? "不限时" : `${timeout} ms`}\n  文件：${agent.filePath}\n  编辑：/agent-config ${agent.id}${override}`;
          }).join("\n\n") + trustNotice
        : `没有发现 Agent 定义。${trustNotice}`;
      const visible = text;
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
        ? rows.map((item) => `${item.runId}｜${item.agentName}｜${item.status}｜${item.childSessionId.slice(0, 8)}\n  ${taskSummary(item.objective, 90)}`).join("\n\n")
        : "还没有子 Agent 运行记录。";
      ctx.ui.notify(text, "info");
    },
  });

}
