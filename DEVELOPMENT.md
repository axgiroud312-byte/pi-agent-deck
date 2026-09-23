# Agent Deck 开发约定

## 当前目标

0.10.0 保持四个动作直观：派任务、接收结果、继续任务、停止任务。模型侧只注册 `Agent`、`SendMessage` 和 `TaskStop`。完整公开参数见 [README 的三个工具](README.md#三个工具)，参数 Schema 和运行时校验统一维护在 `tool-contract.ts`。

本版采用当前主 Pi 进程直接管理子 Pi RPC 会话的结构。活动任务不交给独立 Runner，也不通过持久消息队列跨重启转发。主进程退出或 `/reload` 时，当前活动控制器和子进程一起结束。

## 模块职责

- `index.ts`：扩展入口、三个模型工具、命令、父会话事件、活动控制器和结果交付。
- `tool-contract.ts`：三个工具的参数 Schema、严格解析、角色/模型别名和公开回执。
- `runtime.ts`：任务控制器、子 Session/RPC 生命周期、初始执行、`steer`、继续、停止和 turn 状态。
- `rpc-connection.ts`：Pi 原生 JSONL RPC 的薄连接层，处理请求匹配、事件、问答响应和进程退出。
- `task-identity.ts`：按当前父会话解析任务 ID 或实例名称；名称只在所属父会话中绑定。
- `child-runtime.ts`：子 Pi 的内部问题工具、阻塞状态和最小运行约束。
- `delivery.ts`：把当前 turn 的结果或问题转换为父会话消息。
- `types.ts`：任务、turn、问题、结果和界面使用的共享类型。
- `config.ts`、`configuration-ui.ts`：全局设置和配置入口。
- `config-editor.ts`、`menu.ts`：角色与全局配置编辑组件。
- `agent-creation.ts`、`agent-authoring.md`：用当前模型创建角色，以及供主 Agent 使用的角色文件规范。
- `agents.ts`：内置、个人、可信项目角色的发现、覆盖和校验。
- `routing.ts`、`model-profiles.json`：根据模型能力和强制策略构造可选组合。
- `router.mjs`：Jev/TypeSafe Choice 请求、响应校验和回退选择。
- `routing-ui.ts`、`jev-ui.ts`、`jev-service.mjs`：Jev 命令、中文配置界面和个人凭据。
- `child-providers.ts`：为子 Pi 准备可序列化的提供商配置。
- `ui.ts`、`presentation.ts`：当前会话任务面板、详情和中文状态呈现。
- `persistence.mjs`：历史记录和结果所需的原子文件操作；不承担活动消息队列重放。

删除或改名模块后应同步更新本节。活跃文档不能继续把已经移除的 Runner 或持久队列写成当前架构。

## 公开工具契约

0.10.0 保留原参数，只为 `SendMessage` 增加 `reply_to`：

```ts
Agent({
  description: string,
  prompt: string,
  subagent_type?: string,
  model?: string,
  name?: string,
  run_in_background?: true
})

SendMessage({
  to: string,
  message: string,
  summary?: string,
  reply_to?: string
})

TaskStop({ task_id: string })
```

三个接口只接受列出的字段。错误输入必须在创建 Session、调用模型或修改任务状态前失败。工具命名和部分字段参考 Claude 风格，不声明完整 Claude Code 兼容。

公开 `task_id`、回执中的 `agentId` 和内部任务控制器使用同一个稳定任务编号。`agentType` 是角色 ID。实例名称是当前父会话内的可读别名，不能用于跨父会话操作任务。

## task、Session 与 turn

一个 task 对应一个稳定任务编号和一个稳定子 Session。初始执行、运行中 steer、结束后的补充以及问题答复都归属到明确的内部 `turnId`。

- `task_id` 用来找同一个任务和子 Session。
- `turnId` 用来区分一次具体执行的事件、问题和结果。
- 继续任务不能新建一个没有原上下文的 Session。
- 上一 turn 的迟到结果不能覆盖当前 turn 的状态。
- 一个问题只能由它所属 turn 中匹配的 `reply_to` 回答。

用户通常不需要直接填写 `turnId`。它属于内部关联标识，不应扩展公开工具参数。

## 直接 RPC 通信

主 Pi 进程持有活动任务控制器，并负责启动、监听和关闭子 Pi。必须在可能产生事件或退出的操作前完成 RPC 事件与进程结束监听。

初始任务使用正常 prompt。任务运行时收到普通补充，调用同一子 Session 的 `steer`：

- 消息在当前工具调用结束后的模型边界生效；
- RPC 接受只表示子 Pi 已接收，不应描述成模型已执行；
- 不承诺在正在生成的 token 中间立即打断；
- turn 结束后收到的新要求，在同一 Session 中启动新的 turn。

活动控制器只存在于当前主 Pi 进程。`session_shutdown`、`/reload` 和显式停止必须关闭子会话及其受控进程。不要重新引入脱离主进程的 Runner，也不要通过磁盘队列尝试恢复一个已经不存在的活动控制器。

## 问题与回答

子 Agent 缺少必要决定时使用原有内部问题工具。发给主 Agent 的问题通知必须包含唯一 `questionId`；原工具调用等待匹配答复，并保持原 task 和 Session。

- `SendMessage.reply_to` 与当前 `questionId` 匹配时，正文才是问题答复。
- 没有 `reply_to` 的普通消息不能解除等待。
- 不匹配或已经过期的 `reply_to` 必须拒绝，不能误答另一轮问题。
- 问题答复在原工具调用中返回，不创建新的 turn；运行中补充也仍属于当前 turn。
- 结果消息应清楚提示如何填写 `reply_to`。

## 停止与关闭

`TaskStop` 定位当前父会话中的任务，关闭相应控制器和子 Pi。重复停止已经结束的任务应保留已有终态和结果。

主 Pi 关闭或重载属于明确的活动任务生命周期边界。任务历史可继续显示，但不能把旧活动任务描述成仍在后台运行。

## 历史与升级

0.9.x 的运行记录、结果和旧队列文件保留供查看。0.10.0 不自动执行旧 `follow-up.json` 或其他持久队列内容，也不把旧队列转换成一次隐式 `SendMessage`。

需要继续旧任务时，应由用户或主 Agent 在新版本中明确发起补充；不能从磁盘状态猜测一条旧消息是否已经被模型处理。当前版本产生的新消息只走当前进程内的直接通信路径。

## 模型和 Jev 边界

主 Agent 决定任务拆分、Agent 数量、角色、依赖、顺序和验收。Jev 只选择一个已定义子任务的 `(model, thinking)`，不能决定任务数量或角色。

强制策略集中在 `model-profiles.json`：

- `reviewer` 或 `reportProfile: 审查` 只允许 GPT-5.6 Sol / `xhigh`、`max`；
- 非审查任务不能使用 GPT-5.6 Sol；
- GPT-6 Sol 和 GPT-6 Luna 最低为 `high`；
- GPT-6 Astra 对所有子 Agent 停用；
- 插件没有全局或角色并发数量上限。

显式模型、角色固定值、模型别名、关闭 Jev 和回退路径都必须遵守同一策略。Jev 缺少密钥、超时或返回无效选项时，只能使用预先校验的合规回退。

## 角色和提供商

角色配置采用 Markdown + YAML。工具别名只映射实际支持的 Pi 工具；未知字段和无效配置必须在派遣前报告。角色修改影响以后创建的新任务，不应在已有子 Session 中静默更换权限、工具或系统提示。

创建子 Session 前检查候选提供商。只向子 Pi 传递可序列化的声明式配置；函数、OAuth 回调和原生 Provider 不应被伪装成可复制配置。个人认证数据不得写入任务结果或公开日志。

## 界面语义

面板按 task 显示当前状态，并按 turn 显示问题和结果。状态文字必须区分：

- RPC 已接受消息；
- 消息将在工具边界进入下一次模型调用；
- 子 Pi 已返回结果；
- 任务正在等待匹配的问题答复；
- 活动控制器已经停止。

“已返回结果”不等于“已经通过验收”。主 Agent 仍需检查证据和用户目标。

## 验证

常规发布候选执行：

```text
npm ci
npm run check
npm test
npm pack --dry-run
```

`npm run check` 包含 TypeScript 检查，以及仍在发布包中的 `router.mjs`、`persistence.mjs`、`jev-service.mjs` 语法检查。独立 `runner.mjs` 已不属于 0.10.0，因此不能继续保留对应检查。

测试重点：

- 三个工具的严格参数校验，尤其是 `reply_to`；
- 同一 task 和子 Session 的多 turn 续接；
- 运行中 `steer` 在工具边界送达；
- 普通消息不能解除问题等待；
- 旧问题不能回答新问题；
- 主 Pi 关闭、重载和显式停止会清理活动子进程；
- 旧持久队列保留但不会自动执行；
- Jev 只选模型与思考强度，且所有入口遵守模型策略；
- 多个任务并行时没有人为数量上限；
- 父会话隔离、实例名称和任务编号解析；
- 发布包包含当前 README、DEVELOPMENT 和 0.10.0 发布说明。

自动化测试、受控假模型和本地 fixture 不能写成真实模型质量证明。最终通过数量、平台验收和打包清单只能在对应命令实际完成后写入发布说明。

## 保持范围

不提供完整 Claude Code 兼容、团队广播、前台等待、工作树隔离、远程执行、跨主进程活动任务恢复或持久消息队列重放。

修改源码后需要 `/reload`。变更工具契约时，同步核对 README、当前开发约定、角色编写说明和当前版本发布说明。旧版本发布说明保留为历史资料，不回写成新架构说明。

分别记录本地部署、Git 提交、远端推送和 Release 状态。只有获得对应证据后才报告完成。
