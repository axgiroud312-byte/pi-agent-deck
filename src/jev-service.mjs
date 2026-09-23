import fs from "node:fs";
import { atomicJson, withDiskLock } from "./persistence.mjs";

export function validateJevKey(value) {
  const key = value.trim();
  if (!key || key.length > 4096 || !/^[\x21-\x7e]+$/.test(key)) throw new Error("密钥应为一段不含空格的文本，请完整粘贴 TypeSafe API 密钥。");
  return key;
}

export function readSavedJevKey(file) {
  if (!file) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data?.version !== 1 || typeof data.apiKey !== "string") throw new Error("invalid");
    return validateJevKey(data.apiKey);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw new Error("无法读取本地 Jev 密钥文件，请检查个人目录中的 typesafe-auth.json。");
  }
}

export function resolveJevKey(file, env = process.env) {
  const saved = readSavedJevKey(file);
  if (saved) return { apiKey: saved, source: "saved" };
  const inherited = env.TYPESAFE_API_KEY?.trim();
  if (inherited) return { apiKey: validateJevKey(inherited), source: "environment" };
  return { apiKey: undefined, source: "none" };
}

/** Expected value protects edits made by another Pi while the settings page is open. */
export async function writeSavedJevKey(file, value, expected) {
  const key = value === undefined ? undefined : validateJevKey(value);
  await withDiskLock(`${file}.lock`, async () => {
    if (readSavedJevKey(file) !== expected) throw new Error("密钥已在其他 Pi 中修改，请重新打开 Jev 配置。");
    try {
      if (key === undefined) await fs.promises.rm(file, { force: true });
      else await atomicJson(file, { version: 1, apiKey: key }, { mode: 0o600 });
    } catch { throw new Error("无法保存 Jev 密钥，请检查个人目录的写入权限。"); }
  });
}

export const JEV_MODEL_PATTERN = /^jev-(?:latest|preview|\d+\.\d+\.\d+)$/;
export const JEV_MODEL_OPTIONS = [
  { value: "jev-1.13.0", label: "固定版本 · Jev 1.13.0（保持现有行为）" },
  { value: "jev-latest", label: "最新稳定版 · 随官方稳定版本更新" },
  { value: "jev-preview", label: "预览版 · 可能提前变化" },
];

/** Reads model metadata, without submitting a task or asking for an inference. */
export async function listJevModels(options) {
  const apiKey = validateJevKey(options.apiKey ?? "");
  options.signal?.throwIfAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs ?? 15000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal;
  try {
    const response = await (options.fetch ?? fetch)("https://api.typesafe.ai/v1/models", {
      method: "GET", redirect: "error", signal, headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      const messages = { 401: "密钥无效或已失效，请重新填写。", 403: "当前密钥没有访问模型列表的权限。", 429: "请求过于频繁，请稍后重试。", 529: "TypeSafe 服务繁忙，请稍后重试。" };
      throw Object.assign(new Error(messages[response.status] ?? `连接失败（HTTP ${response.status}），请稍后重试。`), { safe: true });
    }
    let body;
    try { body = await response.json(); } catch { /* validated below */ }
    if (!Array.isArray(body?.models) || body.models.some((item) => typeof item?.name !== "string")) {
      throw Object.assign(new Error("服务返回的模型列表格式不正确，尚未确认连接成功。"), { safe: true });
    }
    const models = [...new Set(body.models.map((item) => item.name).filter((name) => JEV_MODEL_PATTERN.test(name)))];
    if (!models.length) throw Object.assign(new Error("连接已响应，但账户没有返回可识别的 Jev 模型。"), { safe: true });
    options.signal?.throwIfAborted();
    return models;
  } catch (error) {
    if (options.signal?.aborted) options.signal.throwIfAborted();
    if (timeout.signal.aborted) throw new Error("连接检查超时，请检查网络或增加等待时间。");
    if (error.safe === true) throw error;
    throw new Error("无法连接 TypeSafe，请检查网络后重试。");
  } finally { clearTimeout(timer); }
}
