# Jev 模型与思考强度选配

Jev 在 Agent Deck 中只有一个职责：为一个已经定义好的子任务选择 `model + thinking`。

它不拆任务、不创建 Agent、不选择角色、不决定任务数量、不控制前后台、不安排执行顺序，也不判断任务最终是否完成。以上决定均由主模型通过 `Agent` 工具作出。

## 候选怎样产生

`index.ts` 先从当前 Pi `modelRegistry.getAvailable()` 读取模型，并过滤为隔离子 Pi 能加载的 provider；`routing.ts` 再根据每个兼容模型实际支持的 thinking 档位构造候选。

- 不按 Astra、Sol、Luna、reviewer 等名称建立硬政策；
- 不要求某个角色只能使用某个模型；
- 不设置角色最低 thinking；
- 一个模型的多个输入档位映射到同一实际 thinking 时只保留一个候选；
- `src/model-profiles.json` 只为已知组合补充软性的选择说明，不是 allowlist。

## 优先级与回退

1. 工具调用中明确给出的兼容 `model`，以及角色明确的 `model / thinking`，形成任务偏好。
2. 如果模型与 thinking 都已经明确且可用，直接使用，不调用 Jev。
3. 否则 Jev 在当前兼容组合中选择。
4. Jev 无密钥、超时、网络/HTTP 失败、返回无效或选择 `no_match` 时，沿用兼容的当前 Pi/角色回退配置并继续任务。
5. 配置中的偏好模型不可用或不能桥接时，回退到其他兼容模型；thinking 不受支持时由 Pi 能力映射到最近的可用档位。
6. 只有调用方主动取消才终止选择；Jev 自身失败不应阻止子任务运行。

若当前没有任何兼容模型，创建边界会在任务目录、子 Session 和名称绑定产生前明确失败。原生 provider，或配置中含函数、`symbol`、`bigint` 的扩展 provider，当前不能桥接到以 `--no-extensions` 启动的隔离子 Pi；这不是按型号或角色设置的硬名单。

选择完成后，任务把实际模型、thinking、选择模式、原因和耗时写入当前 turn。显式 resume 沿用原任务已经保存的模型和 Pi Session，不重新读取角色文件，也不重新运行 Jev。

## 发送给 Jev 的内容

请求只包含有限选择所需信息：

- 任务文本；
- 角色 ID 与职责说明；
- 角色显式 `tools`（省略时字段不进入 JSON）；
- 当前兼容的 `model + thinking` 候选及简短 criteria；
- 固定的选择说明。

Jev 密钥通过本地凭据文件或 `TYPESAFE_API_KEY` 读取，不写入任务状态、完成历史或子 Session。连接测试只读取服务元数据，不提交任务推理。

Jev 凭据与子模型 provider 快照是两类数据：可序列化的扩展 provider 配置按任务保存在 Pi 个人目录，可能包含 API key/header，用于启动与 resume；任务记录只保存快照路径。该文件不进入项目或 npm 包，必须按认证文件处理，不应提交或分享。

## 配置与命令

- `/agent-router` 或 `/agent-config jev`：打开 Jev 配置；
- `/agent-route-test Explore 调查登录问题`：只试选一次，不创建任务、不打开已关闭的自动选配；
- `/agent-config`：同时管理 Agent Deck 开关、全局时限、角色和 Jev；
- `modelAliases`：把短别名明确映射到 `provider/model`。

默认配置：

```json
{
  "routing": {
    "enabled": true,
    "model": "jev-1.13.0",
    "timeoutMs": 15000
  }
}
```

`routing.timeoutMs` 只限制 Jev 选择请求；任务本身的执行时限由全局或角色 `timeoutMs` 控制，`0` 表示不限时。

## 验证边界

自动测试分别覆盖：

- 动态候选来自当前 Pi 中可由隔离子进程加载的模型；
- 不按角色或型号硬过滤；
- 本地 HTTP Jev 请求、选择、用量解析和密钥不落盘；
- 无效返回、无密钥、HTTP 错误和超时全部软回退；
- 调用方取消不会被回退吞掉；
- Jev 选配期间仍能接收 `SendMessage`，取消后迟到响应不能启动子进程。

这些测试证明路由合同与失败边界，不代表任何模型的质量基准或在线模型身份验证。
