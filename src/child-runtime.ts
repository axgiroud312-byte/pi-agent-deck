import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerChildProviders } from "./child-providers.ts";

/** Provider bridge required by isolated child Pi processes. */
export default function childRuntime(pi: ExtensionAPI) {
  registerChildProviders(pi);
}
