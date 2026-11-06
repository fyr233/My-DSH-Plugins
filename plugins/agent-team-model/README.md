# agent-team-model

让团队 Lead 在创建成员时**逐个指定 LLM 路由**（模型 / provider / reasoning effort），
并能在之后**就地改掉已有成员的路由**而不用重建成员、不丢对话。

DeepSeek Harness 的 `spawn_teammate` 原本只有 `name / description / prompt / context`
四个参数，成员只能继承 Lead 的模型；宿主也没有给成员换模型的入口
（会话层的 `selectModel` 对 subagent 来源的会话一律拒绝）。本插件补上这两项能力，
并且**不改动 Agent Teams 服务本身**。

## 用法

```js
spawn_teammate({
  name: 'reviewer',
  description: '对抗式审核方案',
  prompt: '……',
  model: 'teammate-model',      // 新建：省略则继承 Lead 的模型
  provider: 'my-provider',           // 可选：省略则继承 Lead 的 provider
  reasoning_effort: 'high',  // 可选：省略则用该模型自身默认档
})
```

创建之后也能改（Lead-only）：

```js
set_teammate_model({ target: 'reviewer', model: 'other-model' })
```

- **下一次请求生效**；正在跑的 turn 用旧路由跑完。
- **目标成员必须是 live 的**。`inactive` 成员的 Session 没有挂载进内存，调用会报
  `has no Session to change`——先 `send_message` 唤起再改（实测，见「验证」段）。
- 成员 inactive 且读不到其投影时，必须同时给 `provider`，否则报
  `cannot resolve an effective provider and model`（宁可报错也不猜一个 provider）。
- 与 `spawn_teammate` 共用同一份白名单和 preflight；重复设置同一路由不会多落事件。
- `list_agents` 会读会话的 `modelSelection` 投影（`pending ?? lastUsed`）覆盖显示值，
  但**读不到投影时仍沿用服务层的回退值**（即 Lead 的模型）——这正是 inactive 成员
  会显示成同一个模型的原因，不是 bug。

三个参数全不传时，行为与未安装本插件**完全一致**。

## 白名单复用（不新增配置）

模型路由白名单直接复用子智能体那一份：

```yaml
- id: subagent-model-selection-settings
  name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings"
  config:
    enabled: true
    allowedModels: [...]
```

插件读的是同一个 `subagentModelSelection` 服务（`ctx.get('subagentModelSelection')`），
**没有第二份配置**。语义：

| 服务状态 | 任何显式选择（model 或 reasoning_effort） |
| --- | --- |
| 未安装 | 放行 |
| `enabled: false` | 拒绝（`child model selection is disabled in Settings`） |
| `enabled: true` | 生效路由必须命中 `allowedModels`，否则列出行车范围后报错 |

> **注意**：子智能体侧是"每个 Session 组合时快照一次、子会话继承"；团队侧读的是 live 配置，
> 改白名单会即时影响后续 `spawn_teammate`。这是有意的差异（团队没有对应的组合点），
> 不是 bug。

## 实现方式

代理（bridge）而非替换服务：

```
spawn_teammate (本包 tool/)
   ├─ planTeammateRoute()      纯函数：解析参数 + 白名单校验
   ├─ llm.resolveCallConfig()  preflight：路由不可调用就在建成员之前失败
   └─ withTeammateAgentOptions(agentOptions, () => agentTeams.spawnTeammate(...))
        └─ AsyncLocalStorage 打标
             └─ ctx.subagents.startActivation  (本包 bridge/ 包一层)
                  └─ 合并 request.agentOptions
                       └─ resolveChildAgentOptions()  宿主既有逻辑
```

为什么不在 `spawnTeammate` 上传参：Agent Teams 内部固定只转发 `{ prompt, parent }`
（`agent-team/lib/index.js:1032-1042`），多余字段会被丢弃，而 `startActivation` 的调用是内部构造的。
`AsyncLocalStorage` 能安全跨越这条链，因为 `lifecycle.track` 是同步的（`lifecycle.js:52-56`）、
`journal.transact` 是普通 await。

**为什么只换工具、不换服务**：替换 `agent-team` 服务会在挂载期触发 `disposeRuntime()`
（`agent-team:1473-1482`），把**所有运行中的团队拆掉**；只换工具层不会。这也是本插件能在
"其它 agent 正在使用 Agent Teams"的情况下安装的前提。

