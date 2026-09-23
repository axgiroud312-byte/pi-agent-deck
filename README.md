# Pi Agent Deck

给 [Pi Coding Agent](https://pi.dev/) 使用的中文多 Agent 扩展。当前版本 **0.9.2**，采用 MIT 许可证。

一句话派任务，结果自动回来；用任务编号或实例名称继续、停止。模型工具采用 Claude Code 风格的 `Agent`、`SendMessage`、`TaskStop`。

主 Agent 负责拆分任务、决定使用多少个子 Agent、选择角色；可选的 Jev 只负责给单个子任务选择模型和思考强度。你可以同时安排几个只读调查，让主 Agent 继续处理其他工作，再从中文面板里查看结果或补充要求。

## 能做什么

| 能力 | 使用方式 |
|---|---|
| 自然语言委派 | 直接告诉主 Agent 要调查、实现或审查什么 |
| 中文任务面板 | 用 `/agents` 查看任务、日志、结果，继续或停止任务 |
| 保留上下文 | 子任务结束后仍可接着追问，沿用原来的子会话 |
| 可复用角色 | 内置实现工程师、侦察员、代码审查员；可用一句话创建自己的角色 |
| 可选 Jev 自动选配 | 在当前可用的 GPT-6 Astra、GPT-6 Sol、GPT-6 Luna、GPT-5.6 Sol 组合中选择 |
| 工作区写入协调 | 只读任务可并行，同一工作区的子 Agent 写任务串行 |

插件不设置全局或每个角色的任务数量上限。实际并行能力取决于模型服务、机器资源以及任务是否要修改同一工作区。

## 安装

先安装并配置好 Pi，确保主会话能够正常使用至少一个模型。本版声明支持 Pi `>=0.84.3`；当前完整验证环境为 Windows、Node.js 24 和 Pi 0.86.1。其他操作系统尚未做完整运行验收。

在终端安装 GitHub 上的版本：

```sh
pi install git:github.com/axgiroud312-byte/pi-agent-deck
```

然后在已经打开的 Pi 会话中输入：

```text
/reload
/agent-deck 开启
/agents
```

你可以直接对主 Agent 说：

> 找两个 Agent，分别只读调查前端和后端的登录流程，完成后汇总结论。

**Jev 是可选功能。** 没有 TypeSafe 密钥也能派遣子 Agent：自动选配不可用时，插件沿用明确配置或主会话的模型与强度。要启用 Jev，请继续阅读下面的“Jev 负责模型与思考强度”。

子 Agent 可以使用 Pi 内置模型、`models.json` 和扩展通过声明式 `registerProvider` 注册的模型。扩展提供商的数据单独传入子进程，父扩展的工具与钩子不会随之启用。包含自定义流式函数、OAuth 回调、动态模型回调或原生 Provider 的注册暂不支持，会在创建任务前明确报错。

扩展提供商快照保存在个人 Pi 目录的 `agent-deck/providers/`，供独立进程和后续恢复使用。快照可能包含原配置中的密钥和请求头，应与 Pi 的 `auth.json` 一样作为私人文件保管，不能上传或分享；任务请求、状态和日志只保存快照路径。文件以 `0600` 创建（Windows 继承用户目录权限）。修改提供商配置后应新建任务，旧任务继续使用创建时的快照；不再需要恢复旧任务时，可一并删除其提供商快照。

已有本地源码安装时，先用 `pi list` 检查安装来源，并保留一个 Agent Deck 加载入口，避免重复注册工具。使用 GitHub 安装后可执行 `pi update --extensions`，再在 Pi 中 `/reload`。修改角色配置不需要重装插件。

安装方式依据 [Pi 官方包文档](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)。npm 发布与官网收录流程见 [发布说明](docs/publishing.md)。

## 常用命令

更新插件后，在每个打开的 Pi 中执行 `/reload`。日常使用这些命令：

| 命令 | 用途 |
|---|---|
| `/agent-deck` | 直接切换开关 |
| `/agent-deck 开启` / `关闭` | 明确开启或关闭 |
| `/agent-deck 状态` | 只查看状态 |
| `/agents` | 查看任务、结果、继续或停止 |
| `/agent-create 描述` | 一句话自动创建个人 Agent |
| `/agent-config` | 编辑 Jev 自动选配、默认时限、每个 Agent，或新建 Agent |
| `/agent-router on` / `off` / `status` | 独立开启、关闭或查看 Jev 选配 |
| `/agent-route-test explore 调查登录失败` | 只试选模型与强度，不创建任务 |
| `/agent-config global` | 直接编辑全局设置 |
| `/agent-config worker` | 直接编辑实现工程师 |
| `/agent-config global --raw` / `/agent-config worker --raw` | 直接进入高级配置编辑 |
| `/agent-roles` | 查看角色、实际配置和文件位置 |
| `/agent-doctor` | 排障和检查是否需要重新加载 |

直接对主 Agent 说：“找两个 Agent，分别只读调查前端和后端的登录流程，完成后汇总结论。”

## 描述需求，自动创建 Agent

最直接的入口：

```text
/agent-create 帮我创建一个代码审查 Agent，专门检查逻辑错误和边界情况，只读，结论要有文件位置和修改建议
```

也可以运行 `/agent-config`，选择“描述需求，自动创建 Agent”，然后输入一段描述。系统使用当前 Pi 会话的模型生成名称、职责、提示词和工具配置，校验通过后自动保存，显示创建结果；无需手写 JSON、YAML 或角色 ID。生成期间按 Esc 取消。

你也可以在聊天里直接说“帮我创建一个……的 Agent”。主 Agent 会读取本插件的角色编写说明，使用现有文件工具完成；命令入口则由插件执行自动生成和校验。

- 默认保存为个人角色，所有项目可用；聊天中可明确要求只用于当前可信项目。
- 角色的模型、思考强度默认交给 Jev 在派遣时按角色策略选择；关闭选配也遵守相同策略。显式配置违反策略时拒绝保存或派遣；时限跟随全局。审查角色须带 `reportProfile: 审查`，命令生成的角色会保存这个标记。
- 调查、建议、审查默认只读；实现和修改任务按需求分配工具。完成后会显示实际工具和权限。
- 命令入口遇到生成格式错误会自动修正一次；仍无效时显示原因，不保存半成品。重名时自动加后缀，保留已有角色。
- 创建后可直接说“用这个 Agent 帮我……”或“用角色 ID 帮我……”。`/agent-config 角色ID` 保留手动编辑，聊天中也可描述修改要求。
- 创建角色不自动执行角色任务，也不自动打开派遣开关。
- 生成会使用当前模型服务的用量；插件只提交本次角色描述、配置规范和模型/角色标识，不提交聊天历史或项目文件正文。聊天方式的上下文由主会话管理。
- 未提供的浏览器、MCP、持久记忆等能力不会因角色提示词而出现。命令生成的能力限制会显示在结果中，并保留到角色正文。

## Jev 负责模型与思考强度

主 Agent 决定开启多少子任务、使用哪个角色、怎样分工、依赖顺序及验收标准。Jev 接收一个已经定义好的子任务，只在允许的模型与强度组合中作选择。

1. 在运行 Pi 的环境中配置 `TYPESAFE_API_KEY`。Windows 可打开“编辑账户的环境变量”，新增同名用户变量并填入 TypeSafe 密钥，再重新启动终端和 Pi。密钥不写入插件设置或任务文件。
2. 执行 `/agent-router status` 查看开关与密钥是否已检测到。检测到密钥不代表鉴权已成功。
3. 执行 `/agent-route-test explore 调查登录偶发失败，找出根因并给出文件证据`。试选期间 Esc 可取消；试选不创建任务，也不自动打开派遣开关。
4. 派遣开启后正常使用 `Agent`。任务编号先返回，需要 Jev 时后台状态为“选配中”；选择完成后启动子 Agent。面板显示最终模型、强度、选配耗时和回退原因。

默认选择器为 `jev-1.13.0`，15 秒超时。候选只来自当前提供商中 Pi 认为可用的下列四个模型，不自动切换账户或提供商。实际服务权限和限流仍可能影响执行。

以下是插件的**强制使用策略**，优先于 Jev、模型别名、角色固定值和继承值；这张表不表示模型官方支持的全部档位。

| 模型 | 可用角色 | 本插件允许的思考强度 |
|---|---|---|
| GPT-5.6 Sol | 仅审查；审查角色也只能用它 | `xhigh`、`max` |
| GPT-6 Sol | 非审查 | `high`、`xhigh`、`max` |
| GPT-6 Luna | 非审查 | `high`、`xhigh`、`max` |
| GPT-6 Astra | 非审查 | `low`、`medium`、`high`、`xhigh`、`max` |

共定义 13 个组合：审查池 2 个，非审查池 11 个。内置 `reviewer` 始终属于审查；自定义审查角色必须填写 `reportProfile: 审查`，主 Agent 按任务职责选择角色。程序依据这个标记识别审查，不猜测任务文本或角色名称。适用范围和具体规则见 [选配组合与评估说明](docs/jev-routing.md)。

继承强度低于下限时会提升到当前模型实际支持的合规档位。非审查任务若从主会话继承到 GPT-5.6 Sol，会在同一提供商中按 GPT-6 Sol → Astra → Luna 选择可用的回退模型；审查则选择同一提供商的 GPT-5.6 Sol。找不到合规配置时在创建任务前报错，不自动切换账户。这个顺序只决定回退，不是 Jev 的排名。

GPT-6 Sol/Luna 的推理工具调用需要 Responses 接口。其 Chat Completions 工具调用的 `off` 档低于本插件最低 `high`，因此不会进入候选；显式固定这种接口时提示修正。候选还会按当前 Pi 的实际模型能力筛选。

- `Agent.model` 优先于角色模型配置。思考强度可在角色中固定；新接口没有 `thinking` 参数。Jev 只选择尚未固定的部分；两项都固定或只剩一个组合时直接执行。
- 缺少密钥、接口错误、超时、无效选择、无合适候选时使用预先校验的合规回退配置，并记录原因。显式固定的模型或强度违反策略、或模型不支持该档位时，派遣前提示修正。
- 每个新任务最多一次 Jev 选择。选择结果写入该任务；继续相同任务沿用符合当前策略的已选配置。升级后，旧任务在再次启动或继续前会重新校验策略；不合规时要求新建任务，不自动换模重跑。已经启动的进程需结束或停止后再按新策略派遣。选配尚未完成就取消的任务，显式继续时才重新尝试首次选择。
- 取消操作和子进程启动使用同一个任务锁；选配被取消后，迟到的结果不能再启动子进程。
- 提交给 TypeSafe 的数据为该子任务说明、角色 ID/描述、审查标记、工具名、写权限和组合标准。不额外读取整个对话、项目文件或角色提示词；任务说明中主动包含的内容仍会随请求提交。
- 分布、选择器版本、选配时长和接口返回的 token 用量保存在任务记录。置信度不等于任务成功率；没有未经评估的置信度门槛。

接口遵循 [TypeSafe 官方 API](https://docs.typesafe.ai/api) 的 Choice 类型；能力边界依据 [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)和 [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)文档。

## 可以运行多少个 Agent

- **角色和任务数量由主 Agent 决定，插件不设全局或角色数量上限。** 实际服务和机器资源仍影响可同时执行的任务数量。
- 旧设置和旧任务中的 `maxConcurrent` 兼容读取但不再生效；保存全局配置时去掉旧字段。
- 同一 Git worktree 的子 Agent 写任务串行；非 Git 目录的父子目录重叠时也串行。
- 只读任务可以并行。写任务排队表示等待同一工作区的写入任务结束。

全局设置位于 `~/.pi/agent/agent-deck/config.json`：

```json
{
  "enabled": true,
  "timeoutMs": 0,
  "routing": {
    "enabled": true,
    "model": "jev-1.13.0",
    "timeoutMs": 15000
  },
  "modelAliases": {}
}
```

`timeoutMs: 0` 表示不限执行时长；正整数表示毫秒，例如 `1800000` 是 30 分钟。未设置时默认不限时。

`modelAliases` 默认空对象。若需要 `sonnet`、`opus`、`haiku` 或自定义别名，请在高级配置中明确映射到真实 `provider/model`。例如 `"modelAliases": { "review": "openai-codex/gpt-5.6-sol" }`，之后可在审查角色中使用 `Agent.model: "review"`。别名不会绕过角色和思考强度规则。此配置只提供名称映射，不配置账户；模型仍须在当前 Pi 中可用。角色文件继续使用完整模型标识。

开关关闭后，不新建、不追加、不启动排队任务；已经启动的任务继续运行，仍可停止和接收结果。重新开启后恢复调度。

## 每个 Agent 一个配置文件

常规修改使用 `/agent-config`：选择一个 Agent 后，直接调整模型、思考强度、工具或执行时限。模型按已配置的来源列出；工具通过空格勾选；时限填写分钟。提示词、调用描述和显示名称各有编辑入口。修改保存在草稿里，选择“保存并返回”才写入文件；Esc 或“返回，不保存”会放弃本次未保存的修改。

工具页显示实际生效的工具，Enter 将勾选结果应用到草稿；保存后按勾选结果推导写入权限。只修改模型等其他字段时保留原有工具、排除列表和权限。高级入口继续支持完整 Markdown 或 JSON 编辑。保存时发现文件被外部修改，会提示重新打开，避免覆盖。

参考 Claude Code 的 Markdown + YAML 配置方式，使用 Pi 自己的目录、模型和工具。配置优先级：

1. 插件内置 `agents/*.md`
2. 个人 `~/.pi/agent/agents/*.md`
3. 可信项目中的 `.pi/agents/*.md`

同 ID 后者覆盖前者。`/agent-config` 编辑内置角色时会创建个人覆盖，不直接改内置文件；编辑项目角色则保存到当前项目角色文件。

例如创建 `~/.pi/agent/agents/researcher.md`：

```markdown
---
name: 研究员
description: 调查代码结构并提供关键文件和行号，不修改文件
model: inherit
thinking: low
tools: Read, Grep, Glob, Ls
disallowedTools: Bash, Edit, Write
timeoutMs: 0
---

只处理主 Agent 交代的任务。
优先找到关键入口和调用链，区分事实、推断和未知项。
返回简短结论、证据和未完成事项。
```

此角色 ID 是文件名 `researcher`；也可以显式填写 `id`。正文是该角色的提示词。主 Agent 可以调用 `Agent({description: "调查入口", prompt: "阅读入口并返回证据", subagent_type: "researcher"})`。

| 字段 | 用途和默认值 |
|---|---|
| `name` | 显示名称；默认文件名 |
| `description` | 让主 Agent 知道何时使用这个角色 |
| `model` | `inherit` 或省略时按角色策略自动选配；关闭时也执行策略。完整 `provider/model` 固定模型 |
| `thinking` | `inherit` 或省略时按角色策略自动选配；固定值支持 `off/minimal/low/medium/high/xhigh/max`，实际允许值按上表及模型能力校验 |
| `reportProfile` | `通用`（默认）、`侦察`、`执行` 或 `审查`；自定义审查角色必须标记为 `审查` |
| `tools` | 允许的工具，可写逗号列表或 YAML 数组 |
| `disallowedTools` | 从允许列表中排除这些工具 |
| `timeoutMs` | 本角色每次执行的时限；`0` 不限时，省略继承全局默认 |
| `writePermission` | 可选。默认从实际工具推导；显式 `false` 时不允许配置写入或 shell 工具 |

支持 Pi 工具 `read, grep, find, ls, bash, edit, write`。工具名不区分大小写，Claude 风格的 `Glob` 映射到 Pi 的 `find`。省略工具时默认只读；显式 `writePermission: true` 且省略工具时使用全部上述工具。内部提问工具由插件提供。

**配置修改用于下一次新建任务，无需重新加载角色文件。** 已有任务的工具、提示词和时限保持原配置；模型与强度在继续前需通过当前策略校验。

这里没有实现 Claude 的 `permissionMode`、`maxTurns`、`memory`、`skills`、`mcpServers`、`hooks` 或 `isolation`。配置这些字段会明确报错。也不会将 `opus/sonnet/haiku` 自动映射到某个 Pi 模型。旧版 `id` 字段仍兼容；`reportProfile` 同时用于审查角色识别。

参考：[Claude Code 官方子 Agent 配置](https://code.claude.com/docs/en/sub-agents#write-subagent-files)。

## Claude 风格工具接口

```ts
Agent({
  description: string,          // 必填：简短任务标题，支持中文
  prompt: string,               // 必填：完整任务说明
  subagent_type?: string,       // 默认 general-purpose，或 Explore / reviewer / 自定义角色 ID
  model?: string,               // provider/model 或已明确配置的别名
  name?: string,                // 当前主会话内唯一的实例名称
  run_in_background?: true      // 仅 true 或省略；不支持前台模式
})

SendMessage({
  to: string,                   // 返回的 agentId 或实例名称
  message: string,              // 完整补充要求或问题答复，作为纯文本
  summary?: string              // 仅用于预览和记录，不替代 message
})

TaskStop({ task_id: string })   // 任务 ID 或实例名称
```

- `general-purpose/general/worker` 对应 `worker`，允许修改和验证；`Explore/explore/scout` 对应 `scout`，只读调查。其余使用准确的角色 ID，不按显示名称模糊匹配；别名与自定义 ID 冲突时明确报错。
- `description` 是标题，`prompt` 是完整任务，`subagent_type` 是角色，`name` 是实例名称。任务结果中的 `agentId` 等于稳定的运行编号（例如 `A-12345678`）；`agentType` 才是实际角色 ID。
- 实例名称为 1–64 位英文字母、数字、短横线或下划线，首位须为字母或数字。不区分大小写；保留 `main`、`team-lead` 和 `A-` 前缀。名称在任务结束和重载后仍绑定原任务，其他主会话可独立复用。
- 新任务不等待执行结束。回执含真实状态：`selecting`（选配中）、`queued`（排队中）、`async_launched`（已运行），或已经发生的终态。选配中不把备用模型当成最终模型公布。
- `SendMessage` 对选配、排队或运行中的任务返回 `delivery: "queued"`，消息持久化、按顺序在当前轮结束后处理。已结束或等答复的任务返回 `delivery: "resumed"` 并显示当前真实状态；恢复后仍可能等待工作区。
- 每条补充消息有持久 ID，并与恢复轮次绑定。队列清理失败不会再次执行已消费的消息；恢复请求已保存而状态未提交时，重启会补齐同一轮。当前会话内的损坏记录仍会阻止不可靠的名称绑定，其他会话的损坏记录不影响新建任务。
- 消息作为纯文本处理，不展开斜杠命令、文件引用或广播。摘要默认取第一行，最多 200 字符；完整正文不因此截断。
- 已结束、失败、停止或等待答复的任务可在原 Session 继续；角色、实际模型和思考强度沿用。旧记录未包含实例名称或标题时，仍可用运行编号操作。
- `TaskStop` 清除排队消息；重复停止已经结束的任务保留原终态。不能确认停止时返回 `stop_unconfirmed`，不会宣称停止成功。
- 三个接口只接受列出的字段。`Agent` 不接受 `resume`、`task_id`、`thinking`、`isolation`、`cwd`、`team_name` 等参数；`run_in_background: false` 明确报错。错误输入先校验，不产生任务或子 Session。
- 主 Agent 可以继续其他独立工作，结果通过 Pi follow-up 消息自动返回。补充和停止只能定位当前主会话的任务，不能跨会话操作。
- 子 Agent 返回自然语言结果，不需要填写大型报告。真正阻塞时用内部 `agent_question` 向主 Agent 提问。
- “已返回结果”表示执行正常返回了回答，实际是否完成仍由主 Agent 根据证据判断。

例如主 Agent 的一次完整调用：

```ts
Agent({ description: "调查登录失败", prompt: "只读检查登录入口、异常分支和会话过期处理，返回文件位置与证据。", subagent_type: "Explore", name: "scan-login" })
SendMessage({ to: "scan-login", message: "请补充过期 token 的处理证据。", summary: "补查过期 token" })
TaskStop({ task_id: "scan-login" })
```

工具内容和 `details.publicResult` 都包含公开身份与回执；`details.run` 保留内部运行记录（其中旧字段 `agentId` 仍是角色 ID）。旧工具不再注册，旧会话消息保留供阅读，不自动重放。使用 `/reload` 后，新调用按这三个接口执行。

这是 Pi 的后台子 Agent 工作流；参考 [Claude Code 工具接口](https://code.claude.com/docs/en/tools-reference)和[子 Agent 文档](https://code.claude.com/docs/en/sub-agents)，没有加入前台等待、实时收信、团队广播、工作树或远程执行。

## 后台、恢复和结果记录

已启动的 Runner 独立运行。Pi 退出后，排队任务、追加要求和结果投递等待所属父会话重新打开。

每轮结果独立保存到运行目录的 `results/`，继续任务不会覆盖尚未送达的上一轮结果。父会话持久化消息是送达依据；内存中排队不算已送达。重启后可以补送多轮结果，正常重载按消息回执去重。

当前不承诺同一个父会话被多个 Pi 实例同时打开时恰好一次投递。调度只保证本版本遵守协议的任务；升级时请重新加载所有 Pi 实例，避免混用新旧派遣逻辑。

运行记录位于 `~/.pi/agent/agent-deck/runs/`。当前会话通过父会话索引读取任务，未改变的状态和历史结果使用有界缓存。

历史 0.3.1 任务保留查看能力，不会在升级后突然批量推送；用新接口继续后启用自动投递。

## 任务面板

主界面摘要分别显示选配、运行、排队和等答复数量。输入 `/agents` 打开当前会话的任务面板：优先显示短标题，分开标识实例与角色；详情保留完整任务、实例 ID、实际模型与强度。需要答复或处理异常的任务靠前，状态和本轮耗时保留在右侧，长标题截短。面板最多占终端高度的 75%，内容少时收紧；窗口缩放后重新排版。

| 操作 | 效果 |
|---|---|
| ↑ / ↓ | 选择任务或滚动 |
| PgUp / PgDn | 按页移动 |
| Home / End | 跳到首尾；实时页 End 恢复跟随最新 |
| Enter | 查看任务详情 |
| 1 / 2 / 3、Tab | 切换任务说明、实时记录、结果 |
| C | 继续任务或追加要求 |
| X | 停止任务 |
| N | 描述需求，自动创建 Agent |
| G | 打开配置菜单 |
| Esc | 返回或关闭 |

实时记录默认跟随最新内容。向上翻阅后暂停跟随，新日志到达时保留阅读位置；按 End 或滚回底部恢复。页脚显示当前位置。最多读取最近 128 KiB，截取后明确标记“近期日志”；完整事件日志和历轮结果保留在运行目录。结果页支持 Markdown 标题、列表和代码样式。

配置菜单按窗口高度滚动，支持上下选择、翻页、首尾跳转，Enter 确定，Esc 返回。工具页用空格勾选，Enter 应用，Esc 取消。上述按键仅在对应界面内生效。

`/agent-panel`、`/agent-runs`、`/agent-continue`、`/agent-stop` 仍保留。[0.9.0 组件预览](docs/evidence/0.9.0/tui-preview.html)使用实际组件和模拟数据生成，不是正在运行的会话截图。

## 实现范围

写入互斥只协调本插件的子 Agent，不锁住主 Agent 或外部编辑器。Shell 使用当前用户权限，工具列表与工作区锁不是操作系统沙箱。父子目录检查基于启动工作区，不限制 shell 自行切换目录。

停止与执行超时覆盖受控 Runner 和子进程；任意自行脱离进程树的外部程序不在已验证保证内。无法确认的锁不会直接强删。

## 开发验证

```text
npm ci
npm run check
npm test
npm pack --dry-run
```

测试使用独立临时 Agent 数据目录、模拟模型输出及真实 fixture 子进程；宿主加载测试禁止网络请求。自动化测试不等于真实模型质量或人工终端验收。

源码职责、修改约定和验收范围见 [开发约定](DEVELOPMENT.md)。版本变化见 [0.9.2 模型策略说明](docs/0.9.2-release.md)、[0.9.1 修复说明](docs/0.9.1-release.md)、[0.9.0 发布说明](docs/0.9.0-release.md)和 [0.8.0 发布说明](docs/0.8.0-release.md)。遇到问题可提交 [GitHub Issue](https://github.com/axgiroud312-byte/pi-agent-deck/issues)，附上 Pi/Node.js 版本、复现步骤和去除私人信息后的错误提示。

本项目是社区扩展，与 Pi、Anthropic 或 TypeSafe 官方没有隶属关系；“Claude 风格”指工具命名和部分交互约定，具体支持范围以本文为准。许可证见 [MIT LICENSE](LICENSE)。
