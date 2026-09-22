import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getAgentDir, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

test("本地依赖和当前已安装 Pi 的真实加载器均接受插件和配置命令", async () => {
  const installed = path.join(process.env.APPDATA ?? "", "npm/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
  const hosts: any[] = [{ DefaultResourceLoader, SettingsManager }];
  if (fs.existsSync(installed)) hosts.push(await import(pathToFileURL(installed).href));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("Offline host test must not request the network"); }) as typeof fetch;
  process.env.PI_OFFLINE = "1";
  try {
    for (const host of hosts) {
      const loader = new host.DefaultResourceLoader({ cwd: getAgentDir(), agentDir: getAgentDir(), settingsManager: host.SettingsManager.inMemory({}), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [path.resolve("src/index.ts")] });
      await loader.reload();
      const loaded = loader.getExtensions();
      assert.deepEqual(loaded.errors, []);
      assert.equal(loaded.extensions.length, 1);
      assert.deepEqual([...loaded.extensions[0].tools.keys()].sort(), ["Agent", "SendMessage", "TaskStop"]);
      for (const command of ["agent-create", "agent-config", "agent-deck", "agents", "agent-doctor", "agent-router", "agent-route-test"]) assert.ok(loaded.extensions[0].commands.has(command));
    }
  } finally { globalThis.fetch = previousFetch; }
});
