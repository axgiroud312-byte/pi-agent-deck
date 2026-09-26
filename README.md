# Pi Agent Deck

Pi Agent Deck 是一个面向 Pi 的轻量多 Agent 扩展，当前版本 **0.13.0**，MIT 许可证。

它不在 Pi 之外再造一套 Agent 框架。主模型从 `Agent` 工具描述中看到可用角色、职责、工具范围和扩展数量，自行判断是否委派、派给谁、是否并行以及前台还是后台；运行时只负责建立独立 Pi 子会话、转发消息、保存结果和清理进程。

## 设计边界

- 所有 Agent 使用调用者的同一工作目录。不创建 worktree，不自动合并，不实现任务 DAG、复杂队列或常驻调度服务。
- 主 Agent 负责拆分任务、判断输入是否充分、选择角色和数量、安排顺序并最终验收。简单工作可以直接完成，不强制经过探索、实施、审查流水线。
- “同一时间只让一个实施者修改正式交付文件”是给模型的协作约定，不是程序写锁。程序不解析 Bash，不拦截文件系统，也不根据模型或角色名称强制判定谁是实施者。
- reviewer 和 scout 默认只排除 `edit`、`write`。它们可以使用 Bash、读取差异、运行合适的检查和测试；Bash 不等于实施权限。
- 子 Agent 有独立 Pi 上下文。任务结束后进程释放，但任务记录和 Pi Session 保留；只有显式 `resume` 才继续原任务。
- Jev 只选择模型和思考强度。角色、模型型号和 thinking 不构成任务硬门禁；Jev 无密钥、超时、返回无效或偏好模型不可用时，会在隔离子 Pi 能加载的兼容模型中回退。若一个兼容模型都没有，任务会在创建前明确失败。

## 安装与启用

需要 Pi 0.87.1 或更新版本。本项目的验证基线为 Pi 0.87.1。

```sh
pi install git:github.com/axgiroud312-byte/pi-agent-deck
```

已有 Git 安装可以使用 `pi update --extensions` 更新。本地源码使用对应项目目录。更新前先等待活动任务结束，再执行：

```text
/reload
/agent-deck 开启
/agents
```

本项目只注册三个公开任务工具：`Agent`、`SendMessage`、`TaskStop`。

## 主模型怎样编排

`Agent` 的工具描述动态列出当前可用角色，例如：

```text
worker：实施最小修改并验证；tools=Pi 默认工具；排除=无
scout：调查入口、调用链和证据；tools=Pi 默认工具；排除=edit, write
reviewer：独立审查和运行检查；tools=Pi 默认工具；排除=edit, write
```

同一段工具描述还告诉主模型：

- 只委派适合独立处理的工作，任务提示应包含目标、范围和期望结果；
- 同一模型轮次可以发起多个互不依赖的 `Agent` 调用；
- 省略 `run_in_background` 时等待结果，传 `true` 时通常先返回任务 ID；若任务在初始工具调用返回前已经结束，则直接返回最终结果；
- 运行中用 `SendMessage` 补充信息，结束后用 `Agent({ resume, prompt })` 明确续接；
- `completed` 只表示子运行正常结束，不表示任务要求已经通过验收。

项目不会给主 system prompt 注入一整篇编排 Skill，也不会要求模型维护额外的计划状态机。

## Agent：新建或明确续接

新建任务：

```ts
Agent({
  description: "调查登录失败",
  prompt: "定位登录失败原因，给出文件位置、日志证据和仍不确定的部分。不要修改文件。",
  subagent_type: "Explore",
  name: "login-investigation"
})
```

新建时必填 `description`、`prompt`。可选字段为 `subagent_type`、`model`、`name`、`run_in_background`。

- 省略 `run_in_background` 或传 `false`：前台等待当前轮正常结束、结果保存和进程清理，然后直接返回最终文本。
- 传 `true`：通常立即返回任务 ID；同一条运行流程在后台执行。若任务极快结束，初始工具调用会直接返回最终结果且不再重复通知；否则完成后会尝试唤醒当前进程中仍处于活动状态的所属父会话。
- 同一模型轮次的多个独立 `Agent` 工具调用可以并行。项目没有固定的 8 任务上限或内置排队器，实际并发由主模型和运行环境决定。

后台结果始终落盘并可从 `/agents` 查看。切换到其他父会话或重载 Pi 后，旧会话不会补收内存中的完成通知。

