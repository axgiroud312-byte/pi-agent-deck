import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PersistedRun } from "./types.ts";
import { readRun, isTerminalStatus } from "./runtime.ts";
import { resultMessage } from "./delivery.ts";

/** Process-local delivery coordination; never replays historical results on reload. */
export function createBackgroundDelivery(pi: Pick<ExtensionAPI, "sendMessage">, getContext: () => ExtensionContext | undefined) {
  // This registry is scoped to the current Pi process; message acceptance is not model consumption.
  const delivered = new Set<string>();
  type DeliveryGate = { holders: number; pending?: PersistedRun };
  const deliveryGates = new Map<string, DeliveryGate>();

  const acquireDeliveryGate = (runId: string): DeliveryGate => {
    const existing = deliveryGates.get(runId);
    if (existing) { existing.holders++; return existing; }
    const gate: DeliveryGate = { holders: 1 };
    deliveryGates.set(runId, gate);
    return gate;
  };

  const discardDeliveryGate = (runId: string, gate: DeliveryGate): void => {
    if (deliveryGates.get(runId) !== gate) return;
    gate.holders = Math.max(0, gate.holders - 1);
    if (gate.holders > 0) return;
    deliveryGates.delete(runId);
    if (gate.pending) void deliverBackgroundResult(gate.pending).catch((error) => getContext()?.ui.setStatus("agent-deck-error", `Agent 结果通知投递失败：${String(error)}`));
  };

  const deliverBackgroundResult = async (run: PersistedRun): Promise<void> => {
    const ctx = getContext();
    if (!ctx || run.parentSessionId !== ctx.sessionManager.getSessionId()) return;
    const current = await readRun(run.runId);
    if (!current || current.turnId !== run.turnId || current.status !== run.status
      || current.pendingQuestion?.id !== run.pendingQuestion?.id || ctx !== getContext()) return;
    const message = resultMessage(run, run.parentSessionId);
    if (!message) return;
    const key = message.details.deliveryId;
    if (delivered.has(key)) return;
    pi.sendMessage(message, { deliverAs: "followUp", triggerTurn: true });
    delivered.add(key);
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
      if (message) delivered.add(message.details.deliveryId); // the Agent tool result owns this delivery
      return;
    }
    if (gate.pending) void deliverBackgroundResult(gate.pending).catch((error) => getContext()?.ui.setStatus("agent-deck-error", `Agent 结果通知投递失败：${String(error)}`));
  };

  return {
    acquire: acquireDeliveryGate,
    release: releaseDeliveryGate,
    discard: discardDeliveryGate,
    notify(run: PersistedRun): void {
      if (run.completionSource === "shutdown" || run.completionSource === "tool-stop") return;
      const gate = deliveryGates.get(run.runId);
      if (gate) gate.pending = run;
      else void deliverBackgroundResult(run).catch((error) => getContext()?.ui.setStatus("agent-deck-error", `Agent 结果通知投递失败：${String(error)}`));
    },
    reset(): void { delivered.clear(); deliveryGates.clear(); },
  };
}
