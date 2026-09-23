import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

type ProviderConfigInput = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]>>;

interface ProviderSnapshot { version: 1; providers: Array<{ id: string; config: ProviderConfigInput }> }

/** Copy provider data only: loading the parent's extensions would also grant their tools/hooks. */
export function prepareChildProviders(registry: ExtensionContext["modelRegistry"], models: string[]): ProviderSnapshot {
  const providers: ProviderSnapshot["providers"] = [];
  for (const id of new Set(models.map((model) => model.slice(0, model.indexOf("/"))))) {
    if (registry.getRegisteredNativeProvider?.(id)) throw unsupportedProvider(id);
    const config = registry.getRegisteredProviderConfig?.(id);
    if (!config) continue; // Built-ins and models.json are already available in the child.
    const serialized = JSON.stringify(config, (_key, value) => {
      if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") throw unsupportedProvider(id);
      return value;
    });
    providers.push({ id, config: JSON.parse(serialized) });
  }
  return { version: 1, providers };
}

function unsupportedProvider(id: string): Error {
  return new Error(`模型提供商 ${id} 使用自定义函数或原生 Provider，暂不能传入独立子 Agent。请使用声明式 registerProvider 配置或 models.json；尚未创建任务。`);
}

export async function saveChildProviders(runId: string, snapshot: ProviderSnapshot): Promise<string | undefined> {
  if (!snapshot.providers.length) return undefined;
  // Like Pi's auth store, this is private user state, never part of task logs or release artifacts.
  const directory = path.join(getAgentDir(), "agent-deck", "providers");
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${runId}.json`);
  await fs.promises.writeFile(file, JSON.stringify(snapshot), { encoding: "utf8", flag: "wx", mode: 0o600 });
  return file;
}

export function registerChildProviders(pi: ExtensionAPI): void {
  const file = process.env.PI_AGENT_DECK_PROVIDERS;
  if (!file) return;
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8")) as ProviderSnapshot;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.providers)) throw new Error("子 Agent 的提供商快照格式无效。");
  for (const provider of snapshot.providers) pi.registerProvider(provider.id, provider.config);
}