明确续接原任务：

```ts
Agent({
  resume: "login-investigation",
  prompt: "结合刚补充的失败日志继续调查，并说明判断发生了什么变化。",
  description: "补查刷新后的登录失败"
})
```

`resume` 接受当前父会话中的任务 ID 或实例名称。续接复用原任务 ID、Pi Session、模型以及创建任务时保存的 `tools / disallowedTools / extensions`；角色文件之后的修改只影响新任务。会话文件丢失或损坏时会明确失败，不会偷偷创建空白上下文。

## SendMessage：只补充，不暗中执行

```ts
SendMessage({
  to: "login-investigation",
  message: "补充：失败只发生在刷新页面以后。",
  summary: "刷新后失败"
})
```

- 子任务正在运行：消息通过 Pi RPC steer 送入当前执行。
- 子任务正在选配或启动：消息在当前进程内暂存，启动后送入。
- 子任务已经结束：消息只暂存，不启动新一轮；主 Agent 必须显式 resume。
- 暂存消息不承诺跨 Pi 重载恢复；回执“已排队”也不等于模型已经读到。

旧 `reply_to`、子 Agent 提问工具和挂起等待答复流程已经移除。关键输入不足时，子 Agent 应在最终文本中说明阻塞原因、已经完成的部分和需要主 Agent 决定的事项，然后结束本轮。

## TaskStop：停止当前执行

```ts
TaskStop({ task_id: "login-investigation" })
```

它会清除当前进程内的待发送消息、结束该任务的当前子进程并保留会话与记录。若进程退出无法确认，会显示“停止未确认”并保留进程身份，之后可以再次调用 `TaskStop`，不会假装已经释放。

## 正常结束与 `completed`

子 Agent 继续执行 Pi 原生的模型—工具循环，直到模型不再发出可执行工具调用且 Pi 报告本轮 settled。运行时拿到最后一段 assistant 文本后保存；只要没有模型、RPC、进程、扩展、持久化、超时、取消或停止错误，本轮就是 `completed`。

运行时不会再次判断“任务要求是否全部做到了”。以下都可能是正常的 `completed`：

- 完整结果；
- “我做不到，因为缺少某个业务决定”；
- 部分完成说明；
- 空文本；
- 没有 `message_end`、但 Pi 正常 settled。

这不等于业务验收通过。主 Agent 直接阅读最终文本、子会话工具记录和错误信息，决定接受、补充信息、resume、重新委派或亲自处理。项目不再要求 `agent_report`，也不维护 `TaskResult`、结果完整性评分、检查声明或工具证据汇总等第二套语义。

## 角色配置

角色是普通 Markdown + YAML frontmatter。配置来源是 Pi 原生工具选择和扩展加载参数：

```md
---
id: security-reviewer
name: 安全审查员
description: 检查安全边界并给出文件和命令证据，不直接修改项目
tools: [read, bash, grep, find, ls, SecurityProbe]
disallowedTools: [edit, write]
extensions:
  - ../extensions/security-probe.ts
model: inherit
thinking: inherit
timeoutMs: 0
---

独立检查任务相关改动。优先给出可定位的证据；不要修改、创建或删除正式交付文件。
```

字段含义：

- `tools`：可选的 Pi 工具 allowlist。省略表示使用 Pi 默认工具，不是空工具集。扩展工具名保留大小写。
- `disallowedTools`：交给 Pi 的 denylist，优先排除同名工具。只读角色通常配置 `[edit, write]`，无需禁用 Bash。
- `extensions`：该角色明确加载的可信本地 Pi 扩展入口。相对路径以角色文件目录解析。
- `model / thinking`：偏好值；省略或 `inherit` 时交给当前会话/Jev。不可用偏好会在兼容模型中软回退；若隔离子 Pi 没有任何可加载模型，则在创建任务前失败。
- `timeoutMs`：任务时限；`0` 表示不限时。
- 正文：角色职责和行为约束。是否修改项目主要由任务分工、角色提示词和主模型协调；程序不建立第二套实施者字段或写锁。

子进程以 `--no-extensions` 启动，只加载角色选择的扩展和 Agent Deck 必需的 provider bridge，不继承主 Pi 的全部扩展。工具选择直接交给 Pi 的 `--tools / --exclude-tools`。项目不解析扩展源码，也不建立 `capabilities.json` 来源握手；真实扩展加载或执行错误会作为运行错误保存并返回。

