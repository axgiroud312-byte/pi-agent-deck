# 单工作目录 Pi 原生子 Agent 优化：P0—P6 实施记录

## 0. 本轮确认后的目标

本文最初是一份尚未实施的严格治理方案。实施前讨论已经明确收敛方向：Agent Deck 应信任主模型和角色提示词，复用 Pi 原生结构，只保留必要的进程、Session、持久化和消息边界。本文以下内容是本轮实际执行依据和进度；早期关于 `writePermission`、固定容量、能力握手、`agent_report`、模型名单等设想已经作废。

当前目标：

1. 所有 Agent 使用同一工作目录，不引入 worktree、自动合并、任务 DAG、复杂队列或常驻调度服务。
2. 主模型通过动态 `Agent` 工具描述看到角色目录和简短用法，自行决定是否委派、角色、数量、前后台、顺序、返工和验收。
3. 同一时间只安排一个源码实施者是提示词层的协作约定，不在程序里建立写锁、容量槽、Bash 解析器或文件沙箱。
4. 角色直接配置 Pi 原生 `tools / disallowedTools / extensions`；scout/reviewer 默认只排除 `edit/write`，Bash 和其他 Pi 默认工具保持可用。
5. 子 Agent 使用 Pi 原生模型—工具循环。Pi 正常 settled 就记为 `completed`；最终文本由主 Agent 阅读和验收，不建立第二套结构化完成判断。
6. 前台、后台、消息补充、显式 resume、结果保存、停止失败和历史兼容仍可靠可查。
7. Jev 只选择模型和 thinking；任何角色/型号/强度偏好都不能成为任务硬门禁。存在隔离子 Pi 可加载的兼容模型时，选择失败应回退并继续；一个兼容模型都没有时必须在创建前明确失败。

## 1. 当前架构

```text
用户
  └─ 主 Pi / 主模型
       ├─ 直接完成简单工作
       └─ Agent 工具（描述中包含角色目录与委派提示）
            └─ Agent Deck 薄运行时
                 ├─ 同 cwd 的独立 Pi Session
                 ├─ 角色 tools / disallowedTools / extensions
                 ├─ 前台等待或后台通知
                 ├─ SendMessage steer / 内存暂存
                 ├─ 显式 resume 复用原 Session
                 └─ 保存结果并确认清理子进程
```

没有额外的 planner、scheduler、DAG、writer lease、工具来源证明或业务验收器。

## 2. 最小数据模型

### 2.1 角色

`AgentDefinition` 复用角色 Markdown，只保留当前执行真正使用的字段：

| 字段 | 含义 |
| --- | --- |
| `id / name / description / systemPrompt` | 角色身份、目录说明和行为提示 |
| `model? / thinking?` | 模型与思考偏好；在兼容子进程模型中软回退 |
| `tools?` | Pi allowlist；省略表示 Pi 默认工具 |
| `disallowedTools?` | Pi denylist；只读角色通常是 `edit, write` |
| `extensions` | 该角色明确加载的可信本地 Pi 扩展 |
| `timeoutMs?` | 本轮时限，0 为不限时 |

旧 `writePermission / reportProfile` 仅在历史角色读取时迁移，不进入新角色和当前运行逻辑。

### 2.2 任务、会话与执行轮次

| 身份 | 生命周期 | 作用 |
| --- | --- | --- |
| `roleId` | 角色定义 | 新任务选择哪个角色 |
| `runId` | 整个任务 | 公开任务 ID；多次 resume 保持不变 |
| `childSessionId / childSessionPath` | 整个任务 | 独立 Pi 上下文；resume 复用 |
| `turnId` | 单次执行 | 区分新建/每次 resume 的终态与通知 |

v3 当前记录保存角色工具/扩展快照、模型、delivery mode、最终文本、运行错误、资源状态和用量。业务上的“完成/阻塞/部分完成”只存在于最终文本里，不再变成运行时枚举或验收字段。

### 2.3 结果

结果合同只有两层：

- 运行事实：`status / finalText / failureReason / persistenceError / resourceState`；
- 真实上下文：Pi Session 中的消息、工具调用和工具结果。

`completed` 表示 Pi 本轮正常结束。文本即使说“做不到”、只完成一部分或为空，也不会被运行时改判失败。模型、RPC、进程、扩展、超时、取消、停止和持久化问题仍是运行失败事实。

## 3. P0—P6 进度

