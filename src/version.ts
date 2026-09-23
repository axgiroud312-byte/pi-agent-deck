import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const AGENT_DECK_VERSION = "0.9.2";
export const RUN_SCHEMA_VERSION = 1;
export const RUNNER_PROTOCOL_VERSION = 1;
export const CHILD_RUNTIME_PROTOCOL_VERSION = 1;

export function buildFingerprint(): string {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const hash = createHash("sha256");
  for (const name of ["config.ts", "tool-contract.ts", "task-identity.ts", "configuration-ui.ts", "config-editor.ts", "menu.ts", "presentation.ts", "agent-creation.ts", "agent-authoring.md", "agents.ts", "capacity.ts", "persistence.mjs", "index.ts", "runtime.ts", "runner.mjs", "router.mjs", "routing.ts", "routing-ui.ts", "model-profiles.json", "child-runtime.ts", "child-providers.ts", "admission.ts", "delivery.ts", "ui.ts", "instruction.ts"]) {
    try {
      hash.update(name);
      hash.update(fs.readFileSync(path.join(root, name)));
    } catch {
      hash.update(`${name}:missing`);
    }
  }
  return hash.digest("hex").slice(0, 12);
}

export const LOADED_BUILD_FINGERPRINT = buildFingerprint();

export function packageVersionFromDisk(): string | undefined {
  try {
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}
