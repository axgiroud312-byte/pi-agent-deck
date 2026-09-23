# Jev 组合与验证

主 Agent 决定子任务数量、角色、分工、依赖和验收；Jev 只为一个已经定义的新子任务选择执行模型与思考强度。程序负责可用性、固定配置、取消、超时与落盘。

## 强制模型策略

从 0.9.2 开始，`src/model-profiles.json` 的 `policy` 与 `profiles` 是运行时规则和选项的统一来源。规则覆盖自动选配、显式配置、别名、关闭选配、失败回退，以及旧任务的下一次启动或继续。

- 审查角色只使用 GPT-5.6 Sol，最低 `xhigh`；GPT-5.6 Sol 也只供审查使用。
- GPT-6 Sol 与 GPT-6 Luna 最低 `high`，用于非审查角色。
- GPT-6 Astra 保留 `low/medium/high/xhigh/max`，用于非审查角色。
- 角色 ID 为 `reviewer` 或配置含 `reportProfile: 审查` 即视为审查。自定义角色需显式标记；主 Agent 负责按职责选择角色，不由 Jev 判定角色。

以下 13 个组合的用途是待实测的起始建议，模型专用范围和强度下限则是硬约束。实际候选还要通过同一提供商、账户可用性、工具接口及 Pi 模型能力筛选；不会把模型能力表里的更低档位重新加入。

| 组合 | 起始试用范围 |
|---|---|
| GPT-5.6 Sol / xhigh | 审查默认起点：检查改动、边界和证据，交付带位置的可操作问题 |
| GPT-5.6 Sol / max | 极复杂审查：并发、多个系统相互作用、安全边界，接受更长耗时 |
| GPT-6 Sol / high | 日常实现、模块排错、重构和测试，最低允许档 |
| GPT-6 Sol / xhigh | 既定设计内的高难度实现、深入排错 |
| GPT-6 Sol / max | 极难且边界清楚的工程任务，需衡量额外耗时 |
| GPT-6 Luna / high | 聚焦的小型实现、局部多步调查和验证，最低允许档 |
| GPT-6 Luna / xhigh | 边界清楚的困难小任务，试验增加推理是否有效 |
| GPT-6 Luna / max | 少量可严格验收的高难度局部任务 |
| GPT-6 Astra / low | 指令或约束较复杂，但推理路径较短 |
| GPT-6 Astra / medium | 跨模块实现、多项约束的综合判断 |
| GPT-6 Astra / high | 复杂系统排错、状态变化、架构设计 |
| GPT-6 Astra / xhigh | 证据充分、假设较多、相互制约的高难度任务 |
| GPT-6 Astra / max | 质量优先的最难实现或调查任务，常用前需真实评估 |

模型能力与思考强度是两条维度，不把不同模型的档位排成同一条能力阶梯。这里的“审查”是角色职责，和实现过程中自测、排错区分；主 Agent 应把独立审查工作交给审查角色。

GPT-6 Sol/Luna 的推理工具调用要求 Responses。`openai-completions` 的 `off` 工具调用不满足最低 `high`，因此整组不进入候选。显式指定不兼容接口时提示修正。模型注册表将高档映射到低档时，也不能绕过最低强度。

## 运行决策

1. 识别审查角色，再合并明确参数：本次明确指定 > 角色固定值 > 继承值。任何显式值都必须符合强制策略。
2. 构造合规回退：继承模型合规时保留；继承强度低于下限时提高到实际支持的合规档位。审查改用同一提供商的 GPT-5.6 Sol；非审查从 GPT-5.6 Sol 继承时，按 GPT-6 Sol → Astra → Luna 找到同一提供商的可用模型。无合规组合则派遣前报错。明确固定模型时不替换它。
3. 固定强度时，仅保留支持该档且符合角色策略的模型。例如未固定模型的非审查 `low` 可以选择 Astra；固定 GPT-6 Sol + `low` 则拒绝。关闭选配同样执行策略。替补顺序只用于回退，不限定 Jev 的正常选择。
4. 关闭选配、模型和强度都固定、或只有一个候选时不请求 Jev；其余使用 Choice API 选择一个组合，并保留 `no_match`。
5. 校验选项、完整概率分布、总和、最高概率选择与置信度类型。错误、超时、缺少密钥或 `no_match` 均使用合规回退配置，记录原因。
6. Runner 在等待接口前保存身份。取消与最后启动步骤共用短锁；实际模型和强度持久化后再次校验才启动。
7. 保存审查角色快照，继续不重选。旧排队任务不合规时保存失败；旧终态任务不合规时拒绝继续并要求新建。原有结果和补充文字保留，自动补充因策略失败后停止重试。停止和读取结果仍可使用。

已经在运行的进程不会被升级自动切换模型或终止。旧自定义审查角色如果没有 `reportProfile: 审查`，先给角色补上标记，再新建任务；旧运行记录无法从任务文本可靠还原角色类型。

程序不把分布置信度当作正确率，不设置未经校准的升档门槛。Jev 不在运行中换模，不决定数量或角色，也不自动增加审查 Agent。

## 记录与评估

任务状态及每轮结果保留最终模型、思考档位、选择或回退原因、选配耗时、请求与响应 Jev 版本、概率分布和接口返回的 token 用量。TypeSafe 密钥仅来自环境变量，不写入这些记录；HTTP 错误只记状态码。

下一步把真实中文任务分为审查与非审查两组。审查比较“Jev 选择”“固定 GPT-5.6 Sol xhigh”“固定 GPT-5.6 Sol max”；非审查比较“Jev 选择”“固定 GPT-6 Sol high”“固定 Astra medium”。对同一输入、仓库状态、工具权限和验收标准运行，记录首次验收是否通过、返工次数、任务总耗时与模型用量。先观察，再调整候选描述和默认策略。请求 token 或模型目录中的估价不能直接当作订阅账号账单。

当前自动化测试使用本地 HTTP 服务、模拟 Choice 结果及真实受控子进程。这证明流程和接口处理可用，不证明真实 Jev 的选模质量、线上延迟或中文任务表现。真实服务测试必须单独配置 TYPESAFE_API_KEY。

## 官方依据

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)：typed questions/answers 与 Choice 响应。
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)：模型与支持的思考档位。
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)：模型与支持的思考档位。
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)：支持 none/low/medium/high/xhigh/max，推理工具调用要求 Responses。
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)：支持 none/low/medium/high/xhigh/max，推理工具调用要求 Responses。

GPT-6 Sol/Luna 文档核对日期：2026-09-23。Astra 与 GPT-5.6 Sol 的初始策略核对日期：2026-09-22。
