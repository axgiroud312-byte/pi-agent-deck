import type { PersistedRun, RunDetails } from "./types.ts";
export function adaptStoredRun(raw: unknown): PersistedRun;
export function alive(pid: number | undefined): boolean;
export function readJson(file: string): Promise<any>;
export function atomicJson(file: string, value: unknown, options?: { mode?: number }): Promise<void>;
export function withDiskLock<T>(directory: string, action: () => Promise<T>): Promise<T>;
export function completionId(run: Partial<PersistedRun>): string;
export function completionOutput(run: Partial<PersistedRun>): string;
/** Returns a durable report path; leaves the supplied snapshot unchanged. */
export function persistCompletion(directory: string, run: Readonly<Partial<PersistedRun>>, options?: { overwrite?: boolean }): Promise<string | undefined>;
export function readCompletions(directory: string): Promise<Readonly<RunDetails>[]>;
