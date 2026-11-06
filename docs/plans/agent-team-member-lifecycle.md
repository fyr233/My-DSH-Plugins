# 成员模型热切换 与 成员删除 — 方案 v5（A 已实现）

> 基线：Harness `0.2.1-rc.3`。现有插件 `plugins/agent-team-model` 已上线（只替换工具层 + bridge，未动 core）。
> 审核记录见本文 §5。

## 实施状态

| 需求 | 状态 |
| --- | --- |
| A 创建后改模型 | **已实现**：`set_teammate_model` 工具 + `list_agents` 显示修复 + 12 项新单测 |
| B 删除成员 | **未实施**，等用户选路线（退役 / 调高 maxMembers / 替换 core / 等上游） |

单测 34 项通过；`verify-vendor` 通过（删 6 / 加 270）；仓库校验本插件 0 错误。

## 需求 A：Lead 在成员创建后修改其模型

### 结论：可行，插件层，不需要改 core

### 机制

模型路由由「selection 对象」驱动。`dsh-agent:167` 的 `installModelSelection` 在 agent 上装两个 waterfall：

```js
agentCtx.on("system-prompt/assemble", async (_a, _c, next) => { const selected = selection.current; ... })
agentCtx.on("agent/request",        async (_p, next) => { const selected = selection.assembled; ... })
```

它们读的是 `selection.current`（可变）。改它的方法是
`ApiSessionAgentController.selectForNextRequest`（`dsh-api-session-controller/lib/index.js:312-315`）：

```js
selectForNextRequest(agent, selection) {
    agent.session.append("model/selection", selection);
    this.selectionFor(agent).current = selection;
}
```

`SessionController` 实例暴露普通属性 `this.agents = new ApiSessionAgentController(ctx)`
（同文件 **2956**，2955 是 `installModelSelectionProjection(ctx)`），所以插件里：

```js
ctx.get('sessionController').agents.selectForNextRequest(agent, selected)
```

### 关键取舍：不要用 `selectModel`

`sessionController.selectModel`（方法头在 **3098**，`return this.commands.selectModel(request)` 在 3099）
是唯一挂到 Remote 面的入口（`typert.host.js:2067`），但它多做一件事：

```js
index.js:809  this.ctx.agentDefaultModel.saveSelection(selected).catch(...)
```

**会改全局默认模型。** 给"改某个成员"用它是错的。`selectForNextRequest` 没有这个副作用，
但它是内部 API（不在 Remote 面上）——所以插件启动时要自检方法存在性，缺失即明确报错。

### 实现

新工具 `set_teammate_model`（Lead-only），参数 `target` / `model` / `provider` / `reasoning_effort`：

1. `ctx.agentTeams.listMembers(caller)` 找目标行（带 `id`），`ctx.agents.get(id)` 取 live Agent；
   非本团队成员 / 非 teammate → 报错。
2. 路由校验复用 `route.js` 的白名单逻辑（`subagentModelSelection`）+ `llm.resolveCallConfig` preflight，
   与 `spawn_teammate` 同一套。
3. **幂等**：先读 `stateOf(...)` 的 `pending`，与目标路由相同则跳过（否则会多落一条无效事件；
   投影层本身会去重，状态不会错位）。
4. `sessionController.agents.selectForNextRequest(agent, selected)`。

### 生效时机与前提（必须写进文档）

- **只在下一次 `system-prompt/assemble` 生效**。正在跑的 turn 用旧路由跑完；在途请求不会被串
  （assemble 时把 `selection.current` 快照进 `selection.assembled`，`agent/request` 只读快照）。
- **`selectionFor` 是惰性安装**：第一次被调用时才 `installModelSelection`（`index.js:303`）。
  对团队成员而言，**第一次 `set_teammate_model` 才第一次装那两个 waterfall**。
- controller 丢弃了 `installModelSelection` 的 disposer（303 行直接调用不保存）。若
  `sessionController` 在团队运行中重载，会在同一 `agent.ctx` 上重复安装监听器，
  waterfall 里先注册的在最外层、最后应用，**旧 selection 可能压过新的**。
  因此文档要求：**不要在团队运行中重载 sessionController**。

### 显示修复（必须做，否则 `list_agents` 会撒谎）

基线 `agent-team:923` 是：

```js
const model = live?.options.model ?? root.options.model;
```

两个问题：① 创建后切换过模型的成员，`options.model` 是**创建时**的旧值；② 成员不 live 时
会回退到 **Lead 的模型**（跨成员串味）。

修法放在我们的工具层（`list_agents` 的输出本来由我们构造）。三级回退，**去掉 `?? root.options.model`**：

```
projection = ctx.sessionProjections.stateOf(session, 'modelSelection')
session    = live?.session ?? ctx.sessions.get(id)
model      = projection?.pending ?? projection?.lastUsed ?? live?.options.model   // 都无则整个字段省略
```

- `stateOf` 返回的是 **state** `{lastUsed, pending}`，不是 wire view；面板用的是 `pending ?? lastUsed`，
  这里必须一致（只取 `lastUsed` 会在"已切换但还没跑"时显示旧模型；只取 `pending` 会在跑完后变 null）。
- 成员不 live 时用 `ctx.sessions.get(id)` 取 Session 再 `stateOf`；取不到就**不填 model**，
  绝不回退成 Lead 的模型。
- `stateOf` 只在投影未注册时返回 `undefined`；新会话返回 `init` 的 `{lastUsed:null,pending:null}`
  （`dsh-session-projection/lib/index.js:127`），所以"刚创建、零请求"的成员不会抛错。

### 边界

