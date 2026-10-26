# agent-team-model

让团队 Lead 在创建成员时**逐个指定 LLM 路由**（模型 / provider / reasoning effort）。

DeepSeek Harness 的 `spawn_teammate` 原本只有 `name / description / prompt / context`
四个参数，成员只能继承 Lead 的模型。本插件补上这个能力，并且**不改动 Agent Teams 服务本身**。

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
  `agent-team-model-bridge`。
- **顺序要求**：必须排在 `@deepseek-ai/dsh-experimental-agent-team-profile` 之后
  （`install_bundle` 追加到 bundles 末尾，天然满足）。装错顺序会静默失效。
  该层不在 `dsh.profile.bundles` 里时，本插件的工具行会停在
  `pending (waiting for service: agentTeams)` —— 不是插件的问题，先修 profile。
- 插入行的 `config` 是**抄全**的（`interrupt` / `freshProvider` / `forkProvider`）：
  insert 不继承被覆盖行的配置，漏抄会退回服务默认值。
- **`engines.dsh` 要覆盖预发布版本**：宿主以 `0.2.1-rc.N` 形式发布，而
  `">=0.2.1 <0.3.0"` 按 semver 不接受任何 `0.2.1-rc.N`（预发布低于对应正式版），安装会被
  `incompatible-version` 拒绝。当前写的是 `">=0.2.1-rc.2 <0.3.0"`；宿主再往前推 rc 号时
  不需要改，但一旦跳到 `0.2.2-rc.1` 就必须重新放宽。

已装时可放心安装：运行中的团队不会被拆，但内置工具表会被重新注册。

## 验证

```bash
node plugins/agent-team-model/test/check.mjs      # 23 项：路由规划、白名单、ALS、bridge 代理语义、宿主包解析
node plugins/agent-team-model/verify-vendor.mjs   # vendor 漂移检查（断言基线 sha256 + 宿主 import 已改造）
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

## 基线

- 上游版本：`@deepseek-ai/dsh-experimental-tool-agent-team@0.2.1-rc.2`（`rc.3` 的该文件未变，
  sha256 仍一致，故基线继续有效）
- 基线 `lib/index.js` sha256：`cac22fe5f83a179056469cf329def58393c7620eae23b018c66f42c37d849f63`
- 补丁形状：按 `verify-vendor.mjs` 的多重集比对，删 5 行、加 130 行
  （3 处宿主 import 改为经 `host.js` + 3 参数 + 路由规划/preflight + 带标记的 spawn）

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

## License

MIT。`tool/index.js` 派生自 `@deepseek-ai/dsh-experimental-tool-agent-team`（MIT），
见同目录 `LICENSE`。
