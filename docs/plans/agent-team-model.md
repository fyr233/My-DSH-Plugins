# Agent Teams 每成员模型 — 实施方案 v3（已实施，待终审）

> 状态：**代码已写**，等待 `plan-skeptic` 终审后安装。
> 基线：`@deepseek-ai/dsh-experimental-tool-agent-team@0.2.1-rc.2`，`lib/index.js` sha256
> `cac22fe5f83a179056469cf329def58393c7620eae23b018c66f42c37d849f63`。

## 0. 硬约束

1. 不改动现有 agent-team 插件（其它 agent 正在使用）。
2. 不 fork `deepseek-harness`，不重编 Electron。
3. 安装由用户在空档期执行。

## 1. 根因（已核实）

| 位置 | 现状 | 后果 |
| --- | --- | --- |
| `tool-agent-team/lib/index.js:253-274` | 参数只有 `name/description/prompt/context` | 模型无从传入 |
| 同文件 `:287` | `provider` 是子代理后端（`spawn`/`fork`） | 不是 LLM 路由 |
| `agent-team/lib/index.js:1032-1042` | `startActivation` 的 `request` 只有 `{prompt, parent}` | 无 `agentOptions` |
| `agent-team/lib/index.js:922` | `live?.options.model ?? root.options.model` | 成员只能继承 |

子代理层本来就通：`dsh-subagent:1400` → `resolveChildAgentOptions(parent, request.agentOptions, childDepth)`；
`spawn`/`fork` 均声明 `capabilities.agentOptions = true`。上游 `master` 与已装版本一致。

## 2. 架构决策：只换工具层，不换服务

**这是 v2 之后最大的改动。** v2 计划同时 vendor core；终审指出替换 `agent-team` 服务会在挂载期
触发构造期 effect 的 `disposeRuntime()`（`agent-team:1473-1482`），**拆掉所有运行中的团队**。
在"其它 agent 正在使用"的约束下不可接受。

改为：

```
spawn_teammate (本包 tool/)          ← 替换内置 tool-agent-team（disable + 新 id）
   ├─ planTeammateRoute()            纯函数：参数解析 + 白名单 + 报错文案
   ├─ llm.resolveCallConfig()        preflight：路由不可调用则建成员前失败
   └─ withTeammateAgentOptions(opt, () => agentTeams.spawnTeammate(...))
        └─ AsyncLocalStorage 打标
             └─ ctx.subagents.startActivation   ← bridge/ 包一层，只读标记
                  └─ 合并 request.agentOptions → resolveChildAgentOptions()
```

`agent-team` 服务**一个字节都不改**，`ui-agent-team` 不动，`team/member` 事件仍是 `version: 2`。

### 为什么 ALS 可靠（已核实，非猜测）

- `lifecycle.track(operation)` 是**同步**的：`operations.add(op)` 后原样返回 promise（`lifecycle.js:52-56`）。
- `journal.transact` 是普通 `await`，不新建 async 上下文。
- 因此 `spawnTeammate → spawn → spawnAdmitted → startActivation` 全程保持同一 store。
- `startActivation` 的入参里有 `childId`，但**不需要**用它关联——标记是随调用链走的，不靠比对。

### 为什么覆盖服务方法可行（cordis 代理语义，已核实）

`ctx.subagents` 是 `createTraceable` 代理（`cordis/lib/index.js:125-157`）：

- `set` → `Reflect.set(target, prop, value, shadow)`（145-152），**直接写到真实服务实例**。
- `get` → 函数被 `createShadowMethod` 包一层（140-143），`apply` 仍调用我们的 wrapper。
- 卸载时用 `delete ctx.subagents.startActivation` 删掉 own property，原型方法重新可见
  （赋回原函数会把 traceable 代理存成 own value，是错的）。

## 3. 白名单复用（不新增配置面）

