import assert from "node:assert/strict";

export function chooseRenderedMenu(component: any, prefix: string | undefined): void {
  if (prefix === undefined) { component.handleInput("\u001b"); return; }
  component.handleInput("\u001b[H");
  let previous: string | undefined;
  for (let index = 0; index < 1000; index++) {
    const lines = component.render(240);
    const current = lines.find((line: string) => line.includes("›"))?.split("›")[1].trim();
    assert.ok(current && current !== previous, `Missing menu item ${prefix}: ${lines.join("\n")}`);
    if (current.startsWith(prefix)) { component.handleInput("\r"); return; }
    previous = current;
    component.handleInput("\u001b[B");
  }
  assert.fail(`Menu navigation limit: ${prefix}`);
}
