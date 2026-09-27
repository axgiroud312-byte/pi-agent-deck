import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Usage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, RunDetails, PersistedRun } from "./types.ts";
import type { AgentInput } from "./tool-contract.ts";
import type { RoutingPlan } from "./router.mjs";
import { buildChildSystemPrompt, buildTaskText, taskSummary } from "./instruction.ts";
import { initializeRun, discardUninitializedRun, type RunnerRequest } from "./runtime.ts";
import { runDirectory } from "./run-store.ts";
import { withTaskCreation } from "./task-identity.ts";
import { saveChildProviders, type prepareChildProviders } from "./child-providers.ts";

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

/** Prepare one owned child session; failed creation cleans up only its own artifacts. */
export async function createTask({ agent, params, cwd, parentSessionId: parent, parentSessionPath, routing, providers, timeoutMs }: {
  agent: AgentDefinition;
  params: Extract<AgentInput, { resume?: undefined }>;
  cwd: string;
  parentSessionId: string;
  parentSessionPath?: string;
  routing: RoutingPlan;
  providers: ReturnType<typeof prepareChildProviders>;
  timeoutMs: number;
}): Promise<PersistedRun> {
  const resolved = routing.immediate ?? routing.fallback;
  return withTaskCreation(parent, params.name, async () => {
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
      details.events.push({ at: Date.now(), kind: "状态", text: "已创建独立子 Session" });
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
        timeoutMs,
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
}
