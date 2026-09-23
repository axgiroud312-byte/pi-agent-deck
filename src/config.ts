import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { JEV_MODEL_PATTERN } from "./jev-service.mjs";
import { atomicJson, withDiskLock } from "./persistence.mjs";

export interface DeckConfig {
  enabled: boolean;
  timeoutMs: number;
  routing: { enabled: boolean; model: string; timeoutMs: number };
  modelAliases: Record<string, string>;
}

export const DEFAULT_CONFIG: DeckConfig = { enabled: true, timeoutMs: 0, routing: { enabled: true, model: "jev-1.13.0", timeoutMs: 15000 }, modelAliases: {} };
export function deckConfigPath(): string {
  return path.join(getAgentDir(), "agent-deck", "config.json");
}
export function jevCredentialPath(): string { return path.join(getAgentDir(), "agent-deck", "typesafe-auth.json"); }
export type DeckConfigPatch = Omit<Partial<DeckConfig>, "routing"> & { routing?: Partial<DeckConfig["routing"]> };
export function parseDeckConfig(value: unknown): DeckConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("设置必须是 JSON 对象。");
  const input = value as Record<string, unknown>;
  // Legacy quantity limits are accepted for migration and deliberately discarded.
  for (const key of Object.keys(input)) if (!Object.hasOwn(DEFAULT_CONFIG, key) && key !== "maxConcurrent") throw new Error(`不支持的设置：${key}`);
  const { maxConcurrent: _ignored, ...values } = input;
  if (values.routing !== undefined && (!values.routing || typeof values.routing !== "object" || Array.isArray(values.routing))) throw new Error("routing 必须是 JSON 对象。");
  const routing = { ...DEFAULT_CONFIG.routing, ...(values.routing as object ?? {}) };
  for (const key of Object.keys(routing)) if (!(key in DEFAULT_CONFIG.routing)) throw new Error(`不支持的选配设置：${key}`);
  const aliases = values.modelAliases === undefined ? {} : values.modelAliases;
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) throw new Error("modelAliases 必须是别名到 provider/model 的 JSON 对象。");
  for (const [alias, model] of Object.entries(aliases)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(alias) || typeof model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(model)) throw new Error(`无效的模型别名 ${alias}：必须明确映射到 provider/model。`);
  }
  const config = { ...DEFAULT_CONFIG, ...values, routing, modelAliases: { ...aliases } } as DeckConfig;
  if (typeof config.enabled !== "boolean") throw new Error("enabled 必须是 true 或 false。");
  if (typeof routing.enabled !== "boolean") throw new Error("routing.enabled 必须是 true 或 false。");
  if (typeof routing.model !== "string" || !JEV_MODEL_PATTERN.test(routing.model)) throw new Error("routing.model 必须是 Jev 模型 ID，例如 jev-1.13.0。");
  if (!Number.isSafeInteger(routing.timeoutMs) || routing.timeoutMs < 1) throw new Error("routing.timeoutMs 必须是正整数毫秒。");
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 0) throw new Error("timeoutMs 必须是非负整数；0 表示不限时。");
  return config;
}
export function readDeckConfig(): DeckConfig {
  try { return parseDeckConfig(JSON.parse(fs.readFileSync(deckConfigPath(), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw new Error(`Agent 设置无效：${error instanceof Error ? error.message : error}`);
  }
}
export async function writeDeckConfig(changes: DeckConfigPatch): Promise<void> {
  const file = deckConfigPath();
  await withFileMutationQueue(file, () => withDiskLock(`${file}.lock`, async () => {
    const current = readDeckConfig();
    const config = parseDeckConfig({ ...current, ...changes, routing: { ...current.routing, ...changes.routing } });
    await atomicJson(file, config);
  }));
}
