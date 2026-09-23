import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";

/** One owned Pi process speaking Pi's existing JSONL RPC protocol. No message replay. */
export class RpcConnection {
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed: Promise<void>;
  stderr = "";
  private failure?: Error;
  private closing = false;
  private closePromise?: Promise<void>;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  constructor(command: string, args: string[], cwd: string, env: Record<string, string> | undefined,
    onEvent: (event: any) => void, onExit: (error: Error) => void) {
    this.child = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, shell: false, stdio: "pipe" });
    // Install every listener before awaiting anything: a local child may finish immediately.
    const parseLine = (line: string) => {
      let event: any;
      try { event = JSON.parse(line); } catch { return; }
      const request = event.type === "response" ? this.pending.get(event.id) : undefined;
      if (request) {
        this.pending.delete(event.id);
        clearTimeout(request.timer);
        if (event.success) request.resolve(event.data);
        else request.reject(new Error(event.error ?? `Pi RPC ${event.command} 失败`));
      } else onEvent(event);
    };
    // JSONL uses LF. Preserve CR, U+2028 and U+2029 inside JSON strings.
    let buffer = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let boundary: number;
      while ((boundary = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        parseLine(line);
      }
    });
    this.child.stderr.on("data", (data) => { this.stderr = (this.stderr + data.toString("utf8")).slice(-128 * 1024); });
    const failed = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
      this.pending.clear();
      if (!this.closing) onExit(error);
    };
    this.child.once("error", failed);
    this.child.stdin.on("error", failed);
    this.closed = new Promise((resolve) => this.child.once("close", (code, signal) => {
      failed(new Error(`子 Pi 已退出（${code ?? signal ?? "未知"}）${this.stderr ? `：${this.stderr}` : ""}`));
      resolve();
    }));
  }

  request(type: string, fields: Record<string, unknown> = {}, timeoutMs = 10000): Promise<any> {
    if (this.failure) return Promise.reject(this.failure);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi RPC ${type} 响应超时`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...fields, type, id }).catch((error) => {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      });
    });
  }

  reply(id: string, value?: string): Promise<void> {
    return this.write({ type: "extension_ui_response", id, ...(value === undefined ? { cancelled: true } : { value }) });
  }

  private write(value: unknown): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.child.stdin.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolve()));
  }

  close(): Promise<void> {
    return this.closePromise ??= this.closeOwned();
  }

  private async closeOwned(): Promise<void> {
    this.closing = true;
    this.child.stdin.end(); // Pi shuts its session down on EOF.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.closed, new Promise<void>((resolve) => { timer = setTimeout(resolve, 1500); })]);
    clearTimeout(timer);
    if (this.child.exitCode === null && this.child.signalCode === null) {
      if (process.platform === "win32" && this.child.pid) {
        await new Promise<void>((resolve) => {
          const killer = spawn("taskkill", ["/PID", String(this.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          killer.once("error", () => { this.child.kill(); resolve(); });
          killer.once("close", () => resolve());
        });
      } else this.child.kill("SIGKILL");
    }
    await this.closed;
  }
}
