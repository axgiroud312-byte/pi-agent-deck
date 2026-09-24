# Pi Agent Deck

Pi 中文多 Agent 扩展，当前版本 **0.12.0**，MIT 许可证。

**主 Agent 澄清和派发 → 子 Agent 执行 → 返回结果并释放进程 → 主 Agent 验收。**

用户始终在主会话提出需求。TUI 用于查看子任务真实进度和结果，不要求用户逐个管理或回答子 Agent。

## 安装与启用

需要 Pi 0.87.1 或更新版本。本项目的实测基线为 Pi 0.87.1。

```sh
pi install git:github.com/axgiroud312-byte/pi-agent-deck
```

已有 Git 安装可用 `pi update --extensions` 更新；本地源码安装直接使用对应目录。先通过 `pi list` 确认只保留一个加载入口。已有任务先等它们结束，再输入：

```text
/reload
/agent-deck 开启
/agents
```

例如对主 Agent 说：“调查登录失败的原因，确认原因后修复并验证。独立的调查可以交给子 Agent。”

## 工作方式

- 主 Agent 决定是否委派、任务数量、角色、分工、依赖和验收。每项任务写清目标、范围、交付和验收方法。关键需求不清楚时由主 Agent 向用户确认。
- 子 Agent 在范围内自主作技术判断，只处理本次任务；无法继续时返回阻塞原因和已完成部分，不进入提问等待。
- 独立工作并行，有先后依赖或共享接口的工作顺序执行。共享工作目录，不自动建立工作树或写锁。
- 每个主会话最多 **8 个活跃子任务**。选配、执行和释放过程占位；第 9 个创建或续接请求报错，不自动排队。历史记录不占位。
- 执行结束后自动释放进程。任务 ID、Pi 子会话和历史结果保留；主 Agent 根据证据独立验收。
- 主 Pi 退出、重载或切换会话时结束其管理的子进程。已保存的子会话可明确续接，不自动恢复旧消息。

## 三个工具

名称和基础字段参考 Claude 风格，行为以本文为准，不宣称完整 Claude Code 兼容。`resume` 是本插件的明确续接入口。

### Agent：新建或明确续接

新建：

```ts
Agent({
  description: "调查登录失败",
  prompt: "目标：定位登录失败原因。范围：只读调查登录链路。交付：原因、文件位置和依据。验收：给出可复现步骤或日志证据。",
  subagent_type: "Explore",
  name: "login-investigation"
})
```

新建必填 `description`、`prompt`。可选 `subagent_type`、`model`、`name`、`run_in_background: true`。默认角色 `general-purpose`。默认省略 model，由 Jev 选配；支持显式 provider/model 或已配置别名。

同一任务的返工或补查，明确续接：

```ts
Agent({
  resume: "login-investigation",
  prompt: "根据刚补充的失败日志，补齐原因判断和对应证据。",
  description: "补查登录失败日志"
})
```

`resume` 接受当前主会话的任务 ID 或实例名称；必填本次 `prompt`，可选新标题。不能同时指定角色、模型、name 或 run_in_background。沿用原角色、模型、工具权限、任务 ID 和 Pi 子会话。每次续接有新的内部执行编号，本轮结果和检查从空状态开始，历史结果保留。

运行中或释放中不能 resume；补充要求用 SendMessage。会话文件丢失或无效时明确报错，不偷偷创建没有原上下文的替代会话。不同目标新建任务；独立审查使用新的审查任务。

### SendMessage：只补充信息

```ts
SendMessage({ to: "login-investigation", message: "补充：失败只发生在刷新页面后。", summary: "刷新后失败" })
```

保留 `to / message / summary?`。

- 运行中：通过 Pi `steer` 在工具结束、下一次模型请求前接收，不等整个任务结束。
- 创建/选配中：当前主进程暂存，启动时送入。
- 已结束：仅暂存信息，不启动进程；后续明确 resume 时带入。
- 暂存信息仅在当前主 Pi 进程内存在，退出或重载不恢复。
- 回执“已接收或排队”不等于模型已经读到。

内部仍区分 QueueOnly（传信息）与 TriggerTurn（新建/明确 resume），主 Agent 不再为普通消息选择启动模式。

### TaskStop：停止当前执行

```ts
TaskStop({ task_id: "login-investigation" })
```

清除待发送消息、停止当前执行并释放进程，保留会话和记录。已结束任务保留原终态。任务 ID、实例名称与角色 ID 是不同概念，不能用 `worker` 代替具体任务 ID。

