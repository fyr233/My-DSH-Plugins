# 新增一个插件

本仓库按「一个目录 = 一个组合包」组织。发布文档见
<https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish>；
下面的清单是它在**本仓库**里的落地方式，校验器（`scripts/validate.mjs`）会逐条检查。

**动手前先读 [docs/experiences](./docs/experiences/README.md)**：那里记录了 `Config` 协议、
locale 键名、事件作用域、热重载、Windows 原生能力等已经踩过的坑。

## 目录结构

```
plugins/<目录名>/
├── package.json          # 声明 dsh.bundle；name 用 @local/dsh-plugin-<目录名>
├── cordis.patch.yml      # insert 一条插件行，name 必须是本包包名
├── index.js              # ESM 入口：export const name / inject / Config, export function apply
├── <worker>.cjs          # 可选：需要在宿主进程外运行的工作进程
├── icon.svg              # 或 PNG/JPEG/WebP（≤256 KiB）
├── locale/en.json        # meta.title + meta.description（必填，键名不能改）
├── locale/zh.json        # 用户语言版本；meta.title 用中文
└── test/check.mjs        # 零依赖自检（node test/check.mjs）
```

## package.json

```jsonc
{
  "name": "@local/dsh-plugin-example",
  "version": "1.0.0",
  "private": true,                        // 按路径安装的本地检出，不发布
  "type": "module",
  "description": "One English sentence.",
  "main": "index.js",
  "icon": "./icon.svg",                   // 或导出 "./icon"
  "exports": {
    ".": "./index.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["index.js", "cordis.patch.yml", "locale/*.json", "icon.svg"],
  "scripts": { "test": "node test/check.mjs" },
  "engines": { "dsh": ">=0.2.0 <0.3.0", "node": ">=22" },
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" },
  "devDependencies": { "@deepseek-ai/cordis": "~4.0.5" },
  "dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- **不要声明 `dsh.client`**：只有真正带浏览器端 bundle（导出 `./client`）的插件才需要它。
- **入口不要 `import '@deepseek-ai/dsh-*'`**：通过目录链接安装的插件解析不到 dsh 自带的包。
  需要宿主能力时，改用 `inject` + `ctx.<service>` 或 `ctx.get('<service>')`。
  可用服务用 `cordis_inspect_query`（Host `Service`）查询。
- 需要让用户调参的值放进 `Config`，用 Standard Schema 的 `~standard` 协议实现
  （`version: 1` + `validate(value)`，自带默认值并拒绝未知键）。纯 JSON Schema 会让 dsh
  去找一个 workspace 插件解析不到的校验器，条目激活时报 `reading 'validate'`。
  在 `cordis.patch.yml` 里可覆盖；补丁层会**整体替换** `config`，所以每个键都要有默认值。

## 显示名称与描述（搜索靠它）

插件管理器用 Node 解析 `<包名>/locale/<语言>.json`，并且**只读取 `meta.title` 与
`meta.description`**（`textOf(meta?.title)`）。写成 `displayName` 等其他键会被静默忽略，
卡片标题就会退回包名。搜索框匹配的正是卡片的标题与描述，所以：

- 每个 `locale/*.json` 都必须有 `meta.title`（显示名）与 `meta.description`。
- `locale/zh.json` 的 `meta.title` 用中文（如「窗口截图」），不要只写英文或包名。
- `meta.description` 写给用户看的一句话，并**带上用户会搜的关键词**：中英文动作词
  （截屏 / 截图 / screenshot / capture）、以及对外暴露的工具名或命令名
  （`capture_window`、`/continue`）。描述里也带上其他插件共同涉及的词（例如「截图」）
  会让搜索同时命中多个插件——那是子串匹配的正常结果，不是命名错误。
- 示例：`"title": "窗口截图"`，`"description": "截取某个程序窗口或整个桌面（截图 / 截屏 / screenshot / capture），把图像直接交给 Agent 分析。"`

## cordis.patch.yml

```yaml
- insert:
    - id: example
      name: '@local/dsh-plugin-example'
      config: {}
```

行 ID 建议与目录名一致：用户在自己的 `cordis.patch.yml` 里按 ID 覆盖配置时，
多个插件不会撞车。

## index.js

```js
export const name = 'example'
export const inject = ['tools']          // 缺少这些服务时插件保持未激活，而不是抛错

export const Config = {
  type: 'object',
  properties: { verbose: { type: 'boolean', default: false } },
  additionalProperties: false,
}

export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.tools.register({ /* ... */ }), 'example: my_tool')
  // 事件用 ctx.on(...)；注册在 apply 里完成，卸载由所属上下文负责。
}
```

## 登记与验证

1. `catalog.json` 的 `plugins` 加一项 `{ "dir": "example", "tags": [...] }`——顺序即安装顺序。
2. `node scripts/validate.mjs --write`：校验并重写 README 中的插件表格。
3. `node scripts/test.mjs`：必须全绿；CI 在 Linux 与 Windows 上各跑一次。
4. **用 `plugin_manager` 工具验证**（见下节）：对 `plugins/example` 的绝对路径调用
   `install_bundle`，确认返回 `application: applied`；再用 `cordis_inspect_query` 的
   `Tool.listTools` 看到新工具，并在「设置 → 插件」里确认标题、描述、图标来自
   `locale/*.json` 与图标文件。

## 只走 `plugin_manager` 这一条安装路径

本仓库**不提供安装脚本**：`install.ps1`、`uninstall.ps1`、`scripts/install-bundle.ps1`
已经删除，以免和 `plugin_manager` 形成两个入口、互相误导。任何安装、卸载、检查都使用
`plugin_manager`（`install_bundle` / `remove_bundle` / `list_bundles`），不要重新加回脚本，
也不要让用户先退出桌面应用再手工安装。原因：

- 它是官方安装入口（pnpm 安装 + 登记 `dsh.profile.bundles`），并**当场挂载并应用**，
  直接返回 `application` 与错误诊断；脚本只写 profile 文件，是否激活要重启 dsh 才知道。
- 它在桌面应用运行时也能工作；命令行修改 `desktop` profile 会被拒绝。

要点：

- `install_bundle` 的 `target` 是插件**目录**的绝对路径；`remove_bundle` 的 `target` 是**包名**。
- 只有 `application: applied` 算成功；`failed` 时读 `error.diagnostic`，修代码或先清理再重装，
  不要原样重试；`restart-required` 要如实告知用户。
- 换成新代码或新版本时先 `remove_bundle` 再 `install_bundle`，否则运行中的旧模块不会被替换。
- `scripts/` 只放不碰 profile 的校验与测试工具（`validate.mjs`、`test.mjs`、
  `catalog.schema.json`）。

## 版本

- 改了行为、默认值或资源：`version` 升 minor（`1.0.0` → `1.1.0`）。
- 只改文档或注释：不必升版本，但 `node scripts/test.mjs` 仍需通过。
- 破坏性变更（移除工具、改配置键）：升 major，并让 `engines.dsh` 与实际依赖保持一致。