- ~~成员 `inactive` 时改同样有效，下次唤醒生效~~ —— **实测推翻（2026-11-06）**：inactive 成员的
  Session 没有挂载进内存（`ctx.agents.get()` 与 `ctx.get("sessions").get()` 都取不到），
  调用直接抛 `set_teammate_model: teammate "<name>" has no Session to change`，
  什么都没写进去。要先 `send_message` 把成员唤起成 live 才能改。
- 纠正后，`model/selection` 的冷写分支（`session === undefined` 时的 `session.append`）
  **实际不可达**——它依赖一个拿不到的 Session 对象。留着无害，但不要据此声称支持冷成员。

## 需求 B：删除成员

### 结论：插件层做不到真正的删除；真删除必须改 core

### 依据（比 v5 初稿更硬）

1. journal 只有四类事件（`agent-team:535`）：
   `team/member | team/task | team/message/queued | team/message/delivered`
2. 成员 phase 只有三值，且 schema 是 **`.strict()`**（451-457、654-658）：
   加一个 `removed` 会让**重放直接失败**，不是"多一个字段"那么简单。
3. roster 只增不减：`replaceAt(items, -1, item)` 实际是 push；`buildTeamProjection` 不过滤成员（685-704）。
4. 名额按条数：`agent-team:1025  if (state.members.length >= this.maxMembers)`。
5. `reconcileProvisioning` 只把 provisioning 结算成 active/failed（1113-1114）；
   `disposeRuntime`（1627）只拆运行时、**不碰 roster**。
6. 任务板有删除（466/669/700 的 `status: "deleted"`），成员没有。

### 插件层能做到的："退役"，且**不持久**

只 `drainChildren`（对空闲成员 `interrupt` 是空转）：

- `drainChildren` 对**非驻留**子级直接 `continue`（`dsh-subagent:1377-1378`）——对已 inactive 的成员是 no-op。
- **更关键**：子代理层会在收到消息时对"当前不驻留的直接子级"做**持久化冷恢复**。
  所以退役后任何一条 `send_message` 都会把它拉起来，retire 完全失效。

因此退役必须同时在我们**自己 vendor 的 `send_message`** 里拦截（这是唯一的可行点），
并且明确写：**退役状态只在内存，重载/重启后丢失**。不能对外宣称持久语义。

槽位会归还：`materialize` 在 1678 `pool.reserve`，正常路径挂在 activation 上，
由 `finishDisposal` 在 **2036** `activation.releaseSlot()`；`drainChildren → dispose → close → finishDisposal` 会释放。
注意 `maxActiveSubagents` 与 `maxMembers` 是两个独立上限。

### 真删除的代价

替换 `dsh-experimental-agent-team`：新增移除语义 + roster 过滤 + schema 变更（`.strict()` 决定了
必须同时改重放兼容）。代价：

- 挂载期触发 `disposeRuntime()`（1473-1482），**拆掉所有运行中的团队**；
- 整个团队运行时成为我们的副本，上游修复不会进来。

### 折中

不动核心。把 profile 里 `agent-team` 行的 `maxMembers`（现在 8）调高，让"退役但未删除"的行
不阻塞后续创建——只需改 profile 的 patch config，不动代码。

## 5. 审核记录

| 项 | 结论 |
| --- | --- |
| B1 行号错（2955/3099/312） | 接受，已改为 2956 / 3098 / 466·669·700 |
| B2 非 live 成员显示回退到 Lead 模型 | 接受，三级回退 + 去掉 `?? root.options.model`，非 live 用 `ctx.sessions.get(id)`。**实测补注（2026-11-06）：三级回退对 inactive 成员仍失效**——`ctx.sessions.get(id)` 返回 undefined，`pickMemberModel` 得到 undefined，代码原样返回服务层的行（即 Lead 的模型）。要真正修好，得走 `sessionController.inspect(sessionId)` 从持久层读，属于未做的改进。 |
| B3 retire 不持久、`send_message` 会冷恢复 | 接受，改为"内存态 + 在自有 `send_message` 拦截"，文档标注非持久 |
| B4 `selectionFor` 惰性安装 / disposer 被丢弃 | 接受，写入前提，并要求不在团队运行中重载 sessionController |
| B5 零请求成员的 `stateOf` | 已核实：未注册才返回 undefined，新会话拿 init `{lastUsed:null,pending:null}`；仍列入测试 |
| S1 重复 append 幂等 | 接受，调用前比对 `pending`，相同则跳过 |
| S2 `pending ?? lastUsed` | 接受，写入显示规则 |
| S3 retire 只 drain；maxMembers 在 profile config | 接受 |
| S4 `selectForNextRequest` 非 Remote，需启动自检 | 接受 |

## 6. 验证计划

| 用例 | 断言 |
| --- | --- |
| 刚创建、零请求的成员改模型 | 不抛错；`list_agents` 显示新模型 |
| 切换后不重复设置同一路由 | 不新增 `model/selection` 事件 |
| 白名单外的路由 | 拒绝，列出行车范围 |
| `enabled: false` | 拒绝 |
| 成员 inactive 时切换 | **实测：抛 `has no Session to change`**，不写任何事件；须先 `send_message` 唤起 |
| 在途 turn 切换 | 当前 turn 用旧路由，下一轮用新路由 |
| 退役后 `send_message` | 被拦截，成员不被冷恢复 |
| 不带新参数调用 `spawn_teammate` | 与旧版完全一致（回归） |

> 已验证的完整事件链见 `plugins/agent-team-model/README.md` 的「会话日志里的完整证据链」：
> `model/selection`(seq 50) → `[model changed: …]` 提示(seq 55) → `request/header` 且
> `reason: change`(seq 56)。`reason` 从 `resume` 变 `change` 是"真的生效"最直接的标志。
