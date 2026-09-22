import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

test("多个 Pi 进程均能登记任务，不设置数量上限", async () => {
  const releaseFile = path.join(getAgentDir(), "release-fixtures");
  const capacity = pathToFileURL(path.resolve("src/capacity.ts")).href;
  const persistence = pathToFileURL(path.resolve("src/persistence.mjs")).href;
  const children: ReturnType<typeof spawn>[] = [];
  const exits: Promise<unknown>[] = [];
  try {
    const contenders = [0, 1, 2, 3].map((i) => new Promise<boolean>((resolve, reject) => {
      const source = `import fs from 'node:fs/promises';import {reserveCapacity} from ${JSON.stringify(capacity)};import {releaseCapacity} from ${JSON.stringify(persistence)};const result=await reserveCapacity('contender-${i}','fixture');console.log(JSON.stringify({acquired:!!result.lease}));const deadline=Date.now()+20000;while(Date.now()<deadline){try{await fs.access(${JSON.stringify(releaseFile)});break;}catch{}await new Promise(r=>setTimeout(r,30));}await releaseCapacity(result.lease);`;
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      children.push(child);
      let output = "", error = "";
      child.stdout!.on("data", (chunk) => { output += chunk; if (output.includes("\n")) { try { resolve(JSON.parse(output.trim()).acquired); } catch (e) { reject(e); } } });
      child.stderr!.on("data", (chunk) => { error += chunk; });
      child.on("error", reject);
      exits.push(new Promise((done) => child.on("close", (code) => { if (!output || code) reject(new Error(error || `Fixture exited ${code}`)); done(code); })));
    }));
    const results = await Promise.all(contenders);
    assert.equal(results.filter(Boolean).length, 4);
  } finally {
    await fs.writeFile(releaseFile, "done");
    await Promise.all(exits);
  }
});