`ctx.get('subagentModelSelection')` → 与 `dsh-tool-subagent` 同一个服务
（`dsh-tool-subagent:538` 同款调用）。`current()` 返回 `{ enabled, allowedModels }`。

| 服务状态 | 带 `model` 时 |
| --- | --- |
| 不存在 | 放行 |
| `enabled: false` | 拒绝 |
| `enabled: true` | 必须命中，否则列出行车范围 |

**有意差异**：子智能体是 per-Session 快照（`recordSubagentModelSelection`），团队侧读 live 配置。
文档已写明，不再声称"照抄"。

## 4. 三道防线（终审补充）

1. **参数校验**：`provider` 必须配 `model`（否则报错，不静默丢弃）。
2. **白名单**：命中 `allowedModels`。
3. **preflight**：`llm.resolveCallConfig({provider, model, reasoningEffort?}, signal)`。
   没有这道，模型 id 打错会留下一个 `active` 但永不产出的成员——失败只在子会话首个请求暴露，
   而那时成员已被 settle 成 `active`（`agent-team:1059-1073`）。

## 5. 补丁清单

| 文件 | 改动 |
| --- | --- |
| `tool/index.js` | vendor 自 `tool-agent-team`，`verify-vendor` 实测：删 2 行、加 110 行 |
| `route.js` | 新增。纯函数 `planTeammateRoute`，无宿主 import，可单测 |
| `als.js` | 新增。AsyncLocalStorage 打标/读取 |
| `bridge/index.js` | 新增。包装 `startActivation`，约 40 行 |
| `index.js` | 新增。`.` 入口转出 bridge（保证 validator 能独立加载） |
| `cordis.patch.yml` | `disable tool-agent-team` + insert 两个新 id |

`cordis.patch.yml` 关键点：

- **新 id**（`tool-agent-team-model` / `agent-team-model-bridge`），不再复用被 disable 的 id，
  避免出现两行同 id 依赖 loader 的 Map 去重巧合。
- **config 抄全**（`interrupt`/`freshProvider`/`forkProvider`）：insert 不继承被覆盖行的 config，
  漏抄会退回服务默认值。
- 必须排在 `agent-team-profile` 之后（`install_bundle` 追加到末尾，天然满足）。

## 6. 验证

| 项 | 命令 / 做法 | 结果 |
| --- | --- | --- |
| 单测 20 项 | `node plugins/agent-team-model/test/check.mjs` | **通过** |
| vendor 形状 | `node plugins/agent-team-model/verify-vendor.mjs` | **通过**（删 2 / 加 120，sha256 命中） |
| 仓库校验 | `node scripts/validate.mjs` | 本插件 0 错误 |
| 加载 | `Tool.listTools` 出现 `model`/`provider`/`reasoning_effort` | 待安装后 |
| 功能 | 两个成员不同模型；**成员产生首个请求后**看侧边栏 | 待安装后 |
| 回归 | 不带参数 spawn，行为同旧版 | 待安装后 |

单测覆盖：无参继承、只给 model、provider+model、只给 effort、provider 缺 model 被拒、
白名单外被拒（含可用列表）、`enabled:false` 被拒、服务缺失放行、服务自抛转诊断、
父 provider 不可解析、ALS 作用域隔离、bridge 注入、bridge 透传不变、bridge 卸载还原、
bridge 缺接缝报错。

> 注意：`list_agents` 不能单独用来验证模型——成员非 live 时 roster 回退到
> `root.options.model`（`agent-team:922`）。要看侧边栏，且必须等成员发出首个请求
> （`modelSelection` 投影由 `request/header` 驱动，spawn 返回时还是 `null`）。

## 7. 风险

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| 版本耦合 | 绑定 0.2.1-rc.2 内部接缝 | `verify-vendor.mjs` 报基线漂移；README 记 sha256 |
| 工具重注册 | 安装时内置工具表会重建（服务不拆） | 非团队会话期间安装 |
| `fork` + 换模型 | fork 继承父上下文，换差异大的模型语义不保证 | README 标注 |
| 配置寻址 | 内置 `tool-agent-team` 被 disable，按旧 id 调配置打不到新行 | README 写明改 `tool-agent-team-model` |