| 阶段 | 状态 | 当前结果 |
| --- | --- | --- |
| P0 基线与保护 | 完成 | 读取项目约定和原计划；记录并保护脏工作区；建立项目外恢复副本；运行当时适用的基线检查；未 reset、覆盖或回退用户修改 |
| P1 合同与数据收敛 | 完成 | 当前记录升级到 v3；移除当前 `TaskResult`、结果完整性、工具证据、writer lease/capacity 语义；v1/v2 字段集中投影到 `legacy` |
| P2 角色、工具与扩展 | 完成 | `tools / disallowedTools / extensions` 贯通解析、创建、编辑、显示、启动、保存和 resume；worker 用 Pi 默认，scout/reviewer 只排除 edit/write；删除额外能力握手 |
| P3 运行与交付 | 完成 | 前台省略/false 等待；后台 true 通常先回执，快速终态直接返回；二者共用同一收口；SendMessage 不暗启；显式 resume 复用原 Session 和配置 |
| P4 完成、失败与兼容 | 完成 | 正常 settled 即 completed；阻塞/空文本/无 message_end 都可正常完成；扩展和模型错误分离；停止未确认、保存错误和旧等待决定 resume 保留 |
| P5 编排、清理与文档 | 完成 | 角色目录和委派指导进入 Agent 工具描述；移除大 system prompt/Skill、固定容量、实施者锁、报告工具、能力来源校验及失效测试；README/开发/Jev/发布说明同步 |
| P6 验证与独立审查 | 完成 | 最新稳定工作区五项命令全部通过；完整测试 157/157；真实 Pi 本地扩展组合通过；独立只读复审确认无剩余高/中风险阻塞 |

## 4. 各阶段实施说明

### P0：基线与工作区保护

- 以用户已有未提交修改和未跟踪文件为实际基线。
- 在项目同级建立只读恢复副本，保存 status、patch 和当时文件；不建立 worktree。
- 所有构建与检查在项目目录运行。
- P0 只记录并保护已有脏工作区，运行当时已经存在且适用的基线检查；`docs:check` 是本轮新增能力。最终提交候选的五项验收统一记录在 P6，不把最终结果倒写成初始基线证据。

### P1：删除第二套治理数据

- `RunDetails.version` 支持 v1/v2/v3；新任务写 v3。
- 当前角色和任务不再写 `writePermission / reportProfile / TaskResult / resultCompleteness / toolEvidence`。
- 历史读取仍保留旧问答、报告、写权限、结构化结果和证据，统一放到 `legacy`；不删除用户历史会话。
- 工具与扩展快照直接保存在 `tools / disallowedTools / extensions`，不再复制为第二套“生效配置”对象。

### P2：直接使用 Pi 工具与扩展机制

- 角色省略 `tools` 时不生成自建默认列表，而是让 Pi 使用默认工具。
- `disallowedTools` 直接形成 `--exclude-tools`；不会因有 Bash 而推断实施身份。
- 子进程用 `--no-extensions` 隔离父扩展，然后只加载角色扩展和内部 provider bridge。
- 内置 provider 和 `models.json` 直接复用；可序列化的扩展 provider 保存到 Pi 个人目录供子进程及 resume 使用。原生/函数式 provider 不能桥接，没有兼容模型时在创建前失败。
- provider 快照可能含 API key/header，任务记录只保存其路径；快照属于私密认证状态，不进入项目或发布包，也不应提交或分享。
- 删除 `capabilities.ts`、`capabilities.json`、工具 sourceInfo 鉴定和额外启动握手。扩展语法/加载/执行错误直接采用 Pi 真实错误。
- 本地 `RoleProbe` 验证要求同时看到：Pi 活动工具、模型发出的工具调用、扩展执行日志、工具结果回到下一次模型上下文和 Pi Session 记录。

### P3：统一前后台与续接

- 新建和 resume 都走同一 `runtime.ts` 状态机。
- foreground 只影响调用方是否等待；background 只影响交付方式，不复制执行逻辑。后台通常先回执；若初始调用返回前已经终态，就直接返回最终结果且不再重复通知。
- 后台自动通知只投递给当前进程中仍活动的所属父会话；切换会话或重载后不补送，但结果仍落盘并可从面板查看。
- 结果历史在 released 终态可观察前先尝试保存；错误写入当前结果。
- `SendMessage` 运行中走 steer，空闲只暂存；只有明确 `Agent.resume` 触发下一轮。
- resume 保留任务 ID、Pi Session、模型与创建时配置，产生新 `turnId`。

### P4：信任最终文本，保留真实运行错误

- 删除 `agent_report` 注册和强制终报。
- `message_end` 只收集最后文本和模型 stopReason；`agent_settled + idle state` 触发结束。
- 正常文本、阻塞文本、部分文本、空文本和静默 settled 都完成；没有业务内容检查。
- 扩展错误单独保存，不能被随后正常文本清除。
- Pi Session 丢失时 resume 报错；v1 “等待决定”只在明确 resume 时迁移并继续原 Session。

### P5：编排提示和旧逻辑清理

- 动态 `Agent` 工具描述展示角色 ID、名称、职责、tools、排除项和扩展数量，并给主模型简短委派指导。
- `Agent` 声明并行 execution mode，使同一模型轮次的独立调用可并行。
- 删除固定 8 任务容量、工作目录实施者锁、主 edit/write 拦截、模型 allow/deny 政策、审查专属模型、最低 thinking、旧问答流程和编排 Skill。
- 删除无生产用途的能力/容量/等待模块及其旧测试；保留同任务输入序列化、进程归属、保存顺序、停止未确认和历史兼容等安全边界。

## 5. 验收矩阵

