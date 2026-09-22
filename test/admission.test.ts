import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { acquireWriterLease, releaseWriterLease, writerLeasePath } from "../src/admission.ts";

const admissionUrl = pathToFileURL(path.resolve("src/admission.ts")).href;

function runLeaseContender(cwd: string, runId: string): Promise<{ acquired: boolean; runId: string }> {
  const source = [
    `import { acquireWriterLease, releaseWriterLease } from ${JSON.stringify(admissionUrl)};`,
    `const result = await acquireWriterLease(${JSON.stringify(cwd)}, ${JSON.stringify(runId)});`,
    `console.log(JSON.stringify({ acquired: result.acquired, runId: ${JSON.stringify(runId)} }));`,
    `if (result.acquired) { await new Promise(r => setTimeout(r, 800)); await releaseWriterLease(result.lease); }`,
  ].join("\n");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
      cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `lease contender exited ${code}`));
      else resolve(JSON.parse(stdout.trim()));
    });
    child.on("error", reject);
  });
}

test("跨进程竞争同一 cwd writer lease 时恰好一个成功", async (t) => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-writer-lease-"));
  t.after(() => {
    fs.rmSync(writerLeasePath(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const results = await Promise.all([
    runLeaseContender(cwd, "run-a"),
    runLeaseContender(cwd, "run-b"),
  ]);
  assert.equal(results.filter((item) => item.acquired).length, 1);
});

test("writer lease 只能由匹配 owner token 释放", async (t) => {
  const cwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), "agent-deck-writer-owner-"));
  t.after(() => {
    fs.rmSync(writerLeasePath(cwd), { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const result = await acquireWriterLease(cwd, "owner-run");
  assert.equal(result.acquired, true);
  if (!result.acquired) return;
  assert.equal(await releaseWriterLease({ ...result.lease, ownerToken: "wrong" }), false);
  assert.equal(fs.existsSync(result.lease.leasePath), true);
  await fs.promises.writeFile(path.join(result.lease.leasePath, `release-${result.lease.ownerToken}`), "stale marker", "utf8");
  assert.equal(await releaseWriterLease(result.lease), true);
  assert.equal(fs.existsSync(result.lease.leasePath), false);
});
