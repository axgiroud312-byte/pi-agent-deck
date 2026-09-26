# Agent Deck 开发约定

## 核心定位

Agent Deck 是 Pi 原生子会话的薄编排层，不是第二套 Agent runtime。

- 主模型通过动态 `Agent` 工具描述获得角色目录和用法提示，并自行决定是否委派、任务数量、角色、前后台、顺序和验收。
- 子任务继续使用 Pi 的模型—工具循环、工具选择、扩展加载、Session 和 RPC 协议。
- 运行时负责创建/续接任务、消息转发、进程生命周期、状态保存和后台通知；不理解业务是否完成。
- 不实现 worktree、自动合并、任务 DAG、固定容量、实施者锁、Shell 解析、文件沙箱或常驻调度服务。

同一目录只安排一个源码实施者是提示词和主模型的协作责任。scout/reviewer 默认通过 `disallowedTools: [edit, write]` 避免直接编辑，但 Bash 保持可用。

## 公开合同

只保留三个公开工具：

| 工具 | 作用 |
| --- | --- |
| `Agent` | 新建任务，或用 `resume + prompt` 明确续接原任务 |
| `SendMessage` | 给当前任务补充信息；绝不启动空闲任务 |
| `TaskStop` | 停止当前执行；失败时保留“停止未确认”状态供重试 |

`Agent` 省略 `run_in_background` 或传 `false` 时前台等待；传 `true` 时通常立即回执并在完成后通知。若任务在初始工具调用返回前已经终态，工具直接返回最终结果并登记为已交付，不再发送第二次通知。前后台使用同一套 `initializeRun → startExecution → finish → persistCompletion → close` 流程。

`SendMessage` 是 QueueOnly：

- 运行中走 Pi `steer`；
- 选配/启动中放入当前进程内邮箱；
- 已结束只暂存，直到显式 resume；
- 不承诺跨进程恢复。

## 角色与工具

`AgentDefinition` 只承载 Pi 原生执行所需字段：

```ts
interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: string[];
  disallowedTools?: string[];
  extensions: string[];
  timeoutMs?: number;
}
```

- `tools === undefined` 表示使用 Pi 默认工具，不要在 Agent Deck 中复制一份默认 allowlist。
- `disallowedTools` 原样交给 Pi；内置 scout/reviewer 只排除 `edit`、`write`。
- 扩展工具名保持大小写；已知内置名兼容大小写和 `Glob → find`。
- `extensions` 是角色明确选择的可信本地扩展入口。相对路径按角色文件位置解析并去重，但是否能加载由真实 Pi 宿主决定。
- 子 Pi 使用 `--no-extensions`，随后加载角色扩展和内部 `child-runtime.ts` provider bridge；不继承父进程扩展。
- Jev 和显式偏好只在隔离子 Pi 可加载的模型中选择。内置 provider 与 `models.json` 无需快照；原生 provider 和包含函数、`symbol`、`bigint` 的扩展 provider 配置不能桥接。若没有兼容模型，在创建任务、Session 和名称绑定前失败。
- 可序列化的扩展 provider 配置按任务写入 Pi 个人目录 `agent-deck/providers/<runId>.json` 并保留给 resume。`request.json` 只保存路径；快照可能含 key/header，必须视为私密认证状态，不进入项目、日志或发布包。
- 不建立 `capabilities.json`、工具来源证明或扩展源码审计。Pi 的 `--tools / --exclude-tools` 是唯一工具选择机制，`extension_error` 是运行失败证据。

旧 `writePermission`、`reportProfile` 只在解析/编辑时迁移：`writePermission: false` 转成排除 `edit/write`，再次保存后删除旧字段。不得让它们重新进入当前运行合同。

## 子任务结束语义

Pi 发送 `agent_settled` 后，运行时再次读取 `get_state`，确认当前 turn 不是 streaming/compacting，再收口：

- 最后一条 assistant `stopReason: error` → `失败`；
- `stopReason: aborted`、主动停止或取消 → 对应停止状态；
- RPC、进程、扩展、保存、超时错误 → 运行失败或停止未确认；
- 其他正常 settled → `已完成`。

`已完成/completed` 只说明执行正常结束。最终文本可以表示成功、失败、部分完成、阻塞，也可以为空；运行时不再用 `agent_report`、`TaskResult`、检查清单或证据字段做语义验收。

`extension_error` 与模型错误分开保存。后续正常 `message_end` 可以覆盖一次可重试的模型错误，但不能清除已经发生的扩展运行错误。

## 身份与持久化

```text
roleId（角色定义）
  └─ runId（稳定任务身份）
       ├─ childSessionId / childSessionPath（稳定 Pi 上下文）
       └─ turnId（每次新建执行或 resume 的轮次）
```

当前记录版本为 v3：

- `request.json`：Pi 命令、参数、prompt、timeout、Jev 计划和必要环境变量；provider 环境变量只保存个人快照路径，不内嵌快照内容；
- `status.json`：任务、当前 turn、最终文本、错误、资源和用量状态；
- `results/*.json`：每个终态 turn 的快照；
- Pi Session JSONL：真实消息、工具调用和工具结果。

