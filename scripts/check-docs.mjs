import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageFile = path.join(root, "package.json");
const pkg = JSON.parse(await fs.readFile(packageFile, "utf8"));
const releaseDocument = `docs/${pkg.version}-release.md`;
const validationDocument = `docs/${pkg.version}-validation.md`;
const documents = [
  "README.md",
  "DEVELOPMENT.md",
  "docs/jev-routing.md",
  "docs/publishing.md",
  releaseDocument,
  validationDocument,
  "docs/single-workspace-subagent-plan.md",
  "src/agent-authoring.md",
];

const errors = [];
const exists = async (file) => fs.access(file).then(() => true, () => false);
const normalize = (value) => value.replaceAll("\\", "/").replace(/^\.\//, "");
const packageIncludes = (relative) => (pkg.files ?? []).some((entry) => {
  const included = normalize(entry).replace(/\/$/, "");
  const candidate = normalize(relative);
  return candidate === included || candidate.startsWith(`${included}/`);
});

for (const relative of documents) {
  const file = path.join(root, relative);
  if (!await exists(file)) {
    errors.push(`缺少当前文档：${relative}`);
    continue;
  }
  const text = await fs.readFile(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1].replace(/^<|>$/g, "").split("#", 1)[0];
    if (!target || /^(?:https?:|mailto:)/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    if (!await exists(resolved)) errors.push(`${relative} 的链接不存在：${match[1]}`);
    const linked = normalize(path.relative(root, resolved));
    if (packageIncludes(relative) && !linked.startsWith("../") && !packageIncludes(linked)) {
      errors.push(`${relative} 会进入发布包，但本地链接目标不在包内：${match[1]}；请改用公开绝对链接或加入包清单`);
    }
  }
}

const validationText = await fs.readFile(path.join(root, validationDocument), "utf8");
if (/待[^\n]{0,60}填/.test(validationText)) errors.push(`${validationDocument} 仍有待填写的最终验证占位符`);

const lock = JSON.parse(await fs.readFile(path.join(root, "package-lock.json"), "utf8"));
if (lock.version !== pkg.version || lock.packages?.[""]?.version !== pkg.version) {
  errors.push(`package-lock.json 版本未与 package.json ${pkg.version} 对齐`);
}
const versionSource = await fs.readFile(path.join(root, "src/version.ts"), "utf8");
const sourceVersion = versionSource.match(/AGENT_DECK_VERSION\s*=\s*["']([^"']+)["']/)?.[1];
if (sourceVersion !== pkg.version) errors.push(`src/version.ts 版本 ${sourceVersion ?? "缺失"} 未与 package.json ${pkg.version} 对齐`);
if (pkg.scripts?.["docs:check"] !== "node scripts/check-docs.mjs") errors.push("docs:check 未指向 scripts/check-docs.mjs");
if (pkg.pi?.skills) errors.push("当前薄编排版本不应发布专用 pi.skills");

for (const required of ["src", "agents", "scripts/check-docs.mjs", "README.md", "DEVELOPMENT.md", "LICENSE", "docs/jev-routing.md", "docs/publishing.md", releaseDocument, "docs/single-workspace-subagent-plan.md"]) {
  if (!(pkg.files ?? []).includes(required)) errors.push(`package files 缺少当前交付入口：${required}`);
}

for (const relative of pkg.files ?? []) {
  if (!await exists(path.join(root, relative))) errors.push(`package files 条目不存在：${relative}`);
}

for (const retired of ["src/capabilities.ts", "src/run-capacity.ts", "src/wait-policy.ts", "docs/system-guide.html", "skills/agent-deck-orchestration/SKILL.md"]) {
  if (await exists(path.join(root, retired))) errors.push(`退役文件仍存在：${retired}`);
}

if (errors.length) throw new Error(`文档检查失败：\n- ${errors.join("\n- ")}`);
console.log(`文档检查通过：${documents.length} 份当前文档，${(pkg.files ?? []).length} 个打包入口。`);