## 8. 已验证 / 待验证

- **已覆盖**：`route.js` 全部决策分支、`als.js` 作用域、`bridge` 的注入/透传/卸载。
  bridge 用例跑在 `test/support/cordis-traps.mjs` 上——它忠实复刻 cordis 的 traceable 代理
  （`get` 每次返回新函数代理、`set` 落 raw、`delete`/`getOwnPropertyDescriptor` 转发 raw）。
  普通对象建的假对象会让 `=== wrapped` 意外成立，从而把 B1 这类缺陷整个建模掉。
- **仍待运行时验证**：真实 cordis fiber 下重载插件后 `spawn_teammate` 是否重复注册；
  以及 `Tool.listTools` 是否出现三个新参数。这两项只能安装后看。

## 9. 审核裁决记录

| 审核项 | 结论 |
| --- | --- |
| M1 insert 丢配置 | 接受，已抄全 config |
| M2 `agent.options.provider` 取错源 | 接受，改用 `parentAgentOptionsForDelegation` |
| M3 伪代码不可执行 | 接受，重写为 `route.js` + 逐个错误分支 |
| M4 与子智能体语义不同 | 接受，声明为有意差异 |
| M5 缺 preflight | 接受，已加 `resolveCallConfig` |
| M6 投影写入时机 | 接受，修正理由与验证方法 |
| M7 同 id 两行 | 接受，改新 id |
| M8 行号偏差 | 接受，全部按更正后的行号引用 |
| §10.1 伪二选一 / ALS 方案 | 接受，采方案 A（只换工具层） |
| **B1** 还原守卫恒假（代理陷阱） | 接受。cordis 每次 `get` 都返回新代理，`=== wrapped` 永远为假 → 卸载不还原、重载叠包装。改 `Reflect.getOwnPropertyDescriptor(...)?.value === wrapped`，并把 40 行 trap 复刻固化为测试替身 |
| **B2** 只给 effort 时跳过白名单 | 接受。`assertAllowed` 移出 `if (wantsModel)`，对**生效路由**校验；`enabled:false` 同样能拦住 effort 注入 |
| S1 `verify-vendor` 基线自指 | 接受，sha256 硬编码进常量，与 README 一致 |
| S2 README 补 `this.ctx` 差异 | 接受，已写入「两个需要知道的实现细节」 |
| S3 静默兜底 | 接受：provider/model 不可解析改抛错；`llm` 缺失 `logger.warn` |

## 10. v4 修订：宿主包解析（安装前发现，已修）

原 `tool/index.js` 静态 `import` 了四个 `@deepseek-ai/*` 宿主包，但目录链接安装的 bundle 没有
`node_modules`，Node 从插件目录向上找不到 → `MODULE_NOT_FOUND`，工具模块**根本加载不出来**。
后果比不装更糟：patch 先 `disable` 内置 `tool-agent-team` 再 insert 新行，新行加载失败就意味着
Agent Teams 的团队工具全部消失。

- 漏检原因：`test/check.mjs` 只 import `route.js` / `als.js` / `bridge`，从不加载 `tool/index.js`；
  `node scripts/validate.mjs` 只加载入口 `.`（= bridge），所以两边都是绿灯。
- 修法：新增 `host.js`，`createRequire(process.resourcesPath/app.asar/dsh/package.json)`
  定位宿主 bundle 内的文件，再按 file URL 动态 import（同一个 URL ⇒ 同一个模块实例）。
- base 选 `dsh`：实测 `app.asar` 顶层只有 `dsh` / `lib` / `node_modules` / `renderer`，三个
  `dsh-*` 包与 `schemastery`、`cordis` 都在 `dsh/node_modules` 下；`schemastery`、`cordis`
  另有一份同版本（3.18.5 / 4.0.5）镜像在 `app.asar/node_modules`。这与
  `prompt-customizer` / `thinking-guard`（同样写 `dsh`，只加载 `schemastery`）一致。
