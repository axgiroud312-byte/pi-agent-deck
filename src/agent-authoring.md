# 按描述创建 Pi Agent

用户要求创建或修改可复用角色时，直接完成角色文件。用户提供职责和约束，你负责名称、配置和提示词；缺省项采用下述默认值。

## 保存角色

1. 读取会话提供的个人角色目录，检查已有角色。默认创建个人角色；用户明确限定当前项目时，使用可信项目的 `.pi/agents/`。
2. 使用简短英文文件名，例如 `code-reviewer.md`。保留名称 `worker`、`scout`、`reviewer`、`general-purpose`、`general`、`Explore`、`explore`、`new`、`global`、`jev` 和 Windows 设备名不用作新角色。新角色重名时加后缀，已有文件只有用户要求修改该角色时才编辑。
3. 写入 Markdown：配置头描述调用时机、模型和工具；正文写具体职责、方法、用户约束及可检查的交付要求。避免空泛人设。提示词用用户语言。
4. 回读文件，核对用户要求、工具名和配置格式。回复名称、职责、模型、工具权限、文件位置和使用方式。下一次派遣会重新发现角色，无需重载。

```markdown
---
name: "代码审查员"
description: "检查改动的逻辑与边界，给出带证据的风险和修改建议"
model: "inherit"
thinking: "inherit"
reportProfile: "审查"
tools: ["read", "grep", "find", "ls"]
---

阅读任务涉及的改动及必要上下文。按实际影响排列问题，给出文件位置、原因和最小修改建议；清楚标注未验证事项。
```

## 配置边界

- 审查角色填写 `reportProfile: 审查`；其他角色可用 `通用`、`侦察` 或 `执行`。内置 `reviewer` 始终视为审查。主 Agent 按职责选择角色，Jev 只选择该角色允许的组合。
- `model` 和 `thinking` 默认 `inherit`，派遣时按 [README 的模型策略](../README.md#角色与-jev) 选配；关闭 Jev 也执行同一策略。模型使用 Pi 的完整 `provider/model` 标识，显式配置冲突时拒绝保存或派遣。继承值可以调整为同一提供商的合规组合；无可用组合则报错。
- 审查只用 GPT-5.6 Sol / `xhigh` 或 `max`；非审查禁止 GPT-5.6 Sol，GPT-6 Sol/Luna 最低 `high`。Astra 对所有子 Agent 停用：不能固定、通过别名指定或作为回退。继承主会话的 Astra 时，非审查角色改用同一提供商的 GPT-6 Sol，其次 GPT-6 Luna；无可用合规模型则报错。具体以 `model-profiles.json` 的策略为准。旧自定义审查角色补标记后新建任务，已有任务不从提示词猜测审查类型。
- 工具仅支持 `read`、`grep`、`find`、`ls`、`bash`、`edit`、`write`。调查、建议、审查默认只读；实现、修改或执行验证按需求分配写入或命令工具。`bash` 可修改文件，不属于严格只读工具。
- 可选 `timeoutMs`：省略跟随全局，0 不限时，正整数为毫秒。主会话最多 8 个活跃子任务；数量、分工、依赖和验收由主 Agent 决定。Jev 只选择模型与思考强度。
- 派发前核对工具能力。返回结果后进程自动释放，原任务和会话保留；SendMessage 只传信息；Agent.resume 明确续接已结束的任务。
- 可选 `disallowedTools` 排除工具；写入意图默认从有效工具推导，无需额外填写 `writePermission`。
- 角色提示词不会增加实际工具能力。用户要求浏览器、MCP、记忆、hooks 或隔离时，如实说明本插件的支持范围。仅凭角色定义不能获得这些功能。
- 创建角色不等于执行角色任务。只有用户同时要求执行时，保存后再用 `Agent` 派遣，传入简短 `description`、完整 `prompt` 和角色 ID `subagent_type`。`name` 是可选任务实例名称，不是角色 ID；已有任务用 `Agent({resume, prompt})` 明确续接。

用户也可在终端直接运行 `/agent-create 描述`，走自动生成、配置校验和防覆盖保存流程。
