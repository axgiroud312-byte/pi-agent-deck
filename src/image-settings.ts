import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

/** Disk diagnostics only: extensions cannot inspect an existing session's SettingsManager. */
export function imageSettingsDiagnostic(cwd: string, projectTrusted: boolean): { text: string; warning: boolean } {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(cwd, agentDir, { projectTrusted });
  const errors = settings.drainErrors();
  if (errors.length) {
    // Parse errors may quote private configuration values. Report paths, never raw errors.
    const files = errors.map((error) => error.path ?? (error.scope === "global"
      ? path.join(agentDir, "settings.json") : path.join(cwd, CONFIG_DIR_NAME, "settings.json")));
    return { text: `图片发送的磁盘配置无法确认：Pi 设置读取失败，请检查 ${[...new Set(files)].join("、")}。`, warning: true };
  }
  const blocked = settings.getBlockImages();
  if (typeof blocked !== "boolean") {
    return { text: "图片发送的磁盘配置无法确认：images.blockImages 应为布尔值。", warning: true };
  }
  const source = settings.getProjectSettings().images?.blockImages !== undefined
    ? `项目 ${path.join(cwd, CONFIG_DIR_NAME, "settings.json")}`
    : settings.getGlobalSettings().images?.blockImages !== undefined
      ? `全局 ${path.join(agentDir, "settings.json")}` : "Pi 默认值";
  return {
    text: `图片发送的磁盘配置：images.blockImages=${blocked}；来源：${source}。`
      + (blocked ? "Pi 会在请求模型前过滤图片；read 读取成功不代表模型看到了图片，视觉任务需先解决此限制。" : "配置允许传图，实际视觉能力仍以读取图片验证。")
      + "按当前会话的项目信任状态解析，不代表运行中会话的内存设置。",
    warning: blocked,
  };
}
