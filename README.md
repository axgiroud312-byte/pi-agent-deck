# Pi Agent Deck

Pi Agent Deck 是一个面向 Pi 的轻量多 Agent 扩展，最近发布版本 **0.13.0**，MIT 许可证。当前源码包含后续的通信与续接修复，见 [修复记录](docs/communication-fix-2026-09-27.md)。

它不在 Pi 之外再造一套 Agent 框架。主模型从 `Agent` 工具描述中看到可用角色、职责、工具范围和扩展数量，自行判断是否委派、派给谁、是否并行以及前台还是后台；运行时只负责建立独立 Pi 子会话、转发消息、保存结果和清理进程。

## 设计边界

- 所有 Agent 使用调用者的同一工作目录。不创建 worktree，不自动合并，不实现任务 DAG、复杂队列或常驻调度服务。
- 主 Agent 负责拆分任务、判断输入是否充分、选择角色和数量、安排顺序并最终验收。简单工作可以直接完成，不强制经过探索、实施、审查流水线。
- “同一时间只让一个实施者修改正式交付文件”是给模型的协作约定，主 Agent 自己也计入实施者。程序不解析 Bash，不拦截文件系统，也不根据模型或角色名称强制判定谁是实施者。
- reviewer 和 scout 默认只排除 `edit`、`write`。它们可以使用 Bash、读取差异、运行相关检查，并生成必要的临时文件、缓存或报告；自动修复源码、更新测试快照或改写锁文件交由主 Agent 安排给实施者。需要稳定版本的检查由主 Agent 安排时机。
- 子 Agent 有独立 Pi 上下文。关键疑问可以向主 Agent 提问，回答后继续。任务结束后进程释放，记录和 Pi Session 保留；`SendMessage` 或显式 `resume` 都可续接原任务。
- Jev 只选择模型和思考强度。角色、模型型号和 thinking 不构成任务硬门禁；Jev 无密钥、超时、返回无效或偏好模型不可用时，会在隔离子 Pi 能加载的兼容模型中回退。若一个兼容模型都没有，任务会在创建前明确失败。

派发只交代本次目标、范围、当前有效背景、必要资料入口和期望结果，避免重复整段项目历史。主 Agent 收到结果后，在用户授权范围内决定接受、续接、补充验证或等待依赖。审查深度跟随改动风险，修复后优先检查原问题和受影响部分；用户指定的审查范围优先。这些是模型的工作建议，不增加工具参数、报告格式或业务状态。

`/agent-doctor` 会按当前会话的项目信任状态，通过 Pi 原生设置解析器检查磁盘上的 `images.blockImages` 并显示全局、项目或默认来源。禁止传图或读取失败时，同一提示也会进入主模型可见的 `Agent` 工具说明；正常配置不额外增加模型提示。该检查不会更改配置，也不代表正在运行的 Pi 会话已加载磁盘修改。需要视觉验收时，先用一张实际图片验证；`read` 成功不等于模型收到了图片。

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

三个工具的返回正文都包含 `agentId`、`turnId`、可选实例名称、当前状态和 `messagesPath`。主模型可直接用正文里的 `agentId` 联系或停止任务，用 `messagesPath` 读取消息记录。消息回执说明 `queued`（保存并排队）、`answered`（已提交回答）、`resumed`（续接原任务）或 `existing`（同一次调用已有消息记录）。`SendMessage` 回执带 `messageId`；完整报告保存后还带 `reportPath`。后台通知使用相同的身份格式，内部运行快照留在 `details` 中。

回执分别表达执行状态和投递状态。例如，向失败任务发送补充会开始新一轮，上一轮失败证据保留；正常结束也不代表业务已经验收通过。

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
- `SendMessage` 根据任务当前状态补充、回答或续接；`Agent({ resume, prompt })` 保留为显式续接入口；
- `completed` 只表示子运行正常结束，不表示任务要求已经通过验收。

项目不会给主 system prompt 注入一整篇编排 Skill，也不会要求模型维护额外的计划状态机。

## Agent：新建或明确续接

新建任务：

```ts
Agent({
  description: "调查登录失败",
  prompt: "定位登录失败原因，给出文件位置、日志证据和仍不确定的部分；正式交付文件的修改交回主 Agent 安排。",
  subagent_type: "Explore",
  name: "login-investigation"
})
```

新建时必填 `description`、`prompt`。可选字段为 `subagent_type`、`model`、`name`、`run_in_background`。

