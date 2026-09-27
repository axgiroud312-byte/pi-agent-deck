import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { atomicJson, withDiskLock } from "./persistence.mjs";
import { runDirectory } from "./run-store.ts";
import type { PersistedRun } from "./types.ts";

/** Transport evidence, independent of task acceptance. Native Pi owns conversation history. */
export interface MessageRecord {
  id: string;
  direction: "to-child" | "to-parent";
  turnId?: string;
  text: string;
  state: "pending" | "consumed" | "closed" | "unknown";
  createdAt: number;
  updatedAt: number;
  submittedAt?: number;
  reason?: string;
}

export const messagesPath = (runId: string): string => path.join(runDirectory(runId), "messages.json");
export function messageText(message: any): string {
  return typeof message?.content === "string" ? message.content
    : (message?.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n");
}
export function messageIds(text: string): string[] {
  return [...text.matchAll(/\[agent-deck-message:([a-zA-Z0-9_-]+)\]/g)].map(match => match[1]);
}
export const addressedMessage = (id: string, text: string): string => `[agent-deck-message:${id}]\n${text}`;

export async function readMessages(runId: string): Promise<MessageRecord[]> {
  try {
    const records = JSON.parse(await fs.readFile(messagesPath(runId), "utf8"));
    if (!Array.isArray(records) || records.some(record => !record || typeof record.id !== "string" || typeof record.text !== "string"
      || !["to-child", "to-parent"].includes(record.direction) || !["pending", "consumed", "closed", "unknown"].includes(record.state))) {
      throw new Error("消息记录格式无效");
    }
    return records;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

async function updateMessages<T>(runId: string, update: (records: MessageRecord[]) => T): Promise<T> {
  const file = messagesPath(runId);
  return withFileMutationQueue(file, () => withDiskLock(`${file}.lock`, async () => {
    const records = await readMessages(runId);
    const before = JSON.stringify(records);
    const result = update(records);
    if (JSON.stringify(records) !== before) await atomicJson(file, records);
    return result;
  }));
}

export async function recordMessage(run: Pick<PersistedRun, "runId" | "turnId">, direction: MessageRecord["direction"], text: string, id: string = randomUUID()): Promise<MessageRecord> {
  return updateMessages(run.runId, records => {
    const previous = records.find(record => record.id === id);
    if (previous) {
      if (previous.direction !== direction || previous.text !== text) throw new Error("消息编号已用于另一条消息");
      return { ...previous };
    }
    const record: MessageRecord = { id, direction, turnId: run.turnId, text, state: "pending", createdAt: Date.now(), updatedAt: Date.now() };
    records.push(record);
    return { ...record };
  });
}

export async function submitMessages(runId: string, ids: string[], turnId?: string): Promise<void> {
  await updateMessages(runId, records => {
    for (const record of records) if (ids.includes(record.id) && record.state === "pending") {
      record.submittedAt = Date.now(); record.updatedAt = Date.now();
      if (turnId) record.turnId = turnId;
    }
  });
}

/** The caller verified it never invoked the receiver (for example, the parent switched). */
export async function unsubmitMessages(runId: string, ids: string[]): Promise<void> {
  await updateMessages(runId, records => {
    for (const record of records) if (ids.includes(record.id) && record.state === "pending") {
      record.submittedAt = undefined; record.updatedAt = Date.now();
    }
  });
}

export async function consumeMessages(runId: string, direction: MessageRecord["direction"], ids: string[]): Promise<void> {
  if (!ids.length) return;
  await updateMessages(runId, records => {
    for (const record of records) if (record.direction === direction && ids.includes(record.id) && record.state !== "consumed") {
      record.state = "consumed"; record.updatedAt = Date.now(); record.reason = undefined;
    }
  });
}

export async function settleMessages(runId: string, direction: MessageRecord["direction"], state: "closed" | "unknown", reason: string, ids?: string[]): Promise<void> {
  await updateMessages(runId, records => {
    for (const record of records) if (record.direction === direction && ["pending", "unknown"].includes(record.state) && (!ids || ids.includes(record.id))) {
      record.state = state; record.reason = reason; record.updatedAt = Date.now();
    }
  });
}

/** Only input messages are evidence; an assistant quoting an ID is not an acknowledgement. */
export function inputMessageIds(message: any): string[] {
  if (!["user", "toolResult", "custom"].includes(message?.role)) return [];
  const ids = messageIds(messageText(message));
  const details = message.details;
  if (typeof details?.deliveryId === "string") ids.push(details.deliveryId);
  if (typeof details?.messageId === "string") ids.push(details.messageId);
  return ids;
}

/** Recover observable consumption, preserving ambiguity when a process died between writes. */
export async function reconcileMessages(run: PersistedRun, direction: MessageRecord["direction"]): Promise<void> {
  const records = (await readMessages(run.runId)).filter(record => record.direction === direction && record.state !== "consumed");
  if (!records.length) return;
  const file = direction === "to-child" ? run.childSessionPath : run.parentSessionPath;
  const consumed = new Set<string>();
  if (file) {
    let text: string;
    try { text = await fs.readFile(file, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; text = ""; }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let entry: any;
      try { entry = JSON.parse(line); } catch { continue; /* Interrupted final append carries no evidence. */ }
      const message = entry.type === "message" ? entry.message : entry.type === "custom_message" ? { ...entry, role: "custom" } : undefined;
      for (const id of inputMessageIds(message)) consumed.add(id);
    }
  }
  await consumeMessages(run.runId, direction, [...consumed]);
  const uncertain = records.filter(record => record.submittedAt && !consumed.has(record.id)).map(record => record.id);
  if (uncertain.length) await settleMessages(run.runId, direction, "unknown", "会话核对未找到消费证据；可核对原会话后决定续接。", uncertain);
}
