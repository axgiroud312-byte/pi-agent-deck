import type { PersistedRun } from "./runtime.ts";
export interface CapacityLease { directory: string; token: string; runId: string; agentId: string; createdAt: number; ownerPid: number; roleLimit?: number; }
export function alive(pid: number | undefined): boolean;
export function readJson(file: string): Promise<any>;
export function atomicJson(file: string, value: unknown, options?: { mode?: number }): Promise<void>;
export function withDiskLock<T>(directory: string, action: () => Promise<T>): Promise<T>;
export function completionId(run: Partial<PersistedRun>): string;
export function persistCompletion(directory: string, run: Partial<PersistedRun>): Promise<void>;
export function readCompletions(directory: string): Promise<PersistedRun[]>;
export function releaseCapacity(lease?: CapacityLease): Promise<void>;
export function releaseWriter(lease: { leasePath: string; runId: string; ownerToken: string }): Promise<boolean>;