### 三个需要知道的实现细节

- **bridge 期间 `this.ctx` 是桥插件的 ctx**，不是 TeamService 的。`startActivation` 内部只用它取
  `agents` 服务，两者都在 root 下解析到同一实例，当前完全等价；若将来引入 isolate/intercept，
  这一处会分叉。
- **卸载靠 own-descriptor 守卫**：cordis 每次读方法都会返回**新的** shadow-method 代理，所以
  `subagents.startActivation === wrapped` 恒为假，不能用它判断。桥用的是
  `Reflect.getOwnPropertyDescriptor(subagents, 'startActivation')?.value === wrapped`。
  少了这一步就会"装上拔不掉"，且每次重载叠一层包装。
- **宿主包必须经 `host.js` 加载**（见下一节），`tool/index.js` 里**不允许**出现
  `import ... from '@deepseek-ai/...'`；`verify-vendor.mjs` 的 `FORBIDDEN` 会拦住这种回退。

### 宿主包如何解析

目录链接安装（`link:`）的 bundle **没有自己的 `node_modules`**，Node 从插件目录向上找不到
`app.asar` 里的 `@deepseek-ai/*`，静态 import 会直接 `MODULE_NOT_FOUND`——工具模块因此整个
加载失败。所以 `tool/index.js` 的四个宿主包改由 `host.js` 解析：

```js
// host.js：先 require.resolve 定位到宿主 bundle 内，再按 file URL 动态 import
createRequire(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))
```

- **base 是 `dsh`**：`app.asar` 顶层只有 `dsh` / `lib` / `node_modules` / `renderer`。
  三个 `dsh-*` 包与 `schemastery`、`cordis` 都在 `dsh/node_modules` 下；`schemastery`、
  `cordis` 另有一份**同版本**（3.18.5 / 4.0.5）镜像在 `app.asar/node_modules`（Electron 层）。
  以上都是从已安装的 `resources/app.asar` 实测所得。
- 同款写法已在 `plugins/prompt-customizer`、`plugins/thinking-guard` 里用于 `schemastery`，
  base 同样是 `dsh`；本插件多用三个包，所以少了 `dsh` 这一层就一个也解析不到。
- **按 URL 导入而非再取一份实例**：解析到的正是宿主加载过的那个文件，于是全局只有一份
  `dsh-tools` 注册表、一个 `TaskId` brand；否则会出现"注册到另一个 registry"的诡异失败。
- 代价：`tool/index.js` 变成含 top-level await 的模块，cordis 的 `await import()` 支持它。
- 在非 Electron 环境（如 `node --check`、普通 `node`）加载 `tool/index.js` 会**明确报错**
  说明必须运行在 Harness 桌面应用内，而不是抛裸的 `MODULE_NOT_FOUND`。

## 安装

```js
plugin_manager({ action: 'install_bundle', target: '<仓库>/plugins/agent-team-model' })
```

- 本 bundle 会 `disable` 内置的 `tool-agent-team`，并插入 `tool-agent-team-model` 与
  `agent-team-model-bridge`。装完后可这样确认（`Config.listConfigs`，id 带 `include:` 前缀）：

  | entry id | 期望 status | 含义 |
  | --- | --- | --- |
  | `include:tool-agent-team` | `inactive` | 内置工具行已禁用；若仍为 `schema` 说明 disable 没生效，两套工具会同名冲突 |
  | `include:tool-agent-team-model` | `schema` | 我们的工具行已激活，Config 已投影 |
  | `include:agent-team-model-bridge` | `absent` | 行存在但无 Config 导出（`absent` 指"无 schema"，不是"未挂载"） |

  以上三项均已在 rc.3 真机实测确认。

  bridge 是否真的包上了 `startActivation`，**无法从 Inspect 直接看出**——它写在服务实例的自有属性上，
  而 `subagents` 的接口契约里没有对应可观测项。可靠的判据是行为：`spawnTeammate` 内部只转发
  `{ prompt, parent }`，所以**只要两个成员各自落到不同模型，bridge 就一定在生效**
  （`modelSelection.lastUsed` 分别命中即为证）。这条推理在 rc.3 上已实测成立。
