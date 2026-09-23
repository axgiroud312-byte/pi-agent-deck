import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CancellableLoader, Input, Key, matchesKey } from "@earendil-works/pi-tui";
import { discoverAgents, validateAgentDefinition } from "./agents.ts";
import { jevCredentialPath, parseDeckConfig, readDeckConfig, writeDeckConfig, type DeckConfig } from "./config.ts";
import { JEV_MODEL_OPTIONS, JEV_MODEL_PATTERN, listJevModels, readSavedJevKey, resolveJevKey, validateJevKey, writeSavedJevKey, type JevCredential } from "./jev-service.mjs";
import { selectMenu } from "./menu.ts";
import { frame } from "./presentation.ts";
import { prepareRouting } from "./routing.ts";
import { decisionText, selectExecution, type RoutingDecision, type RoutingPlan } from "./router.mjs";

const errorText = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";

export async function cancellable<T>(ctx: ExtensionContext, title: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
  if (ctx.mode !== "tui") return operation(new AbortController().signal);
  type Result = { value: T } | { error: unknown } | undefined;
  const result = await ctx.ui.custom<Result>((tui, theme, _keys, done) => {
    const loader = new CancellableLoader(tui, (text) => theme.fg("accent", text), (text) => theme.fg("muted", text), `${title}… Esc 取消`);
    let settled = false;
    const finish = (value: Result) => { if (!settled) { settled = true; loader.stop(); done(value); } };
    loader.onAbort = () => finish(undefined);
    void operation(loader.signal).then(
      (value) => { if (!loader.aborted) finish({ value }); },
      (error: unknown) => { if (!loader.aborted) finish({ error }); },
    );
    return loader;
  });
  if (result && "error" in result) throw result.error;
  return result?.value;
}

export function previewRouting(plan: RoutingPlan, ctx: ExtensionContext, apiKey?: string): Promise<RoutingDecision | undefined> {
  return cancellable(ctx, "正在试选模型", (signal) => selectExecution(plan, { apiKey, signal }));
}

/** Input handles terminal paste/editing; its unmasked renderer is never used. */
export async function inputJevKey(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
    const input = new Input();
    let error = "";
    input.onEscape = () => { input.setValue(""); done(undefined); };
    input.onSubmit = (value) => {
      try { const key = validateJevKey(value); input.setValue(""); done(key); }
      catch (failure) { error = errorText(failure); tui.requestRender(); }
    };
    return {
      render(width: number) {
        const length = input.getValue().length;
        return frame(theme.fg("accent", "输入 TypeSafe API 密钥"), [
          "粘贴密钥，内容始终遮挡。", "",
          length ? "●".repeat(Math.min(length, Math.max(1, width - 6))) : theme.fg("muted", "等待粘贴…"),
          `已输入 ${length} 个字符`,
          ...(error ? [theme.fg("error", error)] : []), "",
          "Enter 应用到草稿 · Esc 取消", "Ctrl+U 清空 · 在配置页保存后生效",
        ], width, theme);
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.ctrl("u"))) { input.setValue(""); error = ""; }
        else input.handleInput(data);
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}

function credentialLabel(value: JevCredential, pending: string | null | undefined): string {
  if (typeof pending === "string") return "已填写 · 待保存";
  if (pending === null) return value.apiKey ? "待移除本地密钥 · 将使用环境变量" : "待移除 · 将回退";
  return value.source === "saved" ? "已配置 · 本机保存" : value.source === "environment" ? "已检测到 · 环境变量" : "未配置";
}

