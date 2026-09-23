# Pi Agent Deck

给 [Pi Coding Agent](https://pi.dev/) 使用的中文多 Agent 扩展。当前版本 **0.11.0**，采用 MIT 许可证。

主 Agent 用 `Agent` 派任务，用 `SendMessage` 补充要求或回答问题，用 `TaskStop` 停止任务。0.10.0 将通信收回主 Pi 进程：主 Pi 直接管理子 Pi 的 RPC 会话，不再依靠独立 Runner 和磁盘消息队列转发。

主 Agent 负责拆分任务、决定开启多少个子 Agent、选择角色、安排依赖和验收。可选的 Jev 只负责为一个已经定义好的子任务选择模型和思考强度。

## 能做什么

| 能力 | 使用方式 |
|---|---|
| 自然语言委派 | 直接告诉主 Agent 要调查、实现或审查什么 |
| 中文任务面板 | 用 `/agents` 查看当前会话的任务、结果，继续或停止任务 |
| 原会话续接 | 使用同一个 `task_id` 和子 Session 继续任务 |
| 运行中补充 | 通过 Pi RPC `steer` 在工具边界把补充要求送入当前任务 |
| 可靠问题答复 | 阻塞问题带 `questionId`，回答时必须使用匹配的 `reply_to` |
| 可复用角色 | 使用内置角色，或用一句话创建个人角色 |
| 可选 Jev 选配 | 在符合强制策略且当前可用的模型与思考强度组合中选择 |

每个主 Pi 会话固定最多 **8 个活跃子任务**。创建、选配、执行、等答复和释放中的任务占位；历史任务不占位。第 9 个新建或续接请求明确报错，不自动排队。主 Agent 决定实际需要几个任务，Jev 不负责调度。

子 Agent **返回结果后自动释放进程**，主 Agent 独立验收；返工或补查复用原任务 ID 和 Pi 会话，不需要模型再决定是否关闭进程。

## 安装

先安装并配置 Pi，确保主会话可以正常使用模型。0.10.0 要求以下 Pi 包版本至少为 **0.87.1**；开发依赖与本机验收基线也统一为 **0.87.1**：

- `@earendil-works/pi-agent-core`
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `@earendil-works/pi-tui`

从 GitHub 安装：

```sh
pi install git:github.com/axgiroud312-byte/pi-agent-deck
```

已有任务时先等它们结束，再在已经打开的 Pi 会话中输入：

```text
/reload
/agent-deck 开启
/agents
```

你可以直接对主 Agent 说：

> 找两个 Agent，分别只读调查前端和后端的登录流程，完成后汇总结论。

已有本地源码安装时，先用 `pi list` 检查安装来源，只保留一个 Agent Deck 加载入口，避免重复注册工具。使用 GitHub 安装后可执行 `pi update --extensions`，再在 Pi 中 `/reload`。

安装方式依据 [Pi 官方包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。npm 发布与官网收录流程见 [发布说明](docs/publishing.md)。

## 常用命令

| 命令 | 用途 |
|---|---|
| `/agent-deck` | 直接切换开关 |
| `/agent-deck 开启` / `关闭` | 明确开启或关闭 |
| `/agent-deck 状态` | 只查看状态 |
| `/agents` | 查看当前会话的任务、结果，继续或停止 |
| `/agent-create 描述` | 一句话创建个人 Agent |
| `/agent-config` | 编辑 Jev、默认时限和 Agent 配置 |
| `/agent-router` / `/agent-config jev` | 打开 Jev 配置页 |
| `/agent-router on` / `off` / `status` | 开启、关闭或查看 Jev 选配 |
| `/agent-route-test explore 调查登录失败` | 只试选模型与强度，不创建任务 |
| `/agent-roles` | 查看角色、实际配置和文件位置 |
| `/agent-doctor` | 查看扩展诊断信息 |

## 三个工具

工具名称和基础字段采用 Claude 风格，但行为以 Pi Agent Deck 的说明为准。0.11.0 在 0.10.0 基础上只新增一个可选输入 `delivery`；它和 `reply_to` 都是本插件扩展：

```ts
Agent({
  description: string,          // 必填：简短任务标题
  prompt: string,               // 必填：完整任务说明
  subagent_type?: string,       // general-purpose、Explore、reviewer 或自定义角色 ID
  model?: string,               // provider/model 或明确配置的别名
  name?: string,                // 当前主会话内唯一的实例名称
  run_in_background?: true      // 仅支持 true 或省略
})

SendMessage({
  to: string,                   // Agent 返回的 task_id/agentId，或实例名称
  message: string,              // 完整补充要求或问题答复
  summary?: string,             // 仅用于简短预览
  reply_to?: string,            // 回答阻塞问题时必须填写对应 questionId
  delivery?: "QueueOnly" | "TriggerTurn" // 默认 TriggerTurn；不能与 reply_to 同传
})

TaskStop({ task_id: string })   // 任务 ID 或实例名称
```

### Agent

- `description` 是短标题，`prompt` 是完整任务，`subagent_type` 是角色，`name` 是可选实例名称。
- `general-purpose/general/worker` 对应实现角色；`Explore/explore/scout` 对应只读调查角色。其他值必须是准确的角色 ID。
- 新任务立即返回稳定的 `agentId`，它也是 TaskStop 使用的 `task_id`；`agentType` 表示角色 ID。
- `run_in_background: false`、未知字段和无效角色会在创建任务前报错。

### SendMessage

- 同一个 `task_id` 始终定位同一个子 Session。初始执行以及从空闲状态继续工作时生成内部 `turnId`；运行中补充、问题答复仍属于当前执行，不生成新编号。用户只需要保存返回的 `agentId`，在 TaskStop 中作为 `task_id` 使用。
- 子 Agent 正在运行时，补充要求通过 RPC `steer` 送入。Pi 会在当前工具调用结束、下一次模型调用开始前处理它；这不是逐 token 的即时中断。
- 子 Agent 已结束时，默认的 `TriggerTurn` 重新启动子进程、打开同一个 Pi Session，开启新 turn，继续使用已有上下文。
- `summary` 不替代 `message`，也不会截断正文。

| delivery | 正在执行/等答复 | 执行已结束 |
|---|---|---|
| `QueueOnly` | 在消息边界补充；不能回答问题 | 信息暂存于主 Pi 内存，不启动进程、不占槽位 |
| `TriggerTurn`（默认） | 补充当前执行；不能回答问题 | 有空槽位时复用原会话继续，带上暂存信息 |

```ts
SendMessage({ to: "scan-login", message: "这份日志供后续参考。", delivery: "QueueOnly" })
SendMessage({ to: "scan-login", message: "请结合日志继续调查。", delivery: "TriggerTurn" })
```

两种方式都由调用参数决定，不使用模型猜测消息意图。QueueOnly 信息只保留在当前主 Pi 进程；退出或重载后不自动恢复。若补充恰逢执行结束，尚未被 Pi 消费的 QueueOnly 信息留待下一次 TriggerTurn。回执中的“已接收或排队”不代表模型已经读到。

### 回答阻塞问题

子 Agent 确实无法继续时，会使用内部问题工具返回 `questionId` 并进入等待状态。

```ts
SendMessage({
  to: "scan-login",
  message: "选择方案 A，并保留现有 API。",
  reply_to: "问题回执中的 questionId"
})
```

- 只有匹配当前问题的 `reply_to` 才能解除等待。
- 普通 `SendMessage` 可以补充背景，但不能冒充问题答复，也不能让等待中的任务自行恢复。
- 旧问题的 `questionId` 不能回答新问题。
- `reply_to` 直接回答原工具调用，不启动新 turn，不额外占槽位；与 `delivery` 同传会报错。

### TaskStop

`TaskStop` 停止当前进程内对应的活动控制器和子 Pi 进程；子 Session 记录和已经产生的结果仍会保留。任务随着主 Pi 进程结束或 `/reload` 一起结束，因此 0.10.0 不承诺主进程退出后的后台继续执行。

一个完整示例：

```ts
Agent({
  description: "调查登录失败",
  prompt: "只读检查登录入口、异常分支和会话过期处理，返回文件位置与证据。",
  subagent_type: "Explore",
  name: "scan-login"
})

SendMessage({
  to: "scan-login",
  message: "请补充过期 token 的处理证据。",
  summary: "补查过期 token"
})

TaskStop({ task_id: "scan-login" })
```

这三个工具借用了 Claude 风格的名称和部分字段，但本项目没有实现 Claude Code 的完整 Agent、团队、权限、工作树、远程执行或持久后台协议。

## 0.11.0 的任务生命周期

主 Pi 进程持有每个活动任务的控制器，并直接通过 RPC 管理子 Pi：

1. `Agent` 创建任务编号、子 Session 和第一轮 `turnId`。
2. 子 Pi 返回事件、工具调用和结果，主 Pi 直接更新面板并把结果交给当前父会话。
3. `SendMessage` 使用相同任务编号和子 Session；运行中使用 `steer`，已结束任务开启下一轮。
4. 阻塞问题保持等待，直到收到匹配 `reply_to` 的答复。
5. Pi 发出 `agent_settled` 后，插件结合最后执行结果判断正常返回、失败或中断，保存结果并关闭子进程；不靠自然语言或静默时间猜测完成。
6. 进程确认退出后释放槽位；任务 ID、Pi Session 和结果保留。“已返回结果”和“进程已释放”同时成立，是否验收通过由主 Agent 判断。
7. `TaskStop` 清空消息、取消待答问题并中断当前执行；主 Pi 退出或 `/reload` 会结束其子进程。

进度消息只传递、不自动唤醒主 Agent；问题和最终结果自动通知并唤醒，主 Agent 才能继续调度有依赖的下一项任务。

面板快捷键：**C 继续工作 / 运行中补充**（TriggerTurn），**M 仅发信息**（QueueOnly），**A 回答问题**（自动带问题 ID），**X 停止**。详情显示进程资源状态和暂存信息数量。

所有子 Agent 共享工作目录。插件不再用整个工作区的写锁强制串行：主 Agent 应划清修改范围，把有依赖或共享接口的任务顺序派发，独立任务才并行。不同文件也可能相互影响，最终仍须统一验收。

派发前主 Agent 会收到角色的实际工具清单，以及读写、命令/测试、提问能力。内置 Explore 和 reviewer 没有 bash，不能承担执行测试的任务；实现角色可以运行命令。自定义角色配置错误会显示不可用原因并在启动前拒绝。

0.10.0 删除了独立 Runner，以及通过 `follow-up.json` 等磁盘队列在重启后自动重放消息的路径。升级前保存的任务历史和旧队列文件不会被删除，但旧队列不会自动执行。需要继续的内容，应在升级并 `/reload` 后用新的 `SendMessage` 明确发送。

这种设计把“是否已经交给子 Pi”限定在当前主进程内，减少持久队列与实际子会话状态不一致造成的重复或丢失。代价是主 Pi 必须保持运行；需要跨重启长期执行的任务不属于 0.10.0 的能力范围。

## Jev 只选择模型与思考强度

主 Agent 决定：

- 是否需要子 Agent；
- 开启多少个；
- 使用哪些角色；
- 如何拆分、排序和验收。

Jev 接收一个已经定义好的子任务，只在允许的组合中选择 `model` 和 `thinking`。没有 TypeSafe 密钥时，插件使用符合策略的回退组合；Jev 不决定任务数量、角色或工作计划。

当前强制策略：

| 模型 | 可用任务 | 允许的思考强度 |
|---|---|---|
| GPT-5.6 Sol | 仅审查任务 | `xhigh`、`max` |
| GPT-6 Sol | 非审查任务 | `high`、`xhigh`、`max` |
| GPT-6 Luna | 非审查任务 | `high`、`xhigh`、`max` |

**GPT-6 Astra 对子 Agent 停用。** 它不进入 Jev 候选、回退、模型别名或角色固定值。主 Pi 自身使用什么模型不受这一子 Agent 策略影响。

内置 `reviewer` 属于审查角色；自定义审查角色必须填写 `reportProfile: 审查`。关闭 Jev、显式指定模型或使用别名都不能绕过上表。找不到当前账户可用的合规组合时，创建任务会明确失败。

Jev 配置和凭据说明见 [Jev 选配文档](docs/jev-routing.md)。TypeSafe 密钥保存在个人 Pi 目录中，不应上传或分享。

## 创建和配置角色

最直接的创建方式：

```text
/agent-create 帮我创建一个代码审查 Agent，专门检查逻辑错误和边界情况，只读，结论要有文件位置和修改建议
```

也可以运行 `/agent-config`，从中文菜单创建或编辑角色。角色文件采用 Markdown + YAML：

```markdown
---
name: 研究员
description: 调查代码结构并提供关键文件和行号，不修改文件
model: inherit
thinking: inherit
tools: Read, Grep, Glob, Ls
reportProfile: 侦察
timeoutMs: 0
---

只处理主 Agent 交代的任务。
优先找到关键入口和调用链，区分事实、推断和未知项。
返回简短结论、证据和未完成事项。
```

角色配置优先级：

1. 插件内置 `agents/*.md`
2. 个人 `~/.pi/agent/agents/*.md`
3. 可信项目中的 `.pi/agents/*.md`

支持 Pi 工具 `read, grep, find, ls, bash, edit, write`；Claude 风格的 `Glob` 映射到 Pi 的 `find`。省略工具时默认只读。角色修改用于以后创建的新任务，不会改变已经开始的子会话。

## 任务面板

输入 `/agents` 查看当前父会话的任务。面板显示任务编号、实例名称、角色、状态、当前 turn、模型、思考强度和最新结果。常用操作：

| 操作 | 效果 |
|---|---|
| ↑ / ↓ | 选择任务或滚动 |
| Enter | 查看任务详情 |
| C | 继续任务或补充要求 |
| X | 停止任务 |
| N | 描述需求并创建 Agent |
| G | 打开配置菜单 |
| Esc | 返回或关闭 |

“已返回结果”表示子 Pi 正常返回了回答；是否满足任务要求，仍由主 Agent 根据证据判断。

## 开发验证

```text
npm ci
npm run check
npm test
npm pack --dry-run
```

本次设计与验收范围见 [0.11.0 优化计划](docs/0.11.0-optimization-plan.md)，实际验证结果见 [0.11.0 发布说明](docs/0.11.0-release.md)。

源码职责和修改约定见 [DEVELOPMENT.md](DEVELOPMENT.md)。版本变化见 [0.11.0 发布说明](docs/0.11.0-release.md)以及历史发布说明。遇到问题可提交 [GitHub Issue](https://github.com/axgiroud312-byte/pi-agent-deck/issues)，附上 Pi/Node.js 版本、复现步骤和去除私人信息后的错误提示。

本项目是社区扩展，与 Pi、Anthropic 或 TypeSafe 官方没有隶属关系。许可证见 [MIT LICENSE](LICENSE)。