- 省略 `run_in_background` 或传 `false`：前台等待完整结果；子 Agent 提出关键问题时先返回问题，让主 Agent 回答。回答后原子会话继续，最终结果通过后台通知交付。
- 传 `true`：通常立即返回任务 ID；同一条运行流程在后台执行。若任务极快结束，初始工具调用会直接返回最终结果且不再重复通知；否则完成后会尝试唤醒当前进程中仍处于活动状态的所属父会话。
- 同一模型轮次的多个独立 `Agent` 工具调用可以并行。项目没有固定的 8 任务上限或内置排队器，实际并发由主模型和运行环境决定。

后台结果落盘后可从 `/agents` 查看，也可直接读取通知中的完整 Markdown 报告路径。回到所属父会话或重载时，运行时核对原生会话中的消息记录，只重新投递尚未提交、仍有效的父会话消息。已提交却找不到消费证据的消息显示为待核实，并提供记录路径；这些消息不会自动重放。

主 Agent 明确续接原任务时，确定尚未提交给子 Agent 的补充会按顺序带入新轮次；投递结果不明确的消息保留供核对。

后台执行时，主 Agent 可以继续独立工作；当前只需等待时，结束本轮回复即可。结果到达后会自动唤醒主 Agent，再继续验收。`resume` 表示开始新的执行轮次。

明确续接原任务：

```ts
Agent({
  resume: "login-investigation",
  prompt: "结合刚补充的失败日志继续调查，并说明判断发生了什么变化。",
  description: "补查刷新后的登录失败"
})
```

`resume` 接受当前父会话中的任务 ID 或实例名称。续接复用原任务 ID、Pi Session、模型以及创建任务时保存的 `tools / disallowedTools / extensions`；角色文件之后的修改只影响新任务。会话文件丢失或损坏时会明确失败，不会偷偷创建空白上下文。

## SendMessage：补充、回答与续接

```ts
SendMessage({
  to: "login-investigation",
  message: "补充：失败只发生在刷新页面以后。",
  summary: "刷新后失败"
})
```

- 运行或启动中：消息进入当前执行，回执为 `queued`。
- 等待主 Agent：消息作为回答交给正在等待的工具调用，回执为 `answered`。
- 已结束：使用原任务 ID、Pi Session 和配置启动下一轮，回执为 `resumed`，本轮结果后台通知。
- 同一次工具调用重试：使用相同消息编号返回 `existing` 及已有状态，避免再次提交；模型新发起的调用即使正文相同，也是一条独立消息。
- 正常收尾时还有已接受的补充：运行时取回 Pi 队列中的消息，在原进程、原会话、原轮次继续处理，处理完后再最终收尾。

消息会先写入任务目录的 `messages.json`。`queued`、`answered` 和 `resumed` 是操作回执，实际消费状态另行记录：

| 消息状态 | 含义 |
| --- | --- |
| `pending` | 已保存，等待消费；其中 `submittedAt` 只表示已经提交给接收方 |
| `consumed` | 在原生输入事件或会话记录中找到证据，消息已进入接收方上下文 |
| `closed` | 因停止、问题已结束等原因关闭，记录具体原因 |
| `unknown` | 已提交，但恢复核对找不到消费证据，需要结合原会话判断 |

`consumed` 不表示模型理解正确、执行完成或验收通过。消息编号与状态由程序维护，主、子 Agent 继续使用现有三个工具；消息头只是定位和核对信息，不增加角色限制或额外确认工具。

子 Agent 使用同名工具联系主 Agent：

```ts
SendMessage({ to: "main", message: "输出应使用哪种格式？", wait_for_reply: true })
```

主 Agent 收到问题后回答：

```ts
SendMessage({ to: "A-12345678", reply_to: "通知中的问题编号", message: "使用 JSON。" })
```

`reply_to` 可选；带编号的回答只用于该问题，过期或重复回答会明确报错。省略编号时按目标当前状态处理。普通进度消息省略 `wait_for_reply`，发送后继续工作；最终文本交付完整结果。问答复用 Pi 原生 RPC 请求编号和响应，等待期间保留原子进程、调用栈和会话，无需创建新任务。

## TaskStop：停止当前执行

```ts
TaskStop({ task_id: "login-investigation" })
```

它会清除当前进程内的待发送消息，把尚未消费的相关消息标记为关闭，结束该任务的当前子进程并保留会话与记录。停止中的任务暂不接收新消息。若进程退出无法确认，会显示“停止未确认”并保留进程身份，之后可以再次调用 `TaskStop`。

## 正常结束与 `completed`

