# Agent Deck 开发约定

## 设计边界

0.12.0：用户与主 Agent 沟通；主 Agent 澄清、委派和验收；子 Agent 执行并返回结果。TUI 只读查看进度。保持 Agent / SendMessage / TaskStop 三个公开工具，完整参数见 README 和 src/tool-contract.ts。

- Agent 新建；Agent.resume 是已结束任务的唯一续接入口。运行中补充由 SendMessage 完成。
- SendMessage 是 QueueOnly，不启动空闲任务。新建和明确 resume 是 TriggerTurn。
- 程序管理最多 8 个活跃任务和进程生命周期；Jev 只选模型与思考强度。
- 子 Agent 无问答等待工具，遇到必要决定时返回阻塞结果，由主 Agent 处理。
- 执行结束不等于目标完成；子 Agent 报告不等于主 Agent 验收。

## 模块

| 模块 | 职责 |
| --- | --- |
| index.ts | 主工具、短调度提示词、主会话事件和命令 |
| tool-contract.ts | 参数解析、寻址字段、公开回执 |
| instruction.ts / agents/*.md | 子任务执行约定和角色说明 |
| runtime.ts | 当前主 Pi 持有的任务控制器、steer、明确 resume、停止和结果边界 |
| rpc-connection.ts | Pi JSONL RPC 请求、事件和子进程退出 |
| child-runtime.ts | 子提供商注册和一次性的最终 agent_report |
| capabilities.ts | 同一份实际工具清单用于模型说明与启动参数 |
| run-capacity.ts | 当前进程按主会话占位，固定 8，无排队调度器 |
| task-identity.ts | 当前主会话的任务 ID / 实例名称解析 |
| delivery.ts | 面板和主 Agent 共用结果说明、历史通知标注 |
| conversation.ts | 只读解析 Pi 当前分支，合并执行中的公开消息 |
| ui.ts / presentation.ts | 任务列表、只读会话、结果和资源状态 |
| persistence.mjs | 状态与历史结果保存，不承担消息恢复 |
| routing.ts / router.mjs | 候选模型策略、Jev 判断与回退 |
| child-providers.ts | 可序列化的子进程模型提供商配置 |
| config*.ts / *ui.ts / menu.ts | 中文配置、模型与角色编辑 |
| agent-creation.ts / agent-authoring.md | 角色创建规范 |

## 生命周期与保存

稳定 task/runId 和 childSessionPath 对应保存的 Pi 会话；每次新执行产生 turnId，清空本轮报告、验证、错误和活动记录。初始任务使用 Pi SessionManager 生成原生头和会话信息，在启动子进程前写入文件，避免 Pi 的延迟落盘创建出另一个 ID。resume 必须读到有效会话，不能创建空白替代。

先订阅 RPC 事件，再提交 prompt。运行中消息只用 steer；以 agent_settled 和当前 turn 的空闲快照判定结束。最终报告 terminate 直接结束本轮。模型错误原因与部分输出分开保存，恢复成功的单次重试错误不冒充整个任务失败。

结束时尝试保存结果，在 finally 中关闭子进程，确认退出后释放槽位。保存失败必须保留错误说明、执行清理并通知主会话。写入链失败不能阻断后续写入。停止清除消息；退出或重载不重放暂存消息。

历史记录中的问题字段只用于兼容读取。活动路径不再创建问题或等待答复。不新增持久回执、重试调度、工作树、写锁或自动验收层。

## 结果证据

TaskResult 包含 outcome、summary、completed、evidence、checks、remaining。每项检查是子 Agent 的自述，必须标明来源。工具成功写入可以证明发生过写入，不能证明功能正确。自然语言结果缺少结构化检查时显示未提供验证记录。

父会话通知和面板调用同一个 taskOutput。旧 turn 的通知标记为历史。主 Agent 的验收结论留在主会话，不从子 Agent 文本自动推导 UI 验收通过。

## 只读会话页

Pi 会话通过纯解析和 inMemory SessionManager 构造，不向会话文件写入。当前分支的历史消息与当前进程的 message_start/update/end 合并显示。只展示公开文本、工具参数及结果；长工具输出可展开。进入/退出页面不调用 prompt、resume 或 switchSession，不改变任务状态。

## 验证与发布

执行 npm run check、npm test 和 npm pack --dry-run。真实 RPC 测试使用隔离目录及本地可控模型，不调用付费服务。覆盖补充在工具边界送达、空闲消息不启动、同会话明确续接、保存失败清理、失败与部分结果、阻塞直接返回、停止、进程释放和模型策略。只读 TUI 验证包含真实会话及工具输出、滚动、宽度、只读按键。

版本号同步 package.json、package-lock.json 和 src/version.ts；更新 README、发布说明和计划。提交推送前检查工作区和差异。运行中的旧任务不强行迁移。
