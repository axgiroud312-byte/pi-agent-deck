import fs from "node:fs/promises";
import path from "node:path";
import { readRun, resumeRun } from "../../src/runtime.ts";

/** Faux RPC scripts do not persist Pi JSONL; give these unit fixtures a saved header.
 * Real-Pi tests use resumeRun directly, including missing-session rejection. */
export async function resumeFixtureRun(id: string, prompt: string) {
  const run = (await readRun(id))!;
  await fs.mkdir(path.dirname(run.childSessionPath), { recursive: true });
  try {
    await fs.writeFile(run.childSessionPath, JSON.stringify({ type: "session", version: 3, id: run.childSessionId, timestamp: new Date().toISOString(), cwd: run.cwd }) + "\n", { flag: "wx" });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return resumeRun(id, prompt);
}
