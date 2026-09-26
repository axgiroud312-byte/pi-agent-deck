import * as fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

function record(value: unknown): void {
  const file = process.env.PI_AGENT_DECK_FIXTURE_LOG;
  if (file) fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

export default function roleProbe(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "RoleProbe",
    label: "role extension probe",
    description: "Records a real role-selected extension tool invocation.",
    parameters: Type.Object({ value: Type.String() }),
    async execute(_id, params) {
      record({ type: "role_probe", value: params.value });
      return { content: [{ type: "text", text: `ROLE_PROBE_RESULT:${params.value}` }], details: { value: params.value } };
    },
  });
  pi.registerTool({
    name: "HiddenProbe",
    label: "excluded role extension probe",
    description: "Must remain unavailable when disallowedTools excludes it.",
    parameters: Type.Object({}),
    async execute() {
      record({ type: "hidden_probe_called" });
      return { content: [{ type: "text", text: "HIDDEN_PROBE_CALLED" }], details: {} };
    },
  });
}
