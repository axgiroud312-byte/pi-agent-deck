import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-tests-"));
process.env.PI_CODING_AGENT_DIR = directory;
// Test cases opt into a fake credential; never use the user's real TypeSafe account.
delete process.env.TYPESAFE_API_KEY;
process.on("exit", () => fs.rmSync(directory, { recursive: true, force: true }));