- **顺序要求**：必须排在 `@deepseek-ai/dsh-experimental-agent-team-profile` 之后
  （`install_bundle` 追加到 bundles 末尾，天然满足）。装错顺序会静默失效。
  该层不在 `dsh.profile.bundles` 里时，本插件的工具行会停在
  `pending (waiting for service: agentTeams)` —— 不是插件的问题，先修 profile。
- 插入行的 `config` 是**抄全**的（`interrupt` / `freshProvider` / `forkProvider`）：
  insert 不继承被覆盖行的配置，漏抄会退回服务默认值。
- **`list_agents` 对 inactive 成员仍显示 Lead 的模型，这是预期行为。** 服务层给的行在成员非 live 时
  回退到 `root.options.model`（`agent-team:922`）；插件只在能读到该成员的 `modelSelection` 投影时才覆盖，
  读不到就**原样返回**（`model === undefined ? view : {...view, model}`），以免用别人的路由冒充。
  所以看到多个成员同一个模型时，先确认它们是不是都 inactive。
  实测（2026-11-06）：`remove_bundle` → `install_bundle` **确实**会加载新模块——同一批次新增的
  `set_teammate_model` 在重装后立即出现在 `Tool.listTools` 里，可作判据。
- **profile 里是指向仓库目录的符号链接**：`node_modules/@local/dsh-plugin-agent-team-model`
  → `plugins/agent-team-model`（实测 `os.readlink`，16 个文件全部可见）。
  所以「改了代码不生效」**不是**副本没同步，而是 Node 的**模块缓存**——磁盘上的文件一直是最新的，
  重装/重启只是让进程重新加载它。排查时别再怀疑文件拷贝。
- **`engines.dsh` 要覆盖预发布版本**：宿主以 `0.2.1-rc.N` 形式发布，而
  `">=0.2.1 <0.3.0"` 按 semver 不接受任何 `0.2.1-rc.N`（预发布低于对应正式版），安装会被
  `incompatible-version` 拒绝。当前写的是 `">=0.2.1-rc.2 <0.3.0"`；宿主再往前推 rc 号时
  不需要改，但一旦跳到 `0.2.2-rc.1` 就必须重新放宽。

已装时可放心安装：运行中的团队不会被拆，但内置工具表会被重新注册。

## 验证

```bash
node plugins/agent-team-model/test/check.mjs      # 35 项：路由规划与变更、白名单、ALS、bridge 代理语义、宿主包解析、输出契约
node plugins/agent-team-model/verify-vendor.mjs   # vendor 漂移检查（基线 sha256 + 宿主 import 已改造 + 换路由工具未丢）
```

`test/support/cordis-traps.mjs` 是对 cordis `createTraceable` 的忠实复刻（`get` 每次返回新的函数代理、
`set` 落到 raw、`delete`/`getOwnPropertyDescriptor` 转发到 raw）。**不要**改回用普通对象建原型链的
假对象——那样 `=== wrapped` 会意外成立，会把"卸载不还原"这个缺陷整个建模掉。

`verify-vendor.mjs` 需要宿主原版 `lib/index.js` 作为基线；默认从
`.scratch/vendor-baseline/` 读取（该目录是本地构建产物，不入库），缺失时打印 `SKIP`。
基线 sha256 硬编码在脚本里，与本文末尾的基线一致；上游一变就会报错。

安装后确认（三项已在 rc.3 真机上全部通过）：

1. `Tool.listTools` 里 `spawn_teammate` 出现 `model` / `provider` / `reasoning_effort`；
2. 起两个不同模型的成员，成员产生**第一个请求后**侧边栏显示各自模型
   （投影由子会话的 `request/header` 驱动）；
3. 不带参数再 spawn 一次，行为与旧版一致。

**不要用 `list_agents` 验证路由**：成员非 live 时花名册回退到 `root.options.model`
（`agent-team:922`），两个不同模型的成员会显示成同一个模型。可靠的读法是会话投影缓存
`~/.dsh/storages/session_projcache/sessions/<sessionId>.json` 里的 `modelSelection.lastUsed`。

### 验证一次运行中换模型

