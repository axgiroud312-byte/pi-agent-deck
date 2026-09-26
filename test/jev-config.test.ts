import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test, { beforeEach } from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_CONFIG, deckConfigPath, jevCredentialPath, parseDeckConfig, readDeckConfig, writeDeckConfig } from "../src/config.ts";
import { listJevModels, readSavedJevKey, resolveJevKey, validateJevKey, writeSavedJevKey } from "../src/jev-service.mjs";
import { editJevConfig, inputJevKey } from "../src/jev-ui.ts";
import { registerRouting } from "../src/routing-ui.ts";
import { registerConfiguration } from "../src/configuration-ui.ts";
import { listRuns } from "../src/runtime.ts";
import { chooseRenderedMenu } from "./menu-harness.ts";

const secret = "fake-test-only-secret-jev";
const theme: any = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text };
type Step = string | undefined | ((component: any) => void | Promise<void>);
function harness(steps: Step[], inputs: Array<string | undefined> = []) {
  const notices: string[] = [], screens: string[] = [];
  const models = ["gpt-5.6-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"].map((id) => ({ provider: "openai-codex", id, reasoning: true, api: "openai-codex-responses", thinkingLevelMap: { xhigh: "xhigh", max: "max" } }));
  const ctx: any = { mode: "tui", cwd: getAgentDir(), isProjectTrusted: () => false, model: models[2], modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id) },
    ui: { notify: (text: string) => notices.push(text), input: async () => inputs.shift(), editor: async () => inputs.shift(),
      custom: (factory: any) => new Promise((resolve, reject) => {
        let finished = false, driven = false, result: unknown;
        const component = factory({ terminal: { rows: 24 }, requestRender() {} }, theme, undefined, (value: unknown) => {
          finished = true; result = value; if (driven) resolve(result);
        });
        try {
          screens.push(component.render(90).join("\n"));
          assert.ok(steps.length, "Unexpected dialog: " + screens.at(-1));
          const step = steps.shift();
          void Promise.resolve(typeof step === "function" ? step(component) : chooseRenderedMenu(component, step)).then(() => {
            for (const width of [42, 60, 90]) {
              const lines = component.render(width); screens.push(lines.join("\n"));
              assert.ok(lines.every((line: string) => visibleWidth(line) <= width), "Dialog overflow");
            }
            driven = true; if (finished) resolve(result);
          }).catch(reject);
        } catch (error) { reject(error); }
      }),
    },
  };
  return { ctx, notices, screens, assertDone: () => { assert.equal(steps.length, 0); assert.equal(inputs.length, 0); assert.ok(![...screens, ...notices].join("\n").includes(secret)); } };
}
const paste = (value: string) => (component: any) => { component.handleInput("\u001b[200~" + value + "\u001b[201~"); component.handleInput("\r"); };
const waitForOperation = () => {};

beforeEach(async () => {
  delete process.env.TYPESAFE_API_KEY;
  await fs.rm(jevCredentialPath(), { force: true });
  await writeDeckConfig(structuredClone(DEFAULT_CONFIG));
});

test("本地密钥优先于环境变量；保存隔离、冲突保护和移除回退", async () => {
  const file = path.join(getAgentDir(), randomUUID(), "typesafe-auth.json");
  assert.deepEqual(resolveJevKey(file, {}), { source: "none", apiKey: undefined });
  assert.equal(resolveJevKey(file, { TYPESAFE_API_KEY: " env-key " }).source, "environment");
  await writeSavedJevKey(file, " " + secret + " ", undefined);
  assert.deepEqual(resolveJevKey(file, { TYPESAFE_API_KEY: "env-key" }), { source: "saved", apiKey: secret });
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(writeSavedJevKey(file, "replacement", undefined), /其他 Pi/);
  assert.equal(readSavedJevKey(file), secret);
  await writeSavedJevKey(file, undefined, secret);
  assert.equal(resolveJevKey(file, { TYPESAFE_API_KEY: "env-key" }).apiKey, "env-key");
  assert.ok(!(await fs.readFile(deckConfigPath(), "utf8")).includes(secret));
});

test("密钥校验和损坏文件错误不回显秘密；普通配置拒绝密钥字段", async () => {
  for (const value of ["", "a b", "a\nb", "中文", "x".repeat(4097)]) assert.throws(() => validateJevKey(value), /完整粘贴/);
  await fs.writeFile(jevCredentialPath(), '{"apiKey":"' + secret);
  assert.throws(() => readSavedJevKey(jevCredentialPath()), (error: any) => /无法读取/.test(error.message) && !error.message.includes(secret));
  assert.throws(() => parseDeckConfig({ routing: { apiKey: secret } }), /不支持/);
  for (const model of ["jev-preview", "jev-latest", "jev-1.13.0", "jev-2.0.1"]) assert.equal(parseDeckConfig({ routing: { model } }).routing.model, model);
  assert.throws(() => parseDeckConfig({ routing: { model: "https://other.example/jev" } }), /模型 ID/);
});