- 校验同步：`verify-vendor.mjs` 的 `FORBIDDEN` 现在会拦住静态宿主 import；
  `test/check.mjs` 增加宿主解析用例，并修正了"异步用例未被 awaited、失败不计入统计"的缺陷。

## 11. v5 收尾：已安装并在真机验证

- **宿主升级到 `0.2.1-rc.3`**（`dsh-desktop` / `dsh-desktop-runtime` 同步）。第一次安装被拒于
  `engines.dsh: ">=0.2.1 <0.3.0"`——按 semver，`0.2.1-rc.3 < 0.2.1`，预发布不被接受。
  已改为 `">=0.2.1-rc.2 <0.3.0"`；这属于元数据写窄，不是版本不兼容，因此**没有**使用风险豁免。
- **vendor 基线不需要 rebase**：rc.3 的 `dsh-experimental-tool-agent-team/lib/index.js` 仍是
  18903 bytes、sha256 `cac22fe5…`，与 README/常量逐字节一致。
- 第一次 `applied` 后的行状态是 `pending (waiting for service: agentTeams)`，原因是当时 profile 的
  `dsh.profile.bundles` 只剩 `dsh-base` + `dsh-web-app`，`@deepseek-ai/dsh-experimental-agent-team-profile`
  不在其中，服务未被组合。`remove_bundle` 回滚、profile 恢复后重装即 `applied`。
- 真机验证（证据均取自会话投影缓存 `storages/session_projcache/sessions/<id>.json`，
  即 `modelSelection` 的落地处，由子会话 `request/header` 驱动）：

| 用例 | `modelSelection.lastUsed` |
| --- | --- |
| `model: teammate-model` | `{provider: my-provider, model: teammate-model}` |
| `model: second-model` | `{provider: my-provider, model: second-model}` |
| 不带参数 | `{provider: my-provider, model: lead-model, reasoningEffort: medium}` |

  `Tool.listTools` 同时确认 `spawn_teammate` 带 `model` / `provider` / `reasoning_effort`。这条证据
  也反证了 `host.js` 的宿主包解析在真机 Electron 下成立——否则工具行加载失败，三个参数不会出现。
- 注意：`list_agents` 的花名册**不能**用来验证路由。成员非 live 时它回退到 `root.options.model`
  （`agent-team:922`），两个不同模型的成员会显示成同一个模型。

## 12. 调研记录：宿主不支持原地换模型，本插件 v5 自行绕开

最初的问题是"能否改运行中 teammate 的模型"。当时（插件仅到 v4）结论是**不支持**，核查如下：

1. **宿主会话层**：`@Remote("selectModel")`（`dsh-api-session-controller/lib/index.js:793`）机制完整——
   `installModelSelection()`（`dsh-agent/lib/types/model-selection.js`）把可变 selection 挂到
   `agent/request`，下一次请求走新路由并插入持久提示 `[model changed: … the session continues with …]`。
   但它进不去 teammate：`liveAgent()`（`:365`）对 `hasApiSessionSubagentOwner` 为真的会话返回
   `session/agent-busy`（`reason: "use subagent delivery for this child session"`），该判定第一条就是
   `session.header.origin === "subagent"`；而 teammate 正是这个来源（`dsh-subagent/lib/index.js:354`
   写死 `origin: "subagent"`，agent-team 在 `lib/index.js:1032` 经 `ctx.subagents.startActivation` 建成员）。
   > 易错点：`resolve()` 里 `liveAgent()` 先返回，容易被读成"live 就绕过 ownership 检查"。
   > 实际 `liveAgent()` 内部自己就做了这个检查——live 的 subagent 会话一样被拒。