export async function editJevConfig(ctx: ExtensionContext, getThinkingLevel: () => ThinkingLevel = () => "off"): Promise<void> {
  if (ctx.mode !== "tui") { ctx.ui.notify("请在 Pi 交互终端输入 /agent-router 打开 Jev 配置。", "info"); return; }
  const file = jevCredentialPath();
  const original = readDeckConfig().routing;
  let draft = { ...original };
  let savedKey = readSavedJevKey(file);
  let pendingKey: string | null | undefined;
  let connection = "尚未检查";
  let available: string[] = [];
  let selected: string | undefined;
  let lastCredential: string | undefined;
  const credential = (): JevCredential => typeof pendingKey === "string" ? { apiKey: pendingKey, source: "saved" }
    : pendingKey === null ? resolveJevKey(undefined) : resolveJevKey(file);
  while (true) {
    const active = credential();
    if (active.apiKey !== lastCredential) { connection = "尚未检查"; available = []; lastCredential = active.apiKey; }
    const dirty = JSON.stringify(draft) !== JSON.stringify(original) || pendingKey !== undefined;
    const action = await selectMenu(ctx, `Jev 配置${dirty ? " · 未保存" : ""}`, [
      { value: "key", label: `① API 密钥    ${credentialLabel(active, pendingKey)}` },
      { value: "model", label: `② Jev 模型    ${draft.model}` },
      { value: "connect", label: `③ 测试连接    ${connection}` },
      { value: "trial", label: "试选一次      查看模型与强度（不创建任务）" },
      { value: "enabled", label: `自动选配      ${draft.enabled ? "开启" : "关闭"}` },
      { value: "timeout", label: `等待时间      ${draft.timeoutMs / 1000} 秒` },
      { value: "help", label: "获取密钥 / 配置帮助" },
      ...(savedKey || typeof pendingKey === "string" ? [{ value: "remove", label: "移除本地密钥（保存后生效）" }] : []),
      { value: "save", label: "保存并返回" }, { value: "cancel", label: "返回，不保存" },
    ], selected);
    if (!action || action === "cancel") return;
    selected = action;
    try {
      if (action === "key") {
        const key = await inputJevKey(ctx);
        if (key !== undefined) { pendingKey = key === savedKey ? undefined : key; connection = "尚未检查"; }
      } else if (action === "remove") {
        pendingKey = savedKey ? null : undefined;
        connection = "尚未检查";
      } else if (action === "model") {
        const known = JEV_MODEL_OPTIONS.map((item) => item.value);
        const extras = [...new Set([draft.model, ...available])].filter((id) => !known.includes(id));
        const model = await selectMenu(ctx, "选择 Jev 模型", [
          ...JEV_MODEL_OPTIONS, ...extras.map((id) => ({ value: id, label: id })),
          { value: "custom", label: "手动填写官方版本 ID" },
        ], draft.model);
        if (model) {
          const value = model === "custom" ? (await ctx.ui.input("官方 Jev 版本，例如 jev-1.13.0", draft.model))?.trim() : model;
          if (value !== undefined) {
            if (!JEV_MODEL_PATTERN.test(value)) throw new Error("请输入 jev-latest、jev-preview 或 jev-数字.数字.数字。");
            if (value !== draft.model) { draft.model = value; connection = "尚未检查"; }
          }
        }
      } else if (action === "enabled") {
        const value = await selectMenu(ctx, "为新任务自动选择模型与思考强度", [
          { value: true, label: "开启 Jev 自动选配" }, { value: false, label: "关闭 Jev，使用合规回退配置" },
        ], draft.enabled);
        if (value !== undefined) draft.enabled = value;
      } else if (action === "timeout") {
        const text = await ctx.ui.input("最多等待多少秒？默认 15 秒", String(draft.timeoutMs / 1000));
        if (text !== undefined) {
          const seconds = Number(text);
          if (!text.trim() || !Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2147483) throw new Error("等待时间需为至少 1 秒的整数。");
          draft.timeoutMs = seconds * 1000;
        }
      } else if (action === "connect") {
        if (!active.apiKey) throw new Error("请先填写 API 密钥，再测试连接。");
        connection = "检查中";
        const models = await cancellable(ctx, "正在检查 TypeSafe 连接", (signal) => listJevModels({ apiKey: active.apiKey!, timeoutMs: draft.timeoutMs, signal }));
        if (models) {
          available = models;
          connection = "已通过 · 尚未试选";
          ctx.ui.notify("连接检查通过，已读取账户的 Jev 模型列表。\n这一步不提交任务；要验证当前模型能否选配，可点击“试选一次”。", "info");
        } else connection = "已取消检查";
      } else if (action === "trial") {
        if (!active.apiKey) throw new Error("请先填写 API 密钥，再试选。");
        const agents = discoverAgents(ctx.cwd, { projectTrusted: ctx.isProjectTrusted() });
        const id = await selectMenu(ctx, "选择试选角色", agents.map((agent) => ({ value: agent.id, label: `${agent.name} · ${agent.id}` })));
        const agent = agents.find((item) => item.id === id);
        if (!agent) continue;
        const task = (await ctx.ui.editor("输入试选任务（会提交给 TypeSafe，不创建子任务）", ""))?.trim();
        if (!task) continue;
        const errors = validateAgentDefinition(agent);
        if (errors.length) throw new Error(errors.join("；"));
        const config: DeckConfig = { ...readDeckConfig(), routing: { ...draft, enabled: true } };
        const plan = prepareRouting(agent, task, ctx, config, getThinkingLevel());
        const decision = await previewRouting(plan, ctx, active.apiKey);
        if (decision) {
          if (decision.mode === "jev") connection = "已通过 · 试选成功";
          else if (decision.mode === "fallback") connection = "试选未通过 · 已回退";
          ctx.ui.notify(`试选结果 · ${agent.name}\n${decisionText(decision)}\n${decision.mode === "fixed" ? "只有固定组合，本次未请求 Jev。\n" : ""}未创建子任务，也没有改变开关。`, decision.mode === "fallback" ? "warning" : "info");
        } else { connection = "已取消试选"; ctx.ui.notify("已取消试选，未创建子任务。", "info"); }
      } else if (action === "help") {
        ctx.ui.notify("1. 打开 https://console.typesafe.ai/，登录后在控制台创建 API 密钥。\n2. 在本页填写密钥、选择模型并测试连接，然后保存。\n本地保存的密钥优先于 TYPESAFE_API_KEY；密钥单独保存在个人 Pi 目录，不进入普通配置和任务记录。\n本页只配置 Jev；需要派遣子任务时使用 /agent-deck on。", "info");
      } else if (action === "save") {
        parseDeckConfig({ ...readDeckConfig(), routing: draft });
        const patch = Object.fromEntries(Object.entries(draft).filter(([key, value]) => original[key as keyof typeof original] !== value));
        let keySaved = false;
        if (pendingKey !== undefined) {
          await writeSavedJevKey(file, pendingKey ?? undefined, savedKey);
          savedKey = pendingKey ?? undefined;
          pendingKey = undefined;
          keySaved = true;
        }
        try { if (Object.keys(patch).length) await writeDeckConfig({ routing: patch }); }
        catch { throw new Error(keySaved ? "密钥已保存，其余设置未保存，请重试保存。" : "设置未保存，请检查配置文件后重试。"); }
        ctx.ui.notify(`Jev 设置已保存，新任务立即使用。${!credential().apiKey ? "\n尚未配置密钥，实际派遣将使用合规回退。" : ""}\n${readDeckConfig().enabled ? "" : "子任务总开关当前关闭，需要派遣时使用 /agent-deck on。"}`, "info");
        return;
      }
    } catch (error) {
      if (action === "connect") connection = "未通过 · 请检查提示";
      ctx.ui.notify(errorText(error), "error");
    }
  }
}
