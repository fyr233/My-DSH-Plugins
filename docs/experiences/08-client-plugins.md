# 08 · Client 端插件（Web 半边）

本文记录 Web 半边插件的**实测结论**：怎么声明、怎么加载、能监听什么、哪些时刻只能在
Client 侧拿到。所有结论来自对照 npm 上真实可加载的包
（`dsh-ui-sound`、`dshmarket`、`dsh-pet`、`@deepseek-ai/dsh-client-ui-brand-official`）
与本机 `cordis_inspect_query` 的 slot 观测。

## 1. 该把能力放在哪一侧

| 需求 | 放 Host | 放 Client |
| --- | --- | --- |
| 读文件、起进程、系统 API | ✅ | ❌ |
| 用户在观看时才有意义的反馈（声音、闪烁、通知） | ⚠️ 见下 | ✅ |
| 需要“交互出现那一刻” | ❌ 拿不到 | ✅ |

判断规则：**反馈要送到“人所在的那一侧”**。

- Host 与 Client 分离部署时，Host 播放的声音用户听不到；相反，截图这类**动作发生在
  Host** 的事情，确认音也应放在 Host（`window-capture` 就是这么做的）。
- “提问卡片弹出前”在 Host 侧**没有任何事件**（见 §5），只能在 Client 观察。

## 2. manifest：`dsh.client` 与 `./client` 导出

真实可加载的写法（来自 `dsh-ui-sound`，最精简）：

```jsonc
{
  "main": "lib/index.js",
  "exports": {
    ".": "./lib/index.js",
    "./client": "./lib/client.js",   // 字符串形式；指向 lib/ 下的构建产物
    "./package.json": "./package.json"
  },
  "files": ["lib", "vendor", "cordis.patch.yml", "README.md", "LICENSE", "NOTICE"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": []                   // 空数组：不依赖任何 Client 包
    }
  }
}
```

要点：

- **`immediately: true` + `inject: []`** 是最简组合。需要宿主 Client 服务时再往
  `inject` 里写真实包名（`dshmarket` 写的是
  `@deepseek-ai/dsh-client-locale` 等；`dsh-pet` 写的是 `@deepseek-ai/dsh-client-connection`）。
  **不要写不存在的包名**，否则插件会一直停在 PENDING。
- `./client` 的导出值可以是字符串（`./lib/client.js`）或条件对象
  （`{ types, default }`）；校验器两种都接受，但**必须指向真实存在的文件**。
- 校验器新增了检查：入口 `import` 的本地模块也要出现在 `files[]` 里，否则打包会丢文件。

## 3. client.js 的注册协议

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-plugin-example',        // 与包名一致
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    // …组件与注册…
    module.exports = { name: 'example-client', inject: ['slots'], apply }
    return module.exports
  },
})
```

- `factory` 直接接收 `(require)`；`dsh-pet` 用的 `factory: () => (require) => …` 同样有效。
- `apply(ctx)` 里用 `ctx.slots.inject(slot, () => ctx.slots.register(...))` 注册组件。
- 可注入的宿主符号只有 `ctx`、`React`、`host`、`styles`、`console`（`Builtin.listBuiltins`），
  没有 `window` 之外的系统能力：**Client 半边不能读文件、不能起进程**。
- 组件返回 `null` 也可以：注册一个不可见组件是拿到该 slot 标准 props 的最省事办法。

## 4. Slot 的两条硬规则

`Slots.listSubTree` 会给出每个 slot 的 `kind` 与 `keyDomain`：

- **list slot** 用新 `id` 就是“追加”，不会覆盖内置项（`shell.overlay`、`conversation.composer.dock` 都是）。
- **keyed slot** 的 `keyDomain` 里写着 `already taken: …`，重复使用等于**替换内置组件**。
  例如 `tool.call.toolview` 的 `ask_user_question` 键已被内置占用，不能用来“顺便”加提示音。
- `replaceRisk: "none"` 的 slot 才适合第三方占用；`shadows-shipped-ui` 的要谨慎。

## 5. 只有 Client 能看到的时刻：待处理交互

`ask_user_question` 在 Host 侧**没有**任何“弹出前”事件（实测：不经过 `tools/pre-execute`、
不写 `session/tool/call`、全局 `user-questions/request` 监听收不到）。Host 上唯一能看到它的
是 `tools/result`，而那已经是**用户作答之后**——用来做提醒就晚了。

Client 侧的正确来源只有一处：

```js
const ui = ctx.get('uiSession')
const snapshot = ui.sessionStatus.getSnapshot()   // Map<sessionId, status>
const pending = status?.pendingInteraction !== undefined && status?.pendingInteraction !== null
```

**并且必须等 `uiSession` 出现**：

```js
ctx.inject(['uiSession'], (scope) => {
  const uiSession = scope.get('uiSession')
  if (uiSession?.sessionStatus === undefined) return
  scope.effect(() => uiSession.sessionStatus.subscribe(onStatusChanged))
})
```

一次性 `ctx.get('uiSession')` 在启动早期必然拿到 `undefined`（它由
`dsh-client-ui-session` 晚注册，而 `immediately: true` 的插件先启动），这会让提醒音**永远不响**
且没有任何报错。

## 6. 会话状态的两个正确读法

```js
// 会话列表快照：{ ids, byId, phase, projectionsBySession }
const list = ctx.sessions.list.getSnapshot()
// “当前会话” = retainedBy.mainView > 0 的那一行（与宿主判定一致）
// 运行状态 = row.running
// 单个会话快照（失败判定）：ctx.sessions.binding(id).session.getSnapshot().lastAgentError
```

注意 `sessions.list` 快照里**没有** `current`、也没有 `pending` 数组；读错字段只会静默得到空值。

## 7. 浏览器自动播放策略

没有用户手势前，`AudioContext` 处于 `suspended`，声音不会响。做法：

- 在第一次 `pointerdown` 时创建并 `resume()`；
- 或每次播放前检查 `context.state === 'suspended'` 并 `resume()`（本项目 `approval-sound`
  的 client 用的就是这个）。
- 页面刚加载、用户还没点过时没有声音，是浏览器行为，不是插件故障。

## 8. 验证手段

- `cordis_inspect_query`（Client `Slots`，`listSubTree({ root })`）看 `occupants` 里有没有你的 `id`：
  **这是判断 Web 半边是否真的加载的唯一可靠方式**，比看日志快。
- 加载失败时 `occupants` 里不会有你，`apply` 也不会执行；先查 manifest，再查 `inject` 里
  有没有不存在的包名。