2. **宿主 subagent 层**：`dsh-subagent` 服务没有 model / route / select / switch 任何方法
   （按方法名正则枚举，候选为空）。

**v5 的做法**：不等宿主放行，改为直接写该 Agent 的 model selection——
`sessionController.agents.selectForNextRequest(agent, selection)`（追加 `model/selection` 事件 +
设置 selection），绕开会话层的 subagent 拒绝；工具名 `set_teammate_model`，白名单与 preflight 复用
`planTeammateModelChange()`。该接缝**不在 `sessionController` 的服务契约内**（Inspect 只暴露
`selectModel` 等），属内部属性，因此工具在取不到时明确抛错而不是静默降级。
细节与审核记录见 `docs/plans/agent-team-member-lifecycle.md`（A 已实现，B 删除成员未实现）。

### 12.1 实现依赖的四处接缝（均已核实）

| 依赖 | 核实结果 |
| --- | --- |
| `sessionProjections.stateOf(session, "modelSelection")` | 返回投影注册时声明的 **state 形状**（`{lastUsed, pending}`），不是带 `val` 的 wire view；与 `pickSelectedRoute()` 的 `pending ?? lastUsed` 匹配 |
| `selectForNextRequest(agent, selection)` | `dsh-api-session-controller/lib/index.js:312`，仅两行：`agent.session.append("model/selection", selection)` + `selectionFor(agent).current = selection`，**无 origin 检查** |
| `"model/selection"` 事件类型 | 在 `dsh-session` 的事件类型白名单内（与 `request/header`、`plan/mode` 并列），`append` 会接受 |
| cold session 的 `append` | `append()` 无 writer/liveness 守卫，只做 JSON 快照 + 事件校验 + `commit` |

> 已知限制：`list_agents` 对 **inactive** 成员读不到投影，会原样沿用服务层的回退值
> （`root.options.model`），因此多个 inactive 成员会显示成同一个模型。这是有意为之——
> 宁可不显示，也不用别人的路由冒充（`tool/index.js` 里 `model === undefined ? view : {...view, model}`）。

## 13. 验证矩阵（哪些结论凭什么证据）

46 轮迭代里逐条验证过的东西，汇总在这里，避免后来者重复劳动。
**"真机"指在本机 rc.3 上实际跑过一次，不只是读代码。**

### 13.1 功能行为

| 结论 | 证据 |
| --- | --- |
| 创建时带路由生效 | 真机：两个成员 → `modelSelection.lastUsed` 各自命中 |
| 不带参数继承 Lead | 真机：`{provider, model: lead-model, reasoningEffort: medium}` |
| **`context: 'fork'` 也走同一套路由** | 真机：fork 成员投影 `lastUsed = {provider, model: teammate-model}`，且 `seq 5295`（继承了父会话 5 千+ 事件）——证明 `agentOptions` 穿过 fork 分支到达子会话，不是被 fork provider 丢弃 |
| 运行中改路由生效 | 真机：投影 seq 39 → 60；会话日志 `request/header` 的 `reason` 从 `resume` 变 `change` |
| 变更有持久提示 | 真机：`user/message`（`kind: model-selection`, `form: notice`）`[model changed: …]` |
| 下一次请求就换路由（按 step 而非 turn） | 代码：`agent/request` waterfall 载荷带 `step`（`dsh-agent-loop:1191-1195`） |
| 目标为 Lead 被拒 | 真机：`the Team Lead cannot change its own model` |
| 目标不存在被拒 | 真机：`no teammate named "…"` |
| 白名单外被拒并列出可用路由 | 真机 |
| 只给 effort 可成功 | 真机：投影落到 `reasoningEffort: "high"` |
| inactive 成员不能改 | 真机：`has no Session to change` |

### 13.2 组合与配置