test("连接检查使用官方 GET 模型列表，不提交任务或调用推理", async (t) => {
  let count = 0;
  const server = createServer(async (req, res) => {
    count++; assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, `Bearer ${secret}`);
    let body = ""; for await (const chunk of req) body += chunk; assert.equal(body, "");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ models: [{ name: "jev-latest" }, { name: "jev-preview" }, { name: "jev-latest" }, { name: "unrelated" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await listJevModels({ apiKey: secret, fetch: (async (url, options) => {
    assert.equal(url, "https://api.typesafe.ai/v1/models"); assert.equal(options?.redirect, "error");
    return fetch(`http://127.0.0.1:${(server.address() as any).port}`, options);
  }) as typeof fetch });
  assert.deepEqual(response, ["jev-latest", "jev-preview"]); assert.equal(count, 1);
});

test("连接失败、异常响应、超时和取消均不误报成功或暴露服务端文本", async () => {
  for (const [status, message] of [[401, "密钥无效"], [403, "权限"], [429, "过于频繁"], [529, "繁忙"], [500, "HTTP 500"]] as const) {
    await assert.rejects(listJevModels({ apiKey: secret, fetch: (async () => new Response(secret, { status })) as typeof fetch }), (error: any) => error.message.includes(message) && !error.message.includes(secret));
  }
  for (const body of [{}, { models: [{ id: "jev-latest" }] }, { models: [] }]) {
    await assert.rejects(listJevModels({ apiKey: secret, fetch: (async () => Response.json(body)) as typeof fetch }), /格式不正确|没有返回/);
  }
  await assert.rejects(listJevModels({ apiKey: secret, fetch: (async () => { throw new Error(secret); }) as typeof fetch }), /无法连接 TypeSafe/);
  const hanging: typeof fetch = (_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true }));
  await assert.rejects(listJevModels({ apiKey: secret, timeoutMs: 10, fetch: hanging }), /超时/);
  const abort = new AbortController();
  const pending = listJevModels({ apiKey: secret, timeoutMs: 5000, signal: abort.signal, fetch: hanging });
  abort.abort(); await assert.rejects(pending, { name: "AbortError" });
});

test("密钥输入实际按键、粘贴、清空与取消，全程遮挡且不落盘", async () => {
  const h = harness([(component) => {
    component.handleInput("\u001b[200~" + secret + "\u001b[201~");
    const text = component.render(60).join("\n"); assert.match(text, /●/); assert.ok(!text.includes(secret));
    component.handleInput("\u0015"); assert.match(component.render(60).join("\n"), /已输入 0/);
    component.handleInput("\r"); assert.match(component.render(60).join("\n"), /完整粘贴/);
    paste(secret)(component);
  }]);
  assert.equal(await inputJevKey(h.ctx), secret); h.assertDone();
  const cancelled = harness([(component) => { component.handleInput(secret); component.handleInput("\u001b"); }]);
  assert.equal(await inputJevKey(cancelled.ctx), undefined); cancelled.assertDone();
  assert.equal(readSavedJevKey(jevCredentialPath()), undefined);
});

test("可视化配置保存模型、秒数与独立密钥；取消草稿不修改任何文件", async () => {
  const cancelled = harness(["① API 密钥", paste(secret), "② Jev 模型", "最新稳定版", "返回，不保存"]);
  await editJevConfig(cancelled.ctx); cancelled.assertDone();
  assert.equal(readSavedJevKey(jevCredentialPath()), undefined); assert.deepEqual(readDeckConfig(), DEFAULT_CONFIG);
  const h = harness(["① API 密钥", paste(secret), "② Jev 模型", "预览版", "等待时间", "自动选配", "关闭 Jev", "保存并返回"], ["30"]);
  await editJevConfig(h.ctx); h.assertDone();
  assert.deepEqual(readDeckConfig().routing, { enabled: false, model: "jev-preview", timeoutMs: 30000 });
  assert.equal(readSavedJevKey(jevCredentialPath()), secret);
  assert.ok(!(await fs.readFile(deckConfigPath(), "utf8")).includes(secret));
  process.env.TYPESAFE_API_KEY = "fake-inherited-key";
  const remove = harness(["移除本地密钥", "保存并返回"]);
  await editJevConfig(remove.ctx); remove.assertDone();
  assert.equal(resolveJevKey(jevCredentialPath()).source, "environment");
});

test("设置页连接检查真实调用元数据接口，成功仅代表读到列表，失败与取消更新状态", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
    assert.equal(url, "https://api.typesafe.ai/v1/models"); assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    return Response.json({ models: [{ name: "jev-latest" }] });
  });
  const h = harness(["① API 密钥", paste(secret), "③ 测试连接", waitForOperation, "返回，不保存"]);
  await editJevConfig(h.ctx); h.assertDone();
  assert.match(h.notices.join("\n"), /不提交任务/); assert.match(h.screens.join("\n"), /尚未试选/);
  assert.equal(readSavedJevKey(jevCredentialPath()), undefined);
  t.mock.method(globalThis, "fetch", async () => new Response(secret, { status: 401 }));
  const failed = harness(["① API 密钥", paste(secret), "③ 测试连接", waitForOperation, "返回，不保存"]);
  await editJevConfig(failed.ctx); failed.assertDone(); assert.match(failed.screens.join("\n"), /未通过/);
  t.mock.method(globalThis, "fetch", (_url: string, options: any) => new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason))));
  const cancelled = harness(["① API 密钥", paste(secret), "③ 测试连接", (component) => component.handleInput("\u001b"), "返回，不保存"]);
  await editJevConfig(cancelled.ctx); cancelled.assertDone(); assert.match(cancelled.screens.join("\n"), /已取消检查/);
});

