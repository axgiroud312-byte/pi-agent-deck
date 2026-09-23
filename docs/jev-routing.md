# Jev 组合与验证

主 Agent 决定子任务数量、角色、分工、依赖和验收；Jev 只为一个已经定义的新子任务选择执行模型与思考强度。程序负责可用性、固定配置、取消、超时与落盘。

## 初始组合

这是依据官方能力边界设计的起始策略，不是实测性能结论；这些描述也保存在 src/model-profiles.json，作为发给 Jev 的选项标准。共定义 23 个组合，执行时按同一提供商、账户可用性和 Pi 支持档位筛选。下表原有 Sol 指 GPT-5.6 Sol。

| 组合 | 初始试用范围 |
|---|---|
| Sol / none（Pi off） | 从已提供事实中摘录或固定格式转换，几乎无需推理；试用档 |
| Sol / low | 范围明确的短调查、小修改、简单函数解释 |
| Sol / medium | 日常实现、局部定位、测试和常规审查 |
| Sol / high | 模块内复杂排错、重构和深入审查 |
| Sol / xhigh | 特别困难但范围明确的问题，实际比较 Astra 的结果 |
| Sol / max | 高难度、可容忍时延的 Sol 任务，需证明额外推理有收益 |
| Astra / low | 指令理解或约束细节复杂，但推理路径较短 |
| Astra / medium | 跨模块工作、多项约束的综合判断 |
| Astra / high | 并发、状态变化、多个系统相互作用、重要架构与安全边界 |
| Astra / xhigh | 证据充分、假设较多、相互制约的高难度问题 |
| Astra / max | 质量优先的最难任务；常用前需真实评估 |
| GPT-6 Sol / none（Pi off） | 明确事实的固定格式转换，不需要多步推理 |
| GPT-6 Sol / low | 短小明确的代码任务、定点调查和小修改 |
| GPT-6 Sol / medium | 日常实现、测试、排错和常规审查的起始组合 |
| GPT-6 Sol / high | 范围明确、约束相互关联的复杂模块任务 |
| GPT-6 Sol / xhigh | 既定设计内的高难度实现、深入排错 |
| GPT-6 Sol / max | 极难但边界清楚的问题；与 Astra 的实际结果比较 |
| GPT-6 Luna / none（Pi off） | 重复摘录、格式整理和明确事实分类 |
| GPT-6 Luna / low | 查找符号、简单修改、窄范围证据提取 |
| GPT-6 Luna / medium | 清晰需求下的小型实现、可重复调查和配套修改 |
| GPT-6 Luna / high | 局部多步推理，结果容易检验、架构歧义较少 |
| GPT-6 Luna / xhigh | 边界清楚的困难小任务，试验增加推理是否有效 |
| GPT-6 Luna / max | 极少数可严格验收的聚焦任务；不视为 Sol/Astra 的等价替代 |

模型能力和思考强度是两条维度，不能把 Sol high 与 Astra low 当作固定的前后等级。实际可选项还取决于 Pi 模型注册表、当前提供商及用户固定的配置。Astra 不提供 none 档；Pi 的 minimal 可能映射为 low，任务记录显示归一后的档位。

GPT-6 Sol/Luna 的推理工具调用需要 Responses。若 Pi 中配置的是 `openai-completions`，程序仅保留支持工具调用的 `off` 组合；固定为其他档位会提示修正接口或配置。候选表中的更高档位不代表当前账户一定可用，也不代表实际任务收益更高。

## 运行决策

1. 合并明确参数：本次用户指定 > 角色固定值 > 自动选择；回退继承创建时的主会话设置。
2. 固定模型时只选择强度；固定强度时只选择兼容模型。若原模型不支持固定强度，自动选配开启时可使用同提供商的兼容候选作为回退；无兼容候选则派遣前报错。
3. 关闭自动选配或两项固定时，不调用 Jev。只有一个合法组合时也不调用。
4. 使用官方 Choice API，问题只要求判断当前子任务最适合哪个组合。保留 no_match 选项。
5. 校验选项、完整概率分布、总和、最高概率选择与置信度类型。错误、超时、缺少密钥或 no_match 均记录回退原因。
6. Runner 在等待接口前保存身份，因此主会话不等待 Jev 返回。取消与最后启动步骤共用每任务的短锁。
7. 选配结果与执行参数先持久化，再启动；后续继续使用已保存参数。尚未完成首次选配便取消的任务，显式继续时可重新尝试首次选配。

程序不使用未经校准的“置信度低于 0.7 就升档”规则，也不把分布置信度当成正确率。v1 不在运行中自动换模，不自动增加 Agent，不调用额外审查 Agent。

## 记录与评估

任务状态及每轮结果保留最终模型、思考档位、选择或回退原因、选配耗时、请求与响应 Jev 版本、概率分布和接口返回的 token 用量。TypeSafe 密钥仅来自环境变量，不写入这些记录；HTTP 错误只记状态码。

下一步用一组真实中文任务比较“Jev 选择”“固定 Sol medium”“固定 Astra medium”。对同一输入、仓库状态、工具权限和验收标准运行，记录首次验收是否通过、返工次数、任务总耗时与模型用量。先观察，再调整候选描述和默认策略。请求 token 或模型目录中的估价不能直接当作订阅账号账单。

当前自动化测试使用本地 HTTP 服务、模拟 Choice 结果及真实受控子进程。这证明流程和接口处理可用，不证明真实 Jev 的选模质量、线上延迟或中文任务表现。真实服务测试必须单独配置 TYPESAFE_API_KEY。

## 官方依据

- [TypeSafe HTTP API](https://docs.typesafe.ai/api)：typed questions/answers 与 Choice 响应。
- [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)：模型与支持的思考档位。
- [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)：模型与支持的思考档位。
- [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)：支持 none/low/medium/high/xhigh/max，推理工具调用要求 Responses。
- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)：支持 none/low/medium/high/xhigh/max，推理工具调用要求 Responses。

GPT-6 Sol/Luna 文档核对日期：2026-09-23。Astra 与 GPT-5.6 Sol 的初始策略核对日期：2026-09-22。