任务记录直接保存 `tools / disallowedTools / extensions`，不再复制成第二套“生效配置”对象。resume 使用保存的请求、这些直接字段和 Session，不重新读取角色文件。

`adaptStoredRun()` 是 v1/v2/v3 的集中读取边界。旧问答、报告、租约、结构化结果、工具证据和写权限进入 `legacy`，启动扫描不批量改写。显式 resume 才把当前任务写为 v3，并从旧 `--tools` 中移除 `agent_question` 和 `agent_report`。

## 关键并发与失败边界

- `inTask(runId)` / 文件变更队列只序列化同一任务的输入和结束动作，避免 resume、SendMessage、settled、stop 交错；它不是跨任务调度器。
- 磁盘短锁和 recovery guard 都记录 owner/token；创建者异常退出留下的空锁、死亡 owner 或陈旧 recovery guard 可恢复，存活 owner 不能被其他进程删除。
- 终态历史先尝试保存，再发布可观察的 `released`；保存失败写入 `persistenceError`，不能静默丢失。
- RPC close 失败时保留 PID、连接和 `停止未确认`，`TaskStop` 可以重试；确认退出前不声称资源已释放。
- `ownerPid / childPid / runnerPid` 只用于真实进程归属和恢复检查，不代表实施者名额。
- 后台通知按 `runId + turnId + endedAt + status` 去重，只投递给当前进程中仍活动的所属父会话；快速终态由初始工具结果交付，切换会话或重载后不补送旧通知，也不重放内存消息。结果仍按正常路径落盘。
- 子扩展的交互式 UI 请求在 RPC 子任务中取消，避免无人值守子进程挂起等待输入。

## Jev

`index.ts` 先从 `modelRegistry.getAvailable()` 过滤出隔离子 Pi 可加载的 provider，`routing.ts` 再按 Pi 报告的 thinking 动态产生候选。候选 ID 必须唯一；一个模型的多个输入档位映射到同一实际 thinking 时要去重。

Jev 只回答一个有限选择题：为已经定义的任务选择 `model + thinking`。它不决定角色、数量、DAG、是否委派或任务是否完成。只要存在兼容候选，选择失败就返回 fallback；没有兼容模型时由创建边界明确拒绝。只有调用方主动取消才向上抛出取消。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 三个公开工具、动态 Agent 描述、命令、父会话通知 |
| `tool-contract.ts` | 工具参数解析、角色/任务寻址、最小公开回执 |
| `agents.ts` | 角色发现、frontmatter 解析、旧字段迁移 |
| `instruction.ts` / `agents/*.md` | 子 Agent 行为提示与内置角色职责 |
| `runtime.ts` | 当前主 Pi 持有的任务控制器、steer、resume、停止和收口 |
| `rpc-connection.ts` | Pi JSONL RPC、子进程退出确认和可重试 close |
| `child-runtime.ts` / `child-providers.ts` | 隔离子进程所需的声明式 provider bridge |
| `persistence.mjs` | 原子状态/历史保存、磁盘短锁和旧记录适配 |
| `delivery.ts` | 最终文本/错误投影、后台通知和历史标记 |
| `conversation.ts` | 只读解析 Pi Session 当前分支与工具记录 |
| `routing.ts` / `router.mjs` | 动态模型/思考候选、Jev 调用和软回退 |
| `ui.ts` / `presentation.ts` | 任务列表、只读会话、结果与资源状态 |
| `config*.ts` / `*ui.ts` | 全局和角色配置 |
| `agent-creation.ts` / `agent-authoring.md` | 自然语言创建角色及格式说明 |
| `scripts/check-docs.mjs` | 当前文档链接和退役合同检查 |

## 测试分层

1. 单元/模拟 RPC：状态机、输入竞争、持久化、失败注入、公开工具、TUI、配置和 Jev。
2. 真实 Pi 宿主 + 本地受控 provider：启动真实 Pi CLI/RPC，验证工具循环、前后台、消息、resume、停止和 Session。
3. 真实 Pi 宿主 + 本地测试扩展：验证角色扩展真的加载、`RoleProbe` 真的被模型调用、工具结果回到模型上下文、`edit/write` 排除生效。
4. 在线真实模型：不属于默认自动测试；只有明确执行后才能记录，不可用本地 faux provider 冒充。

验收命令必须在项目目录执行：

```sh
npm run check
npm test
npm run docs:check
npm pack --dry-run --json
git diff --check
```

不得通过删除有效测试、延长 sleep 或恢复旧硬门禁来消除失败。涉及真实 Pi 的测试保持文件级串行，需要并发证据时在单个测试内部明确并行启动任务。

## 提交前清理

- 检查当前代码与文档不再把 `agent_report`、固定容量、实施者锁、模型名单或能力握手描述成现行功能；历史兼容代码和历史文档可以明确标注为历史。
- 新字段必须贯通解析、创建、编辑、启动、持久化、resume 和显示，不能只写入 frontmatter。
- 不修改用户认证、个人模型偏好或插件启停；发布、推送、合并和安装到其他位置需另行授权。
