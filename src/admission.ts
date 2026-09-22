import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { withDiskLock, releaseWriter } from "./persistence.mjs";

export interface WriterLease {
  version: 1;
  runId: string;
  ownerToken: string;
  cwd: string;
  leasePath: string;
  createdAt: number;
}

export interface WriterLeaseConflict {
  acquired: false;
  existing?: Partial<WriterLease>;
  leasePath: string;
}

export interface WriterLeaseAcquired {
  acquired: true;
  lease: WriterLease;
}

export type WriterLeaseResult = WriterLeaseAcquired | WriterLeaseConflict;

export function canonicalizeCwd(cwd: string): string {
  let resolved = path.resolve(cwd);
  try { resolved = fs.realpathSync.native(resolved); } catch { /* 保留规范化绝对路径 */ }
  resolved = path.normalize(resolved);
  return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
}

export function workspaceRoot(cwd: string): string {
  const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  return canonicalizeCwd(git.status === 0 && git.stdout.trim() ? git.stdout.trim() : cwd);
}
function overlaps(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  };
  return contains(a, b) || contains(b, a);
}

function writerLeasesRoot(): string {
  return path.join(getAgentDir(), "agent-deck", "writer-leases");
}

export function writerLeasePath(cwd: string): string {
  const canonical = workspaceRoot(cwd);
  const key = createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return path.join(writerLeasesRoot(), key);
}

function readLeaseFile(leasePath: string): Partial<WriterLease> | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(leasePath, "lease.json"), "utf8")) as Partial<WriterLease>;
  } catch {
    return undefined;
  }
}

export async function acquireWriterLease(cwd: string, runId: string): Promise<WriterLeaseResult> {
  return withDiskLock(path.join(getAgentDir(), "agent-deck", "writers.lock"), () => acquireUnlocked(cwd, runId));
}
async function acquireUnlocked(cwd: string, runId: string): Promise<WriterLeaseResult> {
  const canonical = workspaceRoot(cwd);
  const leasePath = writerLeasePath(canonical);
  for (const item of listWriterLeases()) {
    if (!item.lease?.cwd || overlaps(canonical, canonicalizeCwd(item.lease.cwd))) return { acquired: false, existing: item.lease, leasePath: item.leasePath };
  }
  await fs.promises.mkdir(path.dirname(leasePath), { recursive: true });
  try {
    await fs.promises.mkdir(leasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return { acquired: false, existing: readLeaseFile(leasePath), leasePath };
  }

  const lease: WriterLease = {
    version: 1,
    runId,
    ownerToken: randomUUID(),
    cwd: canonical,
    leasePath,
    createdAt: Date.now(),
  };
  try {
    const temporary = path.join(leasePath, `lease.${process.pid}.${Date.now()}.tmp`);
    await fs.promises.writeFile(temporary, `${JSON.stringify(lease, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, path.join(leasePath, "lease.json"));
    return { acquired: true, lease };
  } catch (error) {
    await fs.promises.rm(leasePath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function releaseWriterLease(lease: WriterLease): Promise<boolean> {
  return releaseWriter(lease);
}

export function listWriterLeases(): Array<{ leasePath: string; lease?: Partial<WriterLease> }> {
  try {
    return fs.readdirSync(writerLeasesRoot(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.includes(".retired-"))
      .map((entry) => {
        const leasePath = path.join(writerLeasesRoot(), entry.name);
        return { leasePath, lease: readLeaseFile(leasePath) };
      });
  } catch {
    return [];
  }
}
