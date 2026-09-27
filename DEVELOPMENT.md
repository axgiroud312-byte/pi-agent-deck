# Agent Deck 开发约定

## 核心定位

Agent Deck 是 Pi 原生子会话的薄编排层，不是第二套 Agent runtime。

- 主模型通过动态 `Agent` 工具描述获得角色目录和用法提示，并自行决定是否委派、任务数量、角色、前后台、顺序和验收。
- 子任务继续使用 Pi 的模型—工具循环、工具选择、扩展加载、Session 和 RPC 协议。
- 运行时负责创建/续接任务、消息转发、进程生命周期、状态保存和后台通知；不理解业务是否完成。
- 不实现 worktree、自动合并、任务 DAG、固定容量、实施者锁、Shell 解析、文件沙箱或常驻调度服务。

同一目录只安排一个源码实施者是提示词和主模型的协作责任，主模型自己也计入实施者。scout/reviewer 默认通过 `disallowedTools: [edit, write]` 避免直接编辑，但 Bash 保持可用。相关检查产生的临时文件、缓存和报告属于检查过程；自动修复源码、更新测试快照和改写锁文件由主模型安排给实施者。主模型为需要稳定版本的检查安排适当时机。

派发说明提炼当前任务与必要资料，结果返回后由主模型决定接受、续接或补验。审查范围按风险和用户要求安排，不在代码中强制固定阶段或反复全量审查。共用子 Agent 说明要求验证实际行为、区分亲验/已有记录/推断，自定义角色同样获得这些说明。

`image-settings.ts` 仅提供磁盘配置诊断，复用 Pi 的 `SettingsManager` 处理全局/项目合并及项目信任；不写设置、不定义能力注册表、不拦截派发。只把传图限制或读取异常加入动态 `Agent` 工具说明，`/agent-doctor` 始终显示读取结果和来源。Pi 扩展接口未暴露活动会话的 SettingsManager，因此不得把磁盘读取描述为子进程的实时生效值，也不得把允许传图描述为模型已具备视觉能力。读取失败只报告配置路径，避免解析错误泄露配置内容。

## 公开合同

只保留三个公开工具：

| 工具 | 作用 |
| --- | --- |
| `Agent` | 新建任务，或用 `resume + prompt` 明确续接原任务 |
| `SendMessage` | 运行中补充、等待中回答、结束后续接原任务 |
| `TaskStop` | 停止当前执行；失败时保留“停止未确认”状态供重试 |

`taskMessage()` 是工具回执和后台通知的共同正文格式。每条正文包含 `agentId`、可选名称、角色和状态，必要时带资源状态、已确定模型、消息投递状态及错误；内部 `run` 和兼容 `publicResult` 留在 `details`。Pi 的模型消息只消费 `content`，控制任务所需信息必须出现在正文，测试也必须跨过这个边界。

`taskOutput()` 只生成结果与错误正文，身份头由外层添加一次；前台保留完整最终文本，后台通知继续使用原有长度边界并保存完整证据。

回执分别表达执行 `status` 和消息 `delivery: queued | answered | resumed`。业务完成与否由主 Agent 阅读交付判断；操作条件不合法时抛出工具错误。父 `SendMessage` 接受可选 `reply_to`，防止迟到或重复回答作用于其他问题。三个父工具名称保持不变。

`Agent` 省略 `run_in_background` 或传 `false` 时前台等待；传 `true` 时通常立即回执并在完成后通知。若任务在初始工具调用返回前已经终态，工具直接返回最终结果并登记为已交付，不再发送第二次通知。前后台使用同一套 `initializeRun → startExecution → finish → persistCompletion → close` 流程。

`SendMessage` 在同一任务控制队列内根据当前状态执行：

- 运行中走 Pi `steer`；
- 选配/启动中放入当前进程内邮箱；
- 等待问题时回复原 RPC 请求，子工具调用继续；
- 已结束时调用与 `Agent.resume` 共用的续接函数；
- 内存中的排队消息只属于当前进程。

子桥注册 `SendMessage({to: 'main', message, wait_for_reply?})`。问答复用 Pi RPC `extension_ui_request/response` 的请求编号，`pendingQuestion` 只保存 `{id, message}`。前台遇到问题时先返回问题并转为后台交付，主 Agent 得以回答；回答继续原进程与同一轮次。普通进度独立通知，最终文本负责完整交付。工具 AbortSignal 和 TaskStop 都可取消等待。

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
- 子 Pi 使用 `--no-extensions`，随后加载角色扩展和内部 `child-runtime.ts` provider/通信桥。显式工作工具白名单在启动时附加 `SendMessage`，角色快照仍保存原工作工具配置。
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

