# 发布到 GitHub、npm 与 Pi 官网

公开源码仓库为 [axgiroud312-byte/pi-agent-deck](https://github.com/axgiroud312-byte/pi-agent-deck)。使用者可按 README 的 GitHub 安装命令安装，无需等待 npm 收录。

Pi 的 [官方包目录](https://pi.dev/packages)展示 npm 包。按 [官方包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)，包需要包含 `pi-package` 关键词，`pi.extensions` 则声明插件入口。本项目已配置这两项。上传 GitHub 本身不会完成 npm 发布，也不代表官网已经收录。

## 只同步 GitHub 源码

若本次目标只是让 GitHub `main` 与本地交付对齐：先运行项目验收命令，确认差异中没有个人凭据或运行记录，再提交并推送 `origin/main`，最后核对本地 `HEAD`、`origin/main` 和远程 `refs/heads/main` 指向同一提交。这个动作不自动创建 tag、GitHub Release、npm 版本或 Pi 官网条目。

## 维护者发布步骤

1. 修改版本号时，同时更新 `package.json`、锁文件、`src/version.ts` 和当前发布说明。
2. 在干净的工作副本执行 `npm ci`、`npm run check`、`npm test`。
3. 执行 `npm pack --dry-run --json`，检查包内只有运行源码、内置角色及当前使用、开发和发布文档，不含认证、个人角色、历史证据或运行记录。
4. 提交代码并推送 GitHub，为相同提交创建版本标签和 Release。
5. 在本机用 `npm login --auth-type=web` 完成 npm 登录，再执行 `npm publish --access public`。按 npm 当前要求由维护者完成网页登录或第二因素验证，不把密码或令牌写进仓库。
6. 通过 `npm view pi-agent-deck version` 核对已发布版本，再在 Pi 官网搜索包名。分别记录 GitHub、npm 和官网的实际状态；目录索引尚未更新时标明等待收录。

npm 发布完成后，使用者也可以通过以下方式安装：

```sh
pi install npm:pi-agent-deck
```

首次公开源码版本为 0.9.0；该文档中的 npm 命令是发布后的安装入口，不代表仅上传源码就已经发布 npm 包。