`set_teammate_model` 需要 Lead 会话的**工具表在字段注册之后**组装，所以装完插件或更新代码后，
要在新会话里发起调用（不必重启应用）。

1. `set_teammate_model({ target: '<成员名>', model: '<白名单内的模型>' })`；
   **成员 inactive 且读不到其投影时，必须同时给 `provider`**——否则没有可信的当前路由可继承，
   会明确报错 `cannot resolve an effective provider and model`（而不是猜一个）。
   实测：`{ model }` 单独 → 抛错；`{ provider, model }` → 成功；`{ reasoning_effort }` 单独 → 抛错。
2. 读该成员的投影缓存，`modelSelection.lastUsed`（或 `pending`）应变成新路由；
3. 给该成员 `send_message` 一句话，等它回复后再读一次投影——`lastUsed` 更新即说明
   **下一次请求真的走了新模型**；
4. 若被白名单拒绝，错误信息会列出 `allowedModels` 的全部可用路由；改白名单请改 profile 的
   `cordis.patch.yml` 里 `subagent-model-selection-settings` 那一行。

> 换模型会在该成员会话里插入一条持久的 `[model changed: …]` 提示（宿主 `installModelSelection`
> 的行为），这是预期结果，不要把它当成噪音删掉。

**已知限制：目标成员必须是 live 的。** 实测（2026-11-06，由成员 `route-admin` 经工具调用验证）：
对一个 inactive 成员调用会报

```
set_teammate_model: teammate "<name>" has no Session to change
```

原因是该成员的 Session 没有挂载进内存（`ctx.agents.get()` 与 `ctx.get("sessions").get()` 都取不到）。
这**不是**权限、白名单或 provider 缺失的问题——它发生在更早的一步。
要让成员变成 live：先 `send_message` 给它一句话唤起，再调用。
同一个实验也确认了工具对成员可见（成员侧 `tools-available: yes`）。

### 会话日志里的完整证据链（2026-11-06，rc.3）

日志：`~/.dsh/sessions/<cwd-tag>/<sessionId>/session.v4.jsonl.zstd`（多帧 zstd，逐帧解压）。
同一次实验的成员会话，按 seq 顺序：

| seq | 事件 | 内容 |
| --- | --- | --- |
| 50 | `model/selection` | `{provider, model: teammate-model}` ← 插件写入的接缝 |
| 55 | `user/message`（`kind: model-selection`, `form: notice`） | `[model changed: assistant turns above this point were generated by lead-model; the session continues with teammate-model]` |
| 56 | `request/header`（**`reason: change`**） | `provider/teammate-model` ← 下一次请求真的换了路由 |
| 72 | `model/selection` | `{provider, model: lead-model}` ← 切回 |
| 76 | `request/header`（`reason: change`） | `provider/lead-model` |

这条链把三个环节都钉死了：**接缝写入 → 宿主插入变更提示 → 下一请求换用新路由**，
不是「日志改了但请求没变」。注意 `request/header` 原先都是 `reason: resume`，
换模型后变成 `reason: change`，这是判断是否真的生效最直接的标志。

### 端到端实证（2026-11-06，rc.3）

由成员 `route-admin` 在自己 live 时调用本工具、改的是它自己：

| 步骤 | 投影 `modelSelection` |
| --- | --- |
| 切换前 | `{provider: my-provider, model: lead-model, reasoningEffort: medium}`，`seq 39` |
| 切到 `teammate-model` | `{provider: my-provider, model: teammate-model}`，`seq 60`，`pending: null` |
| 切回 `lead-model` | `{provider: my-provider, model: lead-model}`，`seq 79` |

- `pending: null` 且 `lastUsed` 变化 ⇒ 新路由**已被实际请求消费**，不只是排队；
- 切成 `teammate-model` 后该成员那一轮失败（该模型当时不可用），反过来证明**下一次请求确实走了新模型**；
- 返回体就是 `MEMBER_VIEW_SCHEMA` 的成员行、无多余字段——输出 schema 与实现一致。

同一次实验还覆盖了三条分支（均由该成员实际调用取得）：

| 用例 | 实测结果 |
| --- | --- |
| `target: "lead"` | `the Team Lead cannot change its own model` |
| `target: "no-such-member"` | `no teammate named "no-such-member"` |
| 只给 `reasoning_effort: "high"` | 成功；返回体带 `reasoningEffort: "high"`，投影落到 `{provider, model: lead-model, reasoningEffort: "high"}`（seq 114） |

