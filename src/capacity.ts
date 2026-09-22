import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { atomicJson, type CapacityLease } from "./persistence.mjs";

/** Compatibility run ownership record. No global or per-role quantity limit. */
export async function reserveCapacity(runId: string, agentId: string): Promise<{ lease: CapacityLease; reason?: string }> {
  const directory = path.join(getAgentDir(), "agent-deck", "capacity");
  const lease: CapacityLease = { directory, token: randomUUID(), runId, agentId, createdAt: Date.now(), ownerPid: process.pid };
  await atomicJson(path.join(directory, `${lease.token}.json`), lease);
  return { lease };
}