## 查看真实进度

输入 `/agents` 或 `/agent-panel`。列表显示执行状态、进程状态和当前活动。选中任务按 Enter，进入同一 TUI 内的**只读子会话**：

| 按键 | 功能 |
| --- | --- |
| Enter | 打开子会话，默认查看真实对话和工具记录 |
| 1 / 2 / 3 | 本次任务 / 子会话 / 本轮结果与历史结果 |
| ↑↓、PgUp、PgDn | 滚动 |
| End | 跟随最新输出 |
| O | 展开或折叠长工具输出 |
| Esc | 返回列表，再按一次返回主界面 |
| X | 明确停止选中任务 |
| N / G | 创建角色 / 打开配置 |

查看页面不启动模型、不恢复任务、不切换主 Pi 会话，也不阻止进程结束。主 Agent 和其他子 Agent 继续工作。TUI 无子会话聊天、问题答复或续接输入框；需要调整任务时在主会话说明。

历史消息读取 Pi 会话的当前分支；执行中的公开文本从 RPC 消息事件显示。图片显示占位，模型内部思考不作为进度文本展示。旧任务缺少会话记录时显示已有活动记录。

## 结果、验证与验收

子 Agent 用简短的 `agent_report` 最终报告返回：完成/部分完成/阻塞、摘要、已完成部分、证据、检查和剩余工作。该工具直接结束本轮，不为格式化结果再请求一次模型。未使用结构化报告的自然语言结果仍可返回，但不会冒充验证通过。

面板与主 Agent 通知使用同一个结果格式：

```text
执行状态：失败
原因：模型请求失败
已完成部分：文件写入 A（有工具记录）
证据：子会话工具输出
验证：未提供结构化验证记录
剩余工作：需主 Agent 根据结果确认
验收：由主 Agent 根据证据独立判断
```

正常返回不等于业务目标完成，子 Agent 自述的检查通过不等于主 Agent 已验收。调查任务发现 CI 失败可以正常交付调查结论；修复任务是否达到目标由验收方法决定。旧执行的迟到通知标为历史，不能覆盖本轮状态。

错误原因不会被先前的正常输出覆盖；结果保存失败会明确提示，同时继续清理进程。进程确认退出后才显示“已释放”。

## 角色与 Jev

内置角色：`worker / general-purpose` 实现，`scout / Explore` 只读调查，`reviewer` 只读审查。派发前主 Agent 可看到实际工具能力；scout 和 reviewer 没有 bash，不能执行测试。

Jev 只为已经定义好的任务选择模型和思考强度，不拆任务、不决定数量。

- 子 Agent 禁用 GPT-6 Astra。
- 审查角色只用 GPT-5.6 Sol，最低 xhigh；非审查角色不使用 5.6 Sol。
- GPT-6 Sol、GPT-6 Luna 最低 high。
- 续接沿用原模型，不重新调用 Jev；执行前继续检查已有模型策略。

`/agent-config` 可视化配置角色和全局设置；`/agent-router` 或 `/agent-config jev` 打开 Jev 配置；`/agent-route-test Explore 调查登录问题` 只试选，不创建任务。详细配置见 [Jev 配置](docs/jev-routing.md)。

`/agent-create 描述` 可创建角色。角色读取优先级：内置 `agents/*.md` → 个人 `~/.pi/agent/agents/*.md` → 可信项目 `.pi/agents/*.md`。角色变更用于新建任务，续接保留原角色。

其他命令：`/agent-deck [开启|关闭|状态]`、`/agent-stop 任务ID`、`/agent-roles`、`/agent-doctor`。旧 `/agent-continue` 只给迁移提示，不再执行任务。

## 从 0.11.0 升级

这是一次有意收紧的接口变更：SendMessage 不再接受 `delivery` 和 `reply_to`，旧调用会明确提示使用 Agent.resume；子 Agent 的 `agent_question` 与等待答复流程已移除。旧角色中的问题工具声明会被过滤。

旧会话和历史报告不删除，旧队列不重放。旧任务首次 resume 更新插件的执行约定和已移除工具，保留原角色内容、模型与 Pi 会话。请在现有任务结束后更新并 `/reload`，不迁移运行中的旧进程。

[优化计划](docs/0.12.0-optimization-plan.md) · [发布说明](docs/0.12.0-release.md) · [开发约定](DEVELOPMENT.md)