内置 provider 和 `models.json` 可直接供子 Pi 使用；扩展注册的 provider 只有在配置可完整序列化时才能桥接。原生 provider 或含函数、`symbol`、`bigint` 的配置当前不能传入隔离子进程，这是一项技术兼容限制，不是模型或角色白名单。

旧角色中的 `writePermission` 和 `reportProfile` 只为历史读取兼容。`writePermission: false` 会迁移成排除 `edit`、`write`；配置编辑器再次保存时会移除这两个旧字段。新角色不要再写它们。

角色读取优先级：内置 `agents/*.md` → 个人 Agent 目录 → 已信任项目的 `.pi/agents/*.md`。`/agent-create 描述` 可生成角色，`/agent-config 角色ID` 可分别编辑工具、排除项和扩展。

## Jev

Jev 接收已经确定的任务、角色说明、可选工具范围以及隔离子 Pi 可加载的模型/思考组合，只返回模型与 thinking 选择。它不会拆任务、指定角色、决定 Agent 数量或评价最终结果。

- 显式且当前可用的模型/思考配置优先；
- 兼容模型从当前 Pi 可用模型中动态形成候选，不按 Astra、reviewer、Sol/Luna 等名称硬过滤；
- 不支持的 thinking 由 Pi 能力映射到可用档位；
- Jev 无密钥、超时、HTTP 错误或返回无效时沿用兼容回退配置并继续；没有兼容模型时不创建任务。

`/agent-router` 或 `/agent-config jev` 打开配置；`/agent-route-test Explore 调查登录问题` 只试选，不创建子任务。详细说明见 [Jev 路由](docs/jev-routing.md)。

## 数据与历史兼容

当前记录版本是 v3，核心关系很小：

```text
角色定义 roleId
  └─ 任务 runId（保存角色工具/扩展快照和一个 Pi childSession）
       └─ 执行轮次 turnId（前台或后台、状态、最终文本、错误和用量）
```

- `request.json` 保存可明确 resume 的 Pi 启动配置；
- `status.json` 保存当前任务和轮次状态；
- `results/*.json` 保存每轮终态快照；
- Pi Session JSONL 保存真实消息和工具调用。

扩展注册的声明式 provider 配置会按任务保存到 Pi 个人目录 `agent-deck/providers/<runId>.json`，供隔离子进程和以后 resume 复用。任务记录只保存该快照路径，但快照本身可能含 API key 或自定义 header；它属于私密认证状态，不进入项目或 npm 包，也不应提交、分享或复制到公开位置。

v1/v2 旧问答、报告、租约、`writePermission`、结构化结果和工具证据只投影到 `legacy` 供读取，不会恢复旧协议。启动时不批量改写历史；只有显式 resume 才把当前任务迁移到 v3，并移除已退役的 `agent_question / agent_report` 工具。

## 查看与命令

`/agents` 或 `/agent-panel` 打开只读任务面板：

- Enter 查看任务、真实子会话和结果；
- `1 / 2 / 3` 切换任务说明、实时记录、结果；
- `O` 展开或折叠长工具输出；
- `X` 停止当前任务；
- `N / G` 创建角色或打开配置。

查看不会启动模型、resume 任务或改写子会话。

其他命令：`/agent-deck [开启|关闭|状态]`、`/agent-stop 任务ID`、`/agent-roles`、`/agent-doctor`。旧 `/agent-continue` 只显示迁移提示。

## 开发与验证

```sh
npm run check
npm test
npm run docs:check
npm pack --dry-run --json
git diff --check
```

本地测试把“模拟 RPC 状态机”“真实 Pi 宿主 + 本地受控 provider/扩展”“在线真实模型”分开记录；前两层可自动重复，默认测试不会发起付费在线模型请求。

[0.13.0 发布说明](docs/0.13.0-release.md) · [0.13.0 验证记录](https://github.com/axgiroud312-byte/pi-agent-deck/blob/main/docs/0.13.0-validation.md) · [P0—P6 计划与进度](docs/single-workspace-subagent-plan.md) · [开发约定](DEVELOPMENT.md) · [0.12.0 历史计划](https://github.com/axgiroud312-byte/pi-agent-deck/blob/main/docs/0.12.0-optimization-plan.md)
