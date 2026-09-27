import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersistedRun } from "./types.ts";
import { readRun, isTerminalStatus } from "./runtime.ts";
import { PARENT_MESSAGE, resultMessage, taskResultMessage, taskOutput } from "./delivery.ts";
import { taskMessage } from "./tool-contract.ts";
import {
  consumeMessages, inputMessageIds, messagesPath, readMessages, reconcileMessages,
  recordMessage, settleMessages, submitMessages, unsubmitMessages,
} from "./message-store.ts";

/** Durable transport evidence with process-local arbitration between tool and background delivery. */
export function createBackgroundDelivery(pi: Pick<ExtensionAPI, "sendMessage">, getContext: () => ExtensionContext | undefined) {
  // Claimed for a foreground result or submitted to Pi; consumption lives in the ledger.
  const claimed = new Set<string>();
  const delivering = new Map<string, Promise<void>>();
  type DeliveryGate = { holders: number; pending?: PersistedRun };
  const deliveryGates = new Map<string, DeliveryGate>();
  const reportError = (error: unknown): void => getContext()?.ui.setStatus("agent-deck-error", `Agent 消息记录或投递失败：${String(error)}`);
  const isActiveParent = (run: PersistedRun, ctx: ExtensionContext | undefined): ctx is ExtensionContext =>
    !!ctx && ctx === getContext() && run.parentSessionId === ctx.sessionManager.getSessionId();

  const recordOutput = async (run: PersistedRun) => {
    const message = taskResultMessage(run);
    if (!message) return;
    const record = await recordMessage(run, "to-parent", run.pendingQuestion?.message ?? taskOutput(run), message.details.deliveryId);
    return { message, record };
  };

  const sendOnce = (run: PersistedRun, id: string, operation: () => Promise<void>): Promise<void> => {
    const key = `${run.runId}/${id}`;
    const existing = delivering.get(key);
    if (existing) return existing;
    const pending = operation().finally(() => { if (delivering.get(key) === pending) delivering.delete(key); });
    delivering.set(key, pending);
    return pending;
  };

  const acquireDeliveryGate = (runId: string): DeliveryGate => {
    const existing = deliveryGates.get(runId);
    if (existing) { existing.holders++; return existing; }
    const gate: DeliveryGate = { holders: 1 };
    deliveryGates.set(runId, gate);
    return gate;
  };

  const retryBackgroundResult = (run: PersistedRun): void => {
    const id = taskResultMessage(run)?.details.deliveryId;
    const pending = id && delivering.get(`${run.runId}/${id}`);
    // Gate release can race an in-flight attempt rolling back its submission.
    // Wait for that attempt to leave sendOnce, then recheck durable state afresh.
    void Promise.resolve(pending).catch(() => {}).then(() => deliverBackgroundResult(run)).catch(reportError);
  };

  const discardDeliveryGate = (runId: string, gate: DeliveryGate): void => {
    if (deliveryGates.get(runId) !== gate) return;
    gate.holders = Math.max(0, gate.holders - 1);
    if (gate.holders > 0) return;
    deliveryGates.delete(runId);
    if (gate.pending) retryBackgroundResult(gate.pending);
  };

  const deliverBackgroundResult = async (run: PersistedRun): Promise<void> => {
    const output = taskResultMessage(run);
    if (!output) return;
    await sendOnce(run, output.details.deliveryId, async () => {
      const saved = await recordOutput(run);
      if (!saved) return;
      const { message, record } = saved;
      const key = message.details.deliveryId;
      if (claimed.has(key) || record.state !== "pending" || record.submittedAt) return;
      const ctx = getContext();
      if (!isActiveParent(run, ctx)) return;
      const current = await readRun(run.runId);
      if (!current || current.turnId !== run.turnId || current.status !== run.status
        || current.pendingQuestion?.id !== run.pendingQuestion?.id || !isActiveParent(run, ctx)) return;
      const gate = deliveryGates.get(run.runId);
      if (gate) { gate.pending = run; return; }
      await submitMessages(run.runId, [key]);
      if (claimed.has(key)) return; // A foreground tool claimed this result while its record was being written.
      const currentGate = deliveryGates.get(run.runId);
      if (!isActiveParent(run, ctx) || currentGate) {
        if (currentGate) currentGate.pending = run;
        await unsubmitMessages(run.runId, [key]);
        return;
      }
      try {
        pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
        claimed.add(key);
      } catch (error) {
        await settleMessages(run.runId, "to-parent", "unknown", `发送接口未确认：${String(error)}`, [key]);
        throw error;
      }
    });
  };

  const releaseDeliveryGate = (run: PersistedRun, expectedGate: DeliveryGate): void => {
    const gate = deliveryGates.get(run.runId);
    if (!gate || gate !== expectedGate) return;
    gate.holders = Math.max(0, gate.holders - 1);
    // A successful Agent call owns the initial delivery. Remove the shared gate
    // synchronously so later failed contenders cannot discard or publish it.
    deliveryGates.delete(run.runId);
    if (isTerminalStatus(run.status) || run.status === "停止未确认" || run.pendingQuestion) {
      const message = resultMessage(run, run.parentSessionId);
      if (message) claimed.add(message.details.deliveryId); // the Agent tool result owns this delivery
      return;
    }
    if (gate.pending) retryBackgroundResult(gate.pending);
  };

  const deliverProgress = async (run: PersistedRun, input: { id: string; message: string }): Promise<void> => {
    await sendOnce(run, input.id, async () => {
      const record = await recordMessage(run, "to-parent", input.message, input.id);
      if (record.state !== "pending" || record.submittedAt || claimed.has(input.id)) return;
      const ctx = getContext();
      if (!isActiveParent(run, ctx)) return;
      await submitMessages(run.runId, [input.id]);
      if (!isActiveParent(run, ctx)) {
        await unsubmitMessages(run.runId, [input.id]);
        return;
      }
      try {
        pi.sendMessage({
          customType: PARENT_MESSAGE,
          content: taskMessage(run, `子 Agent 消息：\n${input.message}`), display: true,
          details: { taskId: run.runId, turnId: run.turnId, messageId: input.id },
        }, { deliverAs: "followUp", triggerTurn: true });
        claimed.add(input.id);
      } catch (error) {
        await settleMessages(run.runId, "to-parent", "unknown", `发送接口未确认：${String(error)}`, [input.id]);
        throw error;
      }
    });
  };

  return {
    /** Pair notification ownership with the operation, including failure cleanup. */
    async withToolDelivery<T extends { run: PersistedRun }>(runId: string, operation: () => Promise<T>, enabled = true): Promise<T> {
      if (!enabled) return operation();
      const gate = acquireDeliveryGate(runId);
      try {
        const result = await operation();
        releaseDeliveryGate(result.run, gate);
        return result;
      } catch (error) {
        discardDeliveryGate(runId, gate);
        throw error;
      }
    },
    async notify(run: PersistedRun): Promise<void> {
      if (run.deliveryMode !== "background") return;
      const gate = deliveryGates.get(run.runId);
      if (gate) gate.pending = run;
      const saved = await recordOutput(run);
      if (!saved) return;
      if (run.completionSource === "shutdown" || run.completionSource === "tool-stop") {
        await settleMessages(run.runId, "to-parent", "closed", `任务结束来源：${run.completionSource}`, [saved.record.id]);
        return;
      }
      if (!gate) await deliverBackgroundResult(run);
    },
    progress: deliverProgress,
    async recordToolResult(run: PersistedRun): Promise<string | undefined> {
      const saved = await recordOutput(run);
      if (!saved) return;
      claimed.add(saved.record.id);
      await submitMessages(run.runId, [saved.record.id]);
      return saved.record.id;
    },
    async consume(message: unknown, parent: string): Promise<void> {
      const ids = inputMessageIds(message);
      if (!ids.length) return;
      if (!message || typeof message !== "object" || !("details" in message)) return;
      const details = message.details;
      if (!details || typeof details !== "object") return;
      const runDetails = "run" in details ? details.run : undefined;
      const taskId = "taskId" in details ? details.taskId : undefined;
      const runId = taskId ?? (runDetails && typeof runDetails === "object" && "runId" in runDetails ? runDetails.runId : undefined);
      if (typeof runId !== "string") return;
      const run = await readRun(runId);
      if (run?.parentSessionId === parent) await consumeMessages(runId, "to-parent", ids);
    },
    async recover(runs: PersistedRun[]): Promise<string[]> {
      const warnings: string[] = [];
      for (const run of runs) {
        await reconcileMessages(run, "to-parent");
        const records = await readMessages(run.runId);
        const output = taskResultMessage(run);
        const pending = records.filter(record => record.direction === "to-parent" && record.state === "pending" && !record.submittedAt);
        if (output && pending.some(record => record.id === output.details.deliveryId)) await deliverBackgroundResult(run);
        if (!isTerminalStatus(run.status)) for (const record of pending) {
          if (record.turnId === run.turnId && !record.id.includes(":")) await deliverProgress(run, { id: record.id, message: record.text });
        }
        const unsettled = (await readMessages(run.runId)).filter(record => ["pending", "unknown"].includes(record.state));
        if (unsettled.length) warnings.push(`${run.runId}：${unsettled.filter(record => record.state === "pending").length} 条待消费，${unsettled.filter(record => record.state === "unknown").length} 条待核实；消息记录：${messagesPath(run.runId)}`);
      }
      return warnings;
    },
    reset(): void { claimed.clear(); deliveryGates.clear(); },
  };
}