| 场景 | 验收事实 |
| --- | --- |
| 单实施者协作 | 内置角色提示和 Agent 工具描述说明由主模型安排；程序不建立硬写锁；集成场景只安排一个 worker 修改角色 |
| 带 Bash 的并行审查 | 两个 reviewer 同时启动、都看到 Bash、都不看到 edit/write、真实执行 `node --version` |
| 扩展加载和工具选择 | 真实 Pi CLI 加载本地 `RoleProbe`；工具被模型调用并返回结果；`HiddenProbe/edit/write` 不可见 |
| 前台与后台 | 省略/false 等待保存后的结果；true 通常先回执，快速终态直接返回且不重复通知；活动父会话至多收到一次完成通知 |
| SendMessage | 运行中进入同一执行；结束后不启动；显式 resume 后只消费一次 |
| 续接 | 同一 runId 和 childSession，新的 turnId；沿用保存的工具和扩展，即使角色文件已修改 |
| 阻塞与空输出 | “我做不到”、空文本、无 message_end 均可 completed；由主 Agent 解读 |
| 失败 | 模型 error/aborted、扩展错误、超时、保存失败、RPC/进程异常不冒充 completed |
| 停止未确认 | 清理失败保留 PID 和状态；TaskStop 重试后才 released，原结果与通知不重复 |
| 历史兼容 | v1/v2 可读；旧字段只在 legacy；启动不批量改写；明确 resume 迁移到 v3 |
| 模型选择 | Astra/角色/思考强度无硬门禁；Jev 仅选模型/思考；有兼容模型时失败软回退，无兼容模型时创建前失败 |

## 6. 验证记录

2026-09-26 在项目目录从最终提交候选工作区完成复验，三层证据明确分开：

1. **单元 / 模拟 RPC / 本地集成：** `npm test` 共 157 项，157 通过、0 失败、0 跳过、0 取消。覆盖前后台、SendMessage、resume CAS、结果保存、停止未确认、持久锁崩溃恢复、通知去重及 v1/v2 兼容。
2. **真实 Pi 宿主 + 本地 provider/扩展：** 测试实际启动 Pi CLI/RPC，加载本地 `RoleProbe`，由模型发出工具调用并把结果带回下一轮和 Pi Session；两个 reviewer 在生命周期重叠时真实调用 Bash 且看不到 edit/write。2026-09-26 最终复跑记录为 `tasks=5`、`turns=6`、`providerCalls=13`、`elapsedMs=1676`、`totalTokens=51969`、`resumeFixes=1`。这里的 token 是本地受控 provider 记录，不是在线账号消耗；elapsed 只是本机本次耗时，不是性能承诺。
3. **在线真实模型试用：** 未执行；本轮没有修改认证，也没有调用付费在线模型。

最终命令记录：

| 命令 | 结果 |
| --- | --- |
| `npm run check` | 通过；TypeScript 与三个 JS 模块语法检查无错误 |
| `npm test` | 通过；157/157 |
| `npm run docs:check` | 通过；8 份当前文档、10 个打包入口，并校验版本对齐与必要打包入口 |
| `npm pack --dry-run --json` | 通过；0.13.0，43 个文件；精确 JSON 见独立验证记录 |
| `git diff --check` | 通过；无空白错误或冲突标记 |

一次过渡复跑曾在另一个遗留的完整测试进程同时占用机器时得到 156/157；失败场景是 6 秒 faux child 在 TaskStop 前自然结束，不是生产错误。清理该精确测试进程后，把 fixture 改为明确由 TaskStop 结束，并在最新工作区干净复跑为 157/157。没有删除有效测试，也没有通过增加等待时间掩盖生产失败。

独立只读复审先后发现并推动修复了：旧无 `turnId` 停止请求的 ABA、v2 启动误改写、旧角色字符串/数字布尔迁移、字符串 denylist 丢失、主锁与 recovery guard 崩溃恢复、并发后台 resume 重复交付窗口。对应回归全部通过；最终复审未发现剩余高风险或中风险阻塞。

## 7. 已知边界

- 同一实施者是模型协作约定，不是安全沙箱，不能阻止另一个 Pi 进程、人工编辑或可信扩展直接改文件。
- `tools / disallowedTools` 控制模型可调用的 Pi 工具，不限制扩展 hook/provider 自身代码能力；角色扩展必须被视为可信本地代码。
- 扩展 provider 只有可序列化配置能桥接到隔离子 Pi；其个人快照可能含认证信息并为 resume 保留，必须按私密文件管理。
- 后台通知和暂存消息只保证当前进程行为；自动通知要求所属父会话仍活动，重载后保留历史与 Session，但不自动重放消息、补送通知或恢复执行。
- “停止未确认”在同一宿主进程内重试会保留原轮结果；若宿主在进程退出确认前自身退出，下一次启动只能按磁盘和进程事实标记失联，已保存的最终文本仍保留，但不会猜测原计划终态。
- `completed` 不表示任务要求满足，主 Agent 仍需阅读最终文本和必要证据。
- 2026-09-26 的交付续轮已单独授权把 0.13.0 实现和文档提交并推送到 `origin/main`。该授权不包含创建版本标签、GitHub Release、npm 发布、Pi 官网收录、安装到其他位置，也不包含修改个人模型偏好、认证或插件启停。
