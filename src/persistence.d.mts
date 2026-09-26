import type { PersistedRun } from "./runtime.ts";
export function adaptStoredRun(raw: unknown): PersistedRun;
export function alive(pid: number | undefined): boolean;
export function readJson(file: string): Promise<any>;
export function atomicJson(file: string, value: unknown, options?: { mode?: number }): Promise<void>;
export function withDiskLock<T>(directory: string, action: () => Promise<T>): Promise<T>;
export function completionId(run: Partial<PersistedRun>): string;
export function persistCompletion(directory: string, run: Partial<PersistedRun>, options?: { overwrite?: boolean }): Promise<void>;
export function readCompletions(directory: string): Promise<PersistedRun[]>;