同一轮的无工具调用 assistant 文本按顺序拼接到 `finalText`，保留完整报告和后续补充；工具调用旁的说明留在原生 Session。历史通知正文原样保留，通过 `turnId` 定位轮次，运行时不改写为新的用户指令。

## 身份与持久化

```text
roleId（角色定义）
  └─ runId（稳定任务身份）
       ├─ childSessionId / childSessionPath（稳定 Pi 上下文）
       └─ turnId（每次新建执行或 resume 的轮次）
```

当前记录版本为 v3：

内部任务身份统一使用 `runId`；公开回执 `agentId`、停止参数 `task_id`、`resume` 和 `to` 在接口边界投影或解析到它。旧 `legacy.agentId` 是历史角色身份，不能当作任务 ID 批量替换。

文本字段由新建与续接共用的 `buildTaskText()` 生成：

| 字段 | 来源和职责 |
| --- | --- |
| `instruction` | 主 Agent 本轮完整任务要求 |
| `description` | 本轮显式短标题，否则使用派生摘要 |
| `objective` | 任务要求合并空白后截取的 80 字符展示摘要，保留作 v3 兼容 |
| `RunnerRequest.prompt` | 实际执行输入，可包含续接前暂存补充；启动边界还可能加入随后到达的消息 |

展示摘要不参与执行。暂存补充和本轮要求按现有顺序发送，真实输入以 Pi Session 为准。磁盘文件职责如下：

- `request.json`：Pi 命令、参数、prompt、timeout、Jev 计划和必要环境变量；provider 环境变量只保存个人快照路径，不内嵌快照内容；
- `status.json`：任务、当前 turn、最终文本、错误、资源和用量状态；
- `results/*.json`：每个终态 turn 的快照；
- Pi Session JSONL：真实消息、工具调用和工具结果。

任务记录直接保存 `tools / disallowedTools / extensions`，不再复制成第二套“生效配置”对象。resume 使用保存的请求、这些直接字段和 Session，不重新读取角色文件。

`adaptStoredRun()` 是 v1/v2/v3 的集中读取边界。v3 的当前问题保留在 `pendingQuestion`；旧问答、报告、租约、结构化结果、工具证据和写权限进入 `legacy`。启动扫描只读历史。`SendMessage` 或显式 resume 续接时写为 v3，移除旧工具并刷新公共运行说明，原角色正文和 Pi Session 保留。

读取与执行使用不同的类型边界，磁盘结构仍保持平铺：

- `TaskIdentity` 表达跨轮次保留的任务、角色和 Session 身份。
- `RunDetails` / `PersistedRun` 是查看和恢复所用的兼容快照，允许旧状态和缺少旧版本未保存的字段。
- `CurrentExecution` 只接受 v3、现行状态，并要求 `turnId / resourceState / deliveryMode`。`beginTurn` 建立完整轮次后，执行启动、Pi 事件处理和异常回调才接收它；历史记录不能直接绕过 resume 启动。
- `ManagedRun` 管理当前进程拥有的运行和控制请求；历史任务只有经过续接校验才进入执行。会话丢失时保留历史并明确报错。

## 关键并发与失败边界

- `inTask(runId)` / 文件变更队列只序列化同一任务的输入和结束动作，避免 resume、SendMessage、settled、stop 交错；它不是跨任务调度器。
- 磁盘短锁和 recovery guard 都记录 owner/token；创建者异常退出留下的空锁、死亡 owner 或陈旧 recovery guard 可恢复，存活 owner 不能被其他进程删除。
- 终态历史先尝试保存，再发布可观察的 `released`；保存失败写入 `persistenceError`，不能静默丢失。
- RPC close 失败时保留 PID、连接和 `停止未确认`，`TaskStop` 可以重试；确认退出前不声称资源已释放。
- `ownerPid / childPid / runnerPid` 只用于真实进程归属和恢复检查，不代表实施者名额。
- 后台完成按 `runId + turnId + endedAt + status` 去重，问题按 `runId + turnId + questionId` 去重；只投递当前问题或完成结果给活动的所属父会话。快速结果由工具回执交付，切换会话或重载后保持历史可查。
- 保留标题为 `agent-deck:parent-message` 的原生 RPC 输入请求用于通信，其他交互式 UI 请求仍取消。

