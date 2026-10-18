# 04 · 事件、作用域与“到底哪个事件会被派发”

本文是本项目最贵的一课：**事件存在 ≠ 你的监听器会被调用**。

## 1. 先查契约，再写监听

```
cordis_inspect_query(platform: "host", provider: "Event", method: "listEvents", input: {})
cordis_inspect_query(… method: "listEvents", input: { event: "tools/pre-execute" })
```

返回里有 `mode`（`emit` / `serial` / `waterfall`）、`signature` 与相关类型。
waterfall 监听器形如：

```js
const dispose = ctx.on('tools/pre-execute', async (exec, next) => {
  const decision = await next()
  // 观察，不修改结果
  return decision
})
ctx.effect(() => dispose)
```

**不调用 `next()` 就会截断整条链**；要改结果时用 `{ ...decision, … }` 保留其余字段。

## 2. scope-filtered：监听器只收到自己作用域的事件

`approval/request`、`agent/pre-step`、`agent/request` 等事件是 `Scoped<Agent>` 的，
按 Agent 作用域派发。全局上下文注册的监听器**不一定**能收到某次调用触发的事件。

本项目实测：

| 操作 | `approval/request` | `tools/pre-execute` 返回 `ask` |
| --- | --- | --- |
| Agent 调 `plugin_manager`（提权到 danger-full-access） | ❌ 收不到 | ✅ 收到，且此刻弹出审批框 |
| 服务层策略拦下的 Agent 工具调用 | ✅（设计上） | ✅ |

结论：**要做“审批提示音”，两个点都要挂**；只挂 `approval/request` 会漏掉工具提权类审批。

## 3. 审批链路（源码事实）

- Host：`@deepseek-ai/dsh-user-approval` 提供 `ctx.approval`，把 `approval/request` 作为
  waterfall 分发给已组合的 answerers，默认 fail-closed，结果是
  `allowed-once | rejected | cancelled | unavailable`。
- Client：`@deepseek-ai/dsh-client-ui-approval` 在浏览器里
  `ctx.remote.$on("approval/request", (request, next) => answerApproval(…))`，渲染面板。
- 请求载荷字段：`{ agent, toolName, callId?, reason?, displayReason?, signal? }`
  ——足够用来判断“是否要响、响什么”。
- **审批面板弹出时调用方是阻塞的**：Agent 在审批期间无法执行任何工具、也无法截图，
  所以不能用“截一张审批框”的方式来验证。

## 4. 其他常用事件

| 事件 | 模式 | 用途 |
| --- | --- | --- |
| `tools/pre-execute` | waterfall | 放行/拒绝/询问；`ask` 即需要用户确认 |
| `tools/post-execute` | waterfall | 改写工具结果（不要用来记录） |
| `tools/result` | emit | 观察最终结果 |
| `agent/pre-step` | waterfall | 改写进入这一步的消息（seamless-continue） |
| `agent/created` / `agent/disposed` | serial / emit | 按 Agent 注册与回收 |
| `session/event` | emit | 会话事件推送（慎用，优先投影） |
| `approval/request` | waterfall | 审批（见上） |
| `user-questions/request` | waterfall | Agent 提问（`ask_user_question`），改结果需返回答案 |
| `agent/turn-stopping` | serial | 一轮即将结束；监听器可以 `agent.steer()` 让对话继续，所以提示音要“只观察、不干预” |

补充：`agent/turn-stopping` 是 **serial** 而不是 emit，监听器抛错会影响这一轮收尾。
只做副作用（例如播放提示音）的监听器必须自己 try/catch，绝不能把异常抛给总线。

## 6. 一个事件挂两个点：可重复的教训

本项目的提示音插件最终挂了四个监听：

| 提示音 | 事件 |
| --- | --- |
| 需要决定 | `approval/request` **和** `tools/pre-execute` 返回 `ask` |
| Agent 提问 | `user-questions/request` |
| 一轮结束 | `agent/turn-stopping` |

规律：**“用户被要求做决定”在 dsh 里有多条来源**（策略询问、审批服务、会话命令），
单挂一个事件必然漏。做法是挂全可能来源 + 一个短节流（`minIntervalMs`）把同一决策折叠成一次。

## 7. 调试事件的正确姿势

- **不要**在插件里写“临时日志到文件”然后靠审批触发来验证——一旦插件在审批时被卸载，
  监听器先没了（本项目探针多次这样“没日志”）。
- 先用**不依赖事件**的方式证明插件在跑：注册一个工具，用
  `cordis_inspect_query` 的 `Tool.listTools` 看它是否出现，再调用它。
- 需要时间线时，用 `session/event` 或 `tools/result` 这类高频、无副作用的事件旁路记录。
- `ctx.logger?.warn` 的输出通常只进 dsh 控制台，桌面应用里不一定看得到；
  需要可靠证据时写文件，但要把路径放在工作区内并在验证后删除。
