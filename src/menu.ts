import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { fit, frame, panelHeight, plain, twoColumns } from "./presentation.ts";

export async function selectMenu<T>(ctx: ExtensionContext, title: string, items: Array<{ value: T; label: string }>, initial?: T): Promise<T | undefined> {
  return ctx.ui.custom<T | undefined>((tui, theme, _keys, done) => {
    let cursor = Math.max(0, items.findIndex((item) => item.value === initial));
    let pageSize = 1;
    return {
      render(width: number) {
        const height = panelHeight(tui.terminal?.rows ?? 24);
        pageSize = Math.max(1, Math.min(items.length, height - 5));
        const start = Math.max(0, Math.min(cursor - Math.floor(pageSize / 2), items.length - pageSize));
        const inner = Math.max(1, width - 4);
        const lines: string[] = [];
        for (let index = start; index < Math.min(items.length, start + pageSize); index++) {
          const selected = index === cursor;
          const label = fit(`${selected ? "›" : " "} ${plain(items[index].label)}`, inner);
          lines.push(selected ? theme.bg("selectedBg", theme.fg("accent", label)) : label);
        }
        if (!items.length) lines.push(theme.fg("muted", "暂无可选项"));
        lines.push("", theme.fg("muted", twoColumns("↑↓ 选择 · PgUp/PgDn 翻页", `${items.length ? cursor + 1 : 0} / ${items.length}`, inner)), theme.fg("muted", "Enter 确定 · Esc 返回"));
        return frame(theme.fg("accent", plain(title)), lines, width, theme).slice(0, height);
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.escape)) return done(undefined);
        if (matchesKey(data, Key.enter)) return done(items[cursor]?.value);
        if (matchesKey(data, Key.up) || data === "k") cursor--;
        else if (matchesKey(data, Key.down) || data === "j") cursor++;
        else if (matchesKey(data, Key.pageUp)) cursor -= pageSize;
        else if (matchesKey(data, Key.pageDown)) cursor += pageSize;
        else if (matchesKey(data, Key.home)) cursor = 0;
        else if (matchesKey(data, Key.end)) cursor = items.length - 1;
        cursor = Math.max(0, Math.min(items.length - 1, cursor));
        tui.requestRender();
      },
      invalidate() {},
    };
  });
}
