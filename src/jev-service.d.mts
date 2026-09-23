export type JevKeySource = "saved" | "environment" | "none";
export interface JevCredential { apiKey?: string; source: JevKeySource }
export function validateJevKey(value: string): string;
export function readSavedJevKey(file?: string): string | undefined;
export function resolveJevKey(file?: string, env?: Record<string, string | undefined>): JevCredential;
export function writeSavedJevKey(file: string, value: string | undefined, expected: string | undefined): Promise<void>;
export const JEV_MODEL_PATTERN: RegExp;
export const JEV_MODEL_OPTIONS: { value: string; label: string }[];
export function listJevModels(options: { apiKey: string; timeoutMs?: number; signal?: AbortSignal; fetch?: typeof fetch }): Promise<string[]>;