子 Agent 继续执行 Pi 原生的模型—工具循环。Pi 报告本轮 settled 后，运行时检查执行状态并取回尚未消费的排队消息；有补充就用 `prompt` 在原轮次继续，直到可以最终收尾。正常收尾期间到达的消息与结束动作在同一任务控制队列内处理；若消息在最终结束后才被处理，则通过 `SendMessage` 开始新一轮。

同一轮中用于交付的 assistant 文本按顺序保留：完整报告后若又消费一条补充，后续摘要会追加，原报告仍在。工具调用旁的过程说明保留在 Pi Session。没有模型、RPC、进程、扩展、持久化、超时、取消或停止错误时，本轮为 `completed`。

每轮完整文本和运行失败原因自动保存为 `results/*.md`，与对应 `.json` 使用相同文件名。Markdown 报告保存成功后才写入结果快照并发布 `reportPath`；保存失败会出现在运行错误中。后台通知最多展示前 24,000 字符，完整报告路径始终位于截断范围之外。续接产生独立报告，已有轮次的交付仍可直接读取。

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
description: 检查安全边界并返回审查结论
tools: [read, bash, grep, find, ls, SecurityProbe]
disallowedTools: [edit, write]
extensions:
  - ../extensions/security-probe.ts
model: inherit
thinking: inherit
timeoutMs: 0
---

你负责审查主 Agent 指定工作的安全性，并返回结论与依据。
```

字段含义：

- `tools`：可选的 Pi 工具 allowlist。省略表示使用 Pi 默认工具，不是空工具集。扩展工具名保留大小写。
- `disallowedTools`：交给 Pi 的 denylist，优先排除同名工具。只读角色通常配置 `[edit, write]`，无需禁用 Bash。
- `extensions`：该角色明确加载的可信本地 Pi 扩展入口。相对路径以角色文件目录解析。
- `model / thinking`：偏好值；省略或 `inherit` 时交给当前会话/Jev。不可用偏好会在兼容模型中软回退；若隔离子 Pi 没有任何可加载模型，则在创建任务前失败。
- `timeoutMs`：任务时限；`0` 表示不限时。
- 正文：用一两句话说明角色负责什么。具体目标和交付要求写在本次任务中，问答和交付方式由公共运行说明提供。

子进程以 `--no-extensions` 启动，加载角色选择的扩展及内部 provider/通信桥。角色工作工具交给 Pi 的 `--tools / --exclude-tools`；显式 `tools` 自动附加通信工具 `SendMessage`。主、子进程的 `SendMessage` 参数分别服务任务控制和联系主 Agent。真实扩展加载或执行错误会作为运行错误保存并返回。

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
       └─ 执行轮次 turnId（前后台、状态、最终文本、错误、用量和可选当前问题）
```

内部 `runId` 是稳定任务身份；公开回执的 `agentId` 与控制工具的目标都对应它。每轮完整任务要求保存在 `instruction`；`description` 是短标题，`objective` 是统一派生的展示摘要。实际执行请求还可能包含暂存补充消息；这些消息不混入任务要求的展示字段，真实发送内容可从 Pi Session 查看。

- `request.json` 保存可明确 resume 的 Pi 启动配置；
- `status.json` 保存当前任务和轮次状态；
- `messages.json` 保存双向通信的编号、方向、正文、轮次、提交时间、消费状态及必要原因；
- `results/*.json` 保存每轮终态快照，`reportPath` 指向同 basename 的 `results/*.md` 完整报告；
- Pi Session JSONL 保存真实消息和工具调用。

扩展注册的声明式 provider 配置会按任务保存到 Pi 个人目录 `agent-deck/providers/<runId>.json`，供隔离子进程和以后 resume 复用。任务记录只保存该快照路径，但快照本身可能含 API key 或自定义 header；它属于私密认证状态，不进入项目或 npm 包，也不应提交、分享或复制到公开位置。

当前问题只存 `pendingQuestion: { id, message }`；完整问答沿用 Pi Session。消息消费核对读取原会话，更新插件自己的消息记录，原会话历史正文保持不变。v1/v2 旧问答、报告、租约、`writePermission`、结构化结果和工具证据投影到 `legacy`。旧运行快照按兼容格式读取；通过 `SendMessage` 或显式 resume 续接时迁移到 v3，移除已退役的 `agent_question / agent_report` 并更新公共运行说明。旧 JSON 报告可直接读取，在明确保存或续接时从历史原文补齐 Markdown 文件。历史通知保留原文，轮次由 `turnId` 标明。

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
