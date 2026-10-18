# 02 · 插件机制

本文说明一个 dsh 组合包（bundle）从目录到“真正运行”的完整路径，以及写代码时的硬约束。

## 1. 目录与 manifest

```
plugins/<目录>/
├── package.json          # 声明 dsh.bundle.patch
├── cordis.patch.yml      # 插入插件行（按包名，不写路径）
├── index.js              # ESM 入口
├── icon.svg|png|jpg|webp # ≤ 256 KiB
├── locale/en.json        # meta.title + meta.description（必填）
├── locale/zh.json        # 中文
└── test/check.mjs        # 零依赖自检
```

```jsonc
{
  "name": "@local/dsh-plugin-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "engines": { "dsh": ">=0.2.0 <0.3.0", "node": ">=22" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" },
  "devDependencies": { "@deepseek-ai/cordis": "~4.0.5" },
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
- insert:
    - id: example                    # 与目录名一致，用户按 id 覆盖配置
      name: '@local/dsh-plugin-example'
      config: {}
```

## 2. 入口的三种导出

```js
export const name = 'example'
export const inject = ['tools']              // 缺少这些服务时保持未激活，而不是抛错
export const Config = { '~standard': { … } } // 可选，见经验 03
export function apply(ctx, config = {}) { … }
```

- **不要**同时默认导出服务类与 `apply`。
- 所有注册都必须包在 `ctx.effect(() => { …; return dispose }, 'label')` 里，
  这样插件卸载、配置热替换时会被正确回收。
- `ctx.on()` 返回的 disposer 也要交给 `ctx.effect` 保管（本项目 `approval-sound`、
  `seamless-continue` 都这么做）。
- 可选服务用 `ctx.get('subprocess')` 并判空；缺服务时降级而不是崩溃。

## 3. 工具定义

```js
ctx.tools.register({
  name: 'my_tool',
  description: '写给模型看的一句话：做什么、何时用、约束。',
  parameters: { type: 'object', properties: { … }, additionalProperties: false },
  output: {
    schema: { type: 'object', properties: { … } },
    render: (_args, value) => [{ type: 'text', text: `…${value.field}` }],
  },
  async execute(args, exec) { … },
  finalizeContent(_exec, result) { … },  // 需要把图片/附件随结果给模型时
  presentCall(args) { return { card: 'generic', title: '…', kind: 'read' } },
  isConcurrencySafe: () => false,
})
```

经验：

- `render` 与 `finalizeContent` 拿到的值可能被裁剪，**必须对缺失字段兜底**，
  否则界面上会出现 `undefinedxundefined`（本项目 window-capture 踩过）。
- 工具名全局唯一；与内置工具冲突会注册失败。
- 需要一次性返回图片时，用 `ctx.attachments.saveImage({ data, mediaType, name })`
  拿到 `ImageAttachmentRef`，在 `finalizeContent` 里放 `{ type: 'image', attachment }`。

## 4. 命令、会话与上下文改写

- `/命令`：`ctx.commands.register({ name, description, handler })`。
- 会话日志：`ctx.sessions.get(agent.id).snapshotEvents()` 返回事件数组；
  `session.append(type, data)` 只能写**已有事件类型**。
- **不要发明新的事件类型**：读取方只接受带 `ignorable: true` 的未知事件，
  而 `append()` 不能设置该标记，会话将无法重新打开。
- 改写发给模型的上下文：挂 `agent/pre-step`（waterfall），并且
  `return { ...decision, messages }` 保留 `startsRequestSeries` 等字段
  （seamless-continue 的实现）。
- 不要返回空的 `messages`：`enter` 决策必须至少包含一条消息，否则整步会被拒绝。

## 5. 包名解析与“不能 import 宿主包”

插件通过目录链接安装到 profile，Node 从**插件目录向上**查找依赖，看不到
`dsh` 安装目录里的 `@deepseek-ai/*`。因此：

- ❌ `import Schema from '@deepseek-ai/schemastery'`
- ❌ `import { xx } from '@deepseek-ai/dsh-tools'`
- ✅ 通过 `inject` + `ctx.tools` / `ctx.get('subprocess')` 等取得能力
- ✅ 需要第三方库时写进 `dependencies`（pnpm 会装进插件自己的 `node_modules`）
- ✅ 唯一例外是 **koffi**：dsh 自带、位置固定，可按绝对路径 `createRequire` 加载（见经验 06）

## 6. 生命周期与热替换

- 改 profile 的 `cordis.patch.yml` 里的 `config` 会**卸载旧实例、加载新实例**。
- 改**插件目录里的代码**不会自动生效：`install_bundle` 对已安装包只更新 `link:`，
  不会重新加载已缓存的模块。必须 `remove_bundle` → `install_bundle`，或重启 dsh。
  这一点是本次排查耗时最久的坑（见经验 05）。