## Jev

`index.ts` 先从 `modelRegistry.getAvailable()` 过滤出隔离子 Pi 可加载的 provider，`routing.ts` 再按 Pi 报告的 thinking 动态产生候选。候选 ID 必须唯一；一个模型的多个输入档位映射到同一实际 thinking 时要去重。

Jev 只回答一个有限选择题：为已经定义的任务选择 `model + thinking`。它不决定角色、数量、DAG、是否委派或任务是否完成。只要存在兼容候选，选择失败就返回 fallback；没有兼容模型时由创建边界明确拒绝。只有调用方主动取消才向上抛出取消。

## 模块职责

| 模块 | 职责 |
| --- | --- |
| `index.ts` | 三个公开工具、动态 Agent 描述、命令与宿主事件接线 |
| `background-delivery.ts` | 当前父会话通知、初次回执协调和通知去重 |
| `tool-contract.ts` | 工具参数解析、角色映射、模型可见回执与公开结果投影 |
| `task-identity.ts` | 当前父会话内的任务/名称寻址与创建时名称绑定 |
| `types.ts` / `legacy-types.ts` | 稳定身份、兼容读取快照、严格当前执行与历史只读类型 |
| `agents.ts` | 角色发现、frontmatter 解析、旧字段迁移 |
| `instruction.ts` / `agents/*.md` | 本轮任务文本与摘要生成、子 Agent 行为提示和内置角色职责 |
| `runtime.ts` | 当前主 Pi 持有的任务控制器、steer、resume、停止和收口 |
| `run-store.ts` | 记录路径、父会话索引、磁盘读取缓存、原子写入及未完成创建的清理 |
| `rpc-connection.ts` | Pi JSONL RPC、子进程退出确认和可重试 close |
| `child-runtime.ts` / `child-providers.ts` | 隔离子进程加载入口与声明式 provider bridge |
| `parent-messaging.ts` | 子 Agent 通信工具和原生 RPC 问答信封 |
| `persistence.mjs` | 原子状态/历史保存、磁盘短锁和旧记录适配 |
| `delivery.ts` | 最终文本、当前问题、错误与通知投影 |
| `conversation.ts` | 只读解析 Pi Session 当前分支与工具记录 |
| `routing.ts` / `router.mjs` | 动态模型/思考候选、Jev 调用和软回退 |
| `ui.ts` / `presentation.ts` | 任务列表、只读会话、结果与资源状态 |
| `config*.ts` / `*ui.ts` | 全局和角色配置 |
| `agent-creation.ts` / `agent-authoring.md` | 自然语言创建角色及格式说明 |
| `scripts/check-docs.mjs` | 当前文档链接和退役合同检查 |

记录类型由 `types.ts` 提供，存储层不反向依赖运行控制器。`runtime.ts` 为现有内部调用保留存储辅助函数和 `PersistedRun` 的导出兼容。列表通过读取回调叠加当前进程的实时状态，控制动作使用绕过显示缓存的磁盘读取。

## 测试分层

1. 单元/模拟 RPC：状态机、输入竞争、持久化、失败注入、公开工具、TUI、配置和 Jev。
2. 真实 Pi 宿主 + 本地受控 provider：启动真实 Pi CLI/RPC，验证工具循环、前后台、消息、resume、停止和 Session。
3. 真实 Pi 宿主 + 本地测试扩展：验证角色扩展真的加载、`RoleProbe` 真的被模型调用、工具结果回到模型上下文、`edit/write` 排除生效。
4. 在线真实模型：不属于默认自动测试；只有明确执行后才能记录，不可用本地 faux provider 冒充。

`parent-control.test.ts` 启动真实父 Pi 与两个真实子 Pi，使用本地 HTTP 受控 provider；父模型端只读取转换后的请求正文，提取无名称任务 ID，再调用 SendMessage/TaskStop。它验证通信与寻址，不评价在线模型的自主调度质量。续接集成测试还核对原生 Session 中两条暂存补充和本轮任务要求的顺序及消费次数。

`parent-messaging.test.ts` 在真实父子 Pi 和 HTTP 模型输入边界验证前后台问答、回答后写入文件、完成后消息续接及历史原文。`rpc-integration.test.ts` 覆盖连续提问、过期回答、等待中停止/续接、进度通道、显式工具白名单与完整报告后追加摘要。

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
