# 按描述创建 Pi Agent

用户要求创建或修改可复用角色时，直接完成角色文件。角色由 Pi 原生配置与职责提示词组成。

## 文件格式

默认保存到 Pi 的个人 `agents` 目录；用户明确限定当前可信项目时，可使用 `.pi/agents/`。使用简短英文 ID，正文用用户语言，以一至两句正面说明角色职责。具体范围、步骤和交付要求由本次任务提供，澄清与续接由公共运行指引提供。

```markdown
---
name: "代码审查员"
description: "检查改动的逻辑、边界与测试，给出有证据的建议"
model: "inherit"
thinking: "inherit"
disallowedTools: ["edit", "write"]
extensions: []
---

你负责独立审查主 Agent 指定的工作，并返回审查结论与依据。
```

## 配置含义

- `tools`：可选白名单。省略时沿用 Pi 当前默认工具；扩展工具名保持原始大小写。
- `disallowedTools`：明确排除的工具，优先于 `tools`。调查或审查角色通常只排除 `edit`、`write`，不额外限制 Bash。
- `extensions`：子进程额外加载的本地 Pi 扩展入口。相对路径以角色文件为准；不会自动继承主 Agent 的全部扩展。
- `model`、`thinking`：可选偏好。`inherit` 表示继承或交给 Jev 选择；Jev 只选择模型与思考强度，失败时回退并继续，不建立角色模型白名单。
- `timeoutMs`：省略时跟随全局，`0` 不限时，正整数为毫秒。

角色提示词说明职责和工作方法，工具字段决定 Pi 实际向模型开放什么。Bash 和可信扩展具有其自身的文件操作能力；主 Agent 安排同目录的修改顺序，调查和审查角色提供证据与建议。

新任务在创建时保存角色的生效配置；之后编辑角色影响新任务。`SendMessage` 用于补充、回答问题和续接原 Pi Session；`Agent({resume, prompt})` 保留为兼容入口。

旧角色中的 `writePermission` 和 `reportProfile` 只为读取兼容：`writePermission: false` 会迁移成排除 `edit/write`，配置编辑器保存时会移除这两个旧字段。新角色不再写它们。