test("草稿试选只选择当前 Pi 可用模型与思考组合，不创建子任务或打开开关", async (t) => {
  await writeDeckConfig({ routing: { enabled: false } });
  const before = (await listRuns()).length;
  let count = 0;
  t.mock.method(globalThis, "fetch", async (url: string, options: any) => {
    count++; assert.equal(url, "https://api.typesafe.ai/v1/systemone"); assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    const body = JSON.parse(options.body); assert.equal(body.model, "jev-1.13.0");
    const criteria = body.questions.execution_profile.criteria;
    const keys = Object.keys(criteria);
    const selected = Object.entries(criteria).find(([id, text]) => id !== "no_match" && String(text).includes("openai-codex/gpt-6-astra with max thinking"))?.[0];
    assert.ok(selected);
    assert.ok(!options.body.includes(secret));
    return Response.json({ model: "jev-1.13.0", answers: { execution_profile: { type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(keys.map((id) => [id, id === selected ? 1 : 0])) } } });
  });
  const h = harness(["① API 密钥", paste(secret), "试选一次", "代码审查员", waitForOperation, "返回，不保存"], ["审查登录模块的边界条件"]);
  await editJevConfig(h.ctx, () => "high"); h.assertDone();
  assert.equal(count, 1); assert.match(h.notices.join("\n"), /gpt-6-astra/); assert.match(h.notices.join("\n"), /max/);
  assert.equal(readDeckConfig().routing.enabled, false); assert.equal((await listRuns()).length, before); assert.equal(readSavedJevKey(jevCredentialPath()), undefined);
});

test("保存只合并用户改变的字段，外部密钥更改会阻止覆盖", async () => {
  const h = harness(["② Jev 模型", "最新稳定版", async (component) => {
    await writeDeckConfig({ enabled: false, routing: { timeoutMs: 32000, enabled: false } });
    chooseRenderedMenu(component, "保存并返回");
  }]);
  await editJevConfig(h.ctx); h.assertDone();
  assert.deepEqual(readDeckConfig().routing, { model: "jev-latest", timeoutMs: 32000, enabled: false }); assert.equal(readDeckConfig().enabled, false);
  const conflict = harness(["① API 密钥", paste(secret), async (component) => {
    await writeSavedJevKey(jevCredentialPath(), "another-pi-key", undefined);
    chooseRenderedMenu(component, "保存并返回");
  }, "返回，不保存"]);
  await editJevConfig(conflict.ctx); conflict.assertDone();
  assert.equal(readSavedJevKey(jevCredentialPath()), "another-pi-key"); assert.match(conflict.notices.join("\n"), /其他 Pi/);
});

test("两条配置命令进入同一页；非交互状态命令保持可用", async () => {
  const commands = new Map<string, any>();
  const pi: any = { registerCommand: (name: string, value: any) => commands.set(name, value), getThinkingLevel: () => "high" };
  registerRouting(pi); registerConfiguration(pi, () => {});
  for (const [command, args, steps] of [["agent-router", "", [undefined]], ["agent-config", "jev", [undefined]], ["agent-config", "", ["Jev：", undefined]]] as const) {
    const h = harness([...steps]); await commands.get(command).handler(args, h.ctx); h.assertDone(); assert.match(h.screens.join("\n"), /Jev 配置/);
  }
  const h = harness([]); h.ctx.mode = "rpc";
  await commands.get("agent-router").handler("", h.ctx); h.assertDone(); assert.match(h.notices.join("\n"), /未配置/);
});