| 结论 | 证据 |
| --- | --- |
| 内置 `tool-agent-team` 已被 disable | 真机 `Config.listConfigs`：`include:tool-agent-team` → `inactive` |
| 本插件的行已激活 | 同上：`include:tool-agent-model` → `schema` |
| bridge 行存在但无 Config 导出 | 同上：`absent` 指"无 schema"，不是"未挂载" |
| 宿主目录名是 `dsh` | 真机 asar 头：顶层 `["dsh","lib","node_modules","package.json","renderer"]` |
| 补丁形状未漂移 | `verify-vendor`：sha256 `cac22fe5…`，rc.3 与基线逐字节一致 |
| 重装不会破坏运行态 | 真机：两次 `remove_bundle`+`install_bundle` 后，live 成员仍能响应，且能读到新工具描述里的 `resolved per step` 短语 |

### 13.3 防线本身是否有效（每条都做过反向注入）

| 防线 | 反向验证方式 |
| --- | --- |
| 宿主目录名（`validate.mjs`） | 把 `HARNESS_ROOT` 改成 `WRONG-DIR` → 报错并列出实测顶层 |
| `REQUIRED` 11 条标记 | 逐条**删除全部出现** → 11/11 报 `missing <label>` |
| `FORBIDDEN` 5 条标记 | 逐条插入被禁文本 → 5/5 报 `still present <label>` |
| 路由函数未漏导入 | 移除 `pickSelectedRoute` 的 import → 报 `route helper used but not imported` |
| config 抄全 | 给 `Config` 加一个字段 → 报该字段未被 patch 设置 |
| patch 行都在 `exports` 里 | 删掉 `./bridge` → 报该行无对应 export |
| cordis 代理语义 | 改版本号 / 改 `thisArg === outer` 那一行 → 各自报错 |
| ALS 前提（`track` 同步） | 往 `track()` 里注入 `await` → 报错 |
| 检查**不会**静默跳过 | 移走 `vendor-baseline` → 三条 `SKIP` 各自点名未验证的假设 |

### 13.4 仍未验证

| 项 | 为什么没做 |
| --- | --- |
| `enabled: false` 分支 | 需要改 profile 的 `subagent-model-selection-settings`，而 profile 在工作区外（实测 `PermissionError`） |
| 切到 `hy3` 成功路径 | `hy3` 不在白名单，同上 |

> 注入干扰类实验**必须在副本上做**。踩过的坑：就地改 `tool/index.js` 漏恢复，残留 `_XX`
> 导致后续全部误报；以及「追加后缀」不会破坏 `includes()`、只删 1 次挡不住重复出现的标记。
> 详见 `docs/experiences/07-debugging-playbook.md` §7.1。

### 13.5 那两项怎么补完（给有 profile 写权限的人）

Agent 会话的文件策略是 `workspace-write`，工作区是仓库目录；profile 在
`%USERPROFILE%\.dsh\profiles\desktop\`，**读得到、写被拒**（实测 `PermissionError`）。
所以这两项必须由人来跑，步骤是确定的：

**A. `enabled: false` 分支**

1. 在 `cordis.patch.yml` 的 `subagent-model-selection-settings` 行把 `enabled: true` 改成 `false`；
2. 让某个成员（live）调一次 `set_teammate_model`；
3. 期望：`set_teammate_model: child model selection is disabled in Settings`；
4. 改回 `true`。

**B. 白名单外 → 白名单内（`hy3`）**

1. 在 `allowedModels` 里加一条 `- provider: <你的 provider>` / `model: hy3`；
2. 成员调 `set_teammate_model({ target, provider, model: "hy3" })`；
3. 期望：返回成员行，且投影 `modelSelection.lastUsed.model === "hy3"`；
4. 若 `hy3` 实际不可用，`llm.resolveCallConfig` preflight 会先失败——
   那说明是路由问题而不是白名单问题，两者错误文案不同，可据此区分。

> 改完不需要重装插件：白名单是团队侧读的 live 配置（见 §12）。但**改了 `tool/index.js`
> 就必须 `remove_bundle` → `install_bundle` 或重启**，模块有缓存。