最后一条同时证明 `reasoningEffort` 确实在 `MEMBER_VIEW_SCHEMA` 里——否则 `additionalProperties: false`
会让这次调用在输出校验阶段失败。

## 基线

- 上游版本：`@deepseek-ai/dsh-experimental-tool-agent-team@0.2.1-rc.2`（`rc.3` 的该文件未变，
  sha256 仍一致，故基线继续有效）
- 基线 `lib/index.js` sha256：`cac22fe5f83a179056469cf329def58393c7620eae23b018c66f42c37d849f63`
- 补丁形状：`verify-vendor.mjs --report` 实测（多重集比对）删 6 行、加 277 行
  （3 处宿主 import 改为经 `host.js` + 3 参数 + 路由规划/变更 + preflight + 带标记的 spawn + `set_teammate_model`）
  > 这两个数字随补丁增长而变，**不要当成断言**——`verify-vendor.mjs` 只校验"vendored 不比 baseline 短"
  > 以及必需/禁止标记，不校验具体行数。要准确值请现跑 `--report`。
- 想看具体增删了哪些行：`node plugins/agent-team-model/verify-vendor.mjs --report`
- 没有基线副本时（如 CI）会打印 `SKIP upstream comparison` 并以 0 退出，仍校验补丁形状——实测确认

宿主升级后 `verify-vendor.mjs` 会报基线漂移，按同一形状重新 rebase。

## 已知边界

- **版本耦合**：属于 `experimental` 包的内部接缝，上游改 `startActivation` 或
  `parentAgentOptionsForDelegation` 就需要跟着改。
- **`fork` 成员换模型**：`fork` 会继承父会话上下文，换到差异很大的模型语义上合理但不保证，
  由使用者自负。
- **配置寻址**：内置 `tool-agent-team` 被 disable，所以按该 id 调配置打不到本插件的行；
  改配置请针对 `tool-agent-team-model`。
- **宿主包解析依赖打包布局**：`host.js` 假设 `app.asar/dsh`（以及 unpacked 的 `app/dsh`）下带
  `node_modules`。宿主换了打包结构（产品再改名、改走 unpacked 目录）就要跟着调整；失败时报错会
  点名缺失的包名，不会静默降级。
- **宿主不支持、本插件用私接缝绕开**。路由在 `spawn_teammate` 时经 `agentOptions` 生效；`v5` 新增
  `set_teammate_model` 支持对**已有成员**改路由（改动从成员下一次请求起生效，正在跑的回合仍走旧路由）。
  宿主自身三层都不提供原地切换，已逐层核实（`0.2.1-rc.3`）：

  | 层 | 情况 |
  | --- | --- |
  | 宿主会话层 | `@Remote("selectModel")`（`dsh-api-session-controller/lib/index.js:793`）存在，但 `liveAgent()` 对 `session.header.origin === "subagent"` 直接返回 `session/agent-busy`（"use subagent delivery for this child session"）；teammate 正是这个来源（`dsh-subagent/lib/index.js:354` 写死 `origin: "subagent"`） |
  | 宿主 subagent 层 | `dsh-subagent` 服务没有 model / route / select / switch 任何方法 |
  | 本插件的路 | 走 `sessionController.agents.selectForNextRequest`（写入 `model/selection` 事件 + 设置该 Agent 的 selection），不经过会话层的 subagent 拒绝 |

  > 注意：`controller.agents.selectForNextRequest` **不在 `sessionController` 的服务契约里**（Inspect 只列出
  > `selectModel` 等公开方法），属于内部属性。宿主若重命名/移除它，工具会明确抛错
  > （"this Host does not expose the Session model-selection seam"），不会静默失效。
  > 改完插件代码需 `remove_bundle` → `install_bundle` 或重启，运行中的进程不会自动换模块。

  详见 `docs/plans/agent-team-member-lifecycle.md`（方案 v5：A 已实现，B 删除成员未实现）。

## License

MIT。`tool/index.js` 派生自 `@deepseek-ai/dsh-experimental-tool-agent-team`（MIT），
见同目录 `LICENSE`。
