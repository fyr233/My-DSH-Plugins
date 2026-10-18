# DSH 插件集

一组可独立安装的 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件组合包**（bundle）。
每个插件都是 `plugins/` 下一个自包含的 npm 包，在 `package.json` 中声明 `dsh.bundle.patch`，
按 [打包与安装插件](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish) 的约定编写。

完整安装命令：[安装](#安装)；只想了解机器上现在是否已启用：[已装了吗](#已装了吗)。

<!-- BEGIN PLUGINS -->
<!-- 本表格由 scripts/validate.mjs --write 生成，请勿手改。 -->
| 插件 | 包名 | 版本 | 提供的工具 / 命令 | 平台 |
| --- | --- | --- | --- | --- |
| [窗口截图](./plugins/window-capture) | `@local/dsh-plugin-window-capture` | 2.1.0 | `list_windows`、`capture_window` | Windows |
| [键鼠控制](./plugins/input-control) | `@local/dsh-plugin-input-control` | 1.1.0 | `click`、`type_text`、`press_keys`、`scroll`、`drag`、`move_mouse` | Windows |
| [断点续写](./plugins/seamless-continue) | `@local/dsh-plugin-seamless-continue` | 1.2.0 | `/continue` 命令 | 任意 |
<!-- END PLUGINS -->

`window-capture` 与 `input-control` 设计为配合使用：先截图，再按截图中看到的坐标操作，
然后再截图确认结果。

## 环境要求

- **DeepSeek Harness** `0.2.x`。每个包都声明 `engines.dsh` 为 `>=0.2.0 <0.3.0`，
  版本范围不匹配时 dsh 会拒绝加载该组合包。
- **Node.js ≥ 22**（校验器与自检用它；`window-capture` / `input-control` 还需要用运行 dsh 的
  Node 可执行文件启动工作进程，这是 dsh 运行环境自带的）。
- **Windows**：`window-capture` 与 `input-control` 仅支持 Windows，在其它平台会返回明确的
  `NOT_WINDOWS` 错误，而不是静默出错。
- `window-capture` / `input-control` 依赖 profile 中已启用的 `subprocess` 服务。桌面应用默认
  包含它；自定义组合里缺了它时，工具会返回 `NO_SUBPROCESS`，不会让插件加载失败。

## 安装

把本仓库克隆到任意位置（**装好后不要再移动**，若必须移动，见[仓库搬家之后](#仓库搬家之后)），
然后按下面的规则选择安装方式。

### 给 Agent 的规则（重要）

> **安装、卸载、检查插件一律使用 `plugin_manager` 工具。**
> 本仓库**不提供**安装脚本：`install_bundle` 之外没有第二个安装入口，也不要假手
> `dsh plugin` 或要求用户先退出应用再手工操作。

原因：`install_bundle` 就是官方安装入口，它执行 pnpm 安装、登记 `dsh.profile.bundles`，
并**当场把插件挂进运行中的配置**、把激活结果（`application`）和错误诊断原样返回。
脱离它的安装方式只会写 profile 文件，看不到插件是否真的激活，还会被桌面应用独占挡住。

对每个插件，`target` 直接给 `plugins/` 下的绝对路径，例如：

| 插件 | `target` |
| --- | --- |
| 窗口截图 | `<仓库绝对路径>\plugins\window-capture` |
| 键鼠控制 | `<仓库绝对路径>\plugins\input-control` |
| 断点续写 | `<仓库绝对路径>\plugins\seamless-continue` |

要装全部，就对 `node scripts/validate.mjs --list` 列出的每个目录各调用一次（顺序以
`catalog.json` 为准）。Agent 需要遵守的交互细节：

1. **先 `list_bundles`**，看清包的 `source` 与 `availability`。对已经登记、但 `source`
   指向旧路径的包（`availability: missing`、`error.diagnostic` 含 `cannot resolve`），
   直接调用 `install_bundle` 会得到 `{"error":{"code":"already-installed"}}`；此时按它返回的
   `nextStep` 先 `remove_bundle`（`target` 填**包名**），再 `install_bundle`（`target` 填目录）。
2. **一定要读返回值**：只有 `application: applied` 才算装好。`application: failed` 时
   `error.diagnostic` 会点名失败的行与异常（例如插件 `Config` 用错协议导致的
   `TypeError: ... reading 'validate'`），先修代码再重装，不要重试同一动作。
   `restart-required` 表示需要重启 dsh 才生效，要如实告诉用户。
3. **替换已安装的同一包时**：同一个包换版本或换了代码，必须先 `remove_bundle` 再
   `install_bundle`，否则已加载的旧模块生成不会被替换。
4. **不要替用户操作 profile 文件**（`package.json`、`cordis.patch.yml`）：这些都由
   `plugin_manager` 负责。
5. 装完用 `cordis_inspect_query` 核对：`Tool.listTools` 应出现该插件的工具；
   插件的配置行可用 `Config.listConfigs`（`name` 填包名）查看。

### 桌面应用与命令行

`desktop` profile 归桌面应用所有：命令行修改它会报
`profile "desktop" is managed exclusively by the Electron application`。

`plugin_manager` 与应用内「设置 → 插件」走的是应用自己的管理通道，应用运行时可以直接安装，
并即时生效。这也是本仓库只保留这一条安装路径的原因。

本仓库没有构建步骤：插件直接以 ESM `index.js` 作为入口，克隆下来即可运行。

### 已装了吗

Agent 用 `plugin_manager`（`action: list_bundles`）查看：每个包有 `source`（链接指向的目录）、
`availability`（`installation` / `missing`）和 `error.diagnostic`；装好后再用
`cordis_inspect_query` 的 `Tool.listTools` 确认工具真的出现。

每个已安装的组合包都会贡献一个带 `# == <包名>` 注释的层。注意两种「看起来装了、其实没生效」的情况：

- **层缺失**：包不在 `dsh.profile.bundles` 里——重新安装。
- **层还在、插件没跑**：`dsh.profile.bundles` 里有包名，但 `package.json` 的 `dependencies`
  指向了一个**已经不存在的目录**（仓库被移动过）。`list_bundles` 会显示
  `availability: missing`，启动日志里是 `skipping profile bundle "<包名>": cannot resolve ...`。
  修复见下一节。

## 仓库搬家之后

按路径安装建立的是**链接**，指向安装时的绝对路径。移动或重命名仓库后，链接失效，
而 dsh 只在启动日志里提示 `skipping profile bundle`，界面上看不出差别。

修复：对每个插件 `remove_bundle`（包名）再 `install_bundle`（新目录），
理由与步骤见[给 Agent 的规则](#给-agent-的规则重要)。操作是幂等的，其它插件不受影响。

## 卸载

用 `plugin_manager` 的 `remove_bundle`（`target` 填**包名**），也可以在「设置 → 插件」里移除。
它同时删除依赖项与对应的 bundle 层，不留残余。

## 新增插件

1. 在 `plugins/<目录名>/` 下按发布文档写一个组合包（结构见 [CONTRIBUTING.md](./CONTRIBUTING.md)）。
2. 在 `catalog.json` 的 `plugins` 数组里加 `{ "dir": "<目录名>" }`——它是安装顺序、校验器
   与文档表格的唯一清单。
3. 运行 `node scripts/validate.mjs --write`：校验并重新生成 README 里的表格。
4. 运行 `node scripts/test.mjs` 跑全部自检。
5. 用 `plugin_manager` 的 `install_bundle` 安装验证，确认返回 `application: applied`。

CI（`.github/workflows/validate.yml`）在 Linux 与 Windows 上执行同一条 `node scripts/test.mjs`。

## 校验器检查什么

`node scripts/validate.mjs` 零依赖，逐项对应发布文档与插件显示资源的要求：

| 检查 | 依据 |
| --- | --- |
| `dsh.bundle.patch` 存在、是 `./` 相对路径、并已通过 `exports` 暴露 | 组合包 manifest |
| patch 行按**包名**引用本包，不出现路径 | Node 模块解析才能找到已安装副本 |
| `engines.dsh` 声明 SemVer 范围 | 不会装进不兼容的 dsh |
| `peerDependencies` 的包同时出现在 `devDependencies` | 与宿主共享实例 + 本地检查 |
| 入口导出 `apply(ctx, config)`（或默认导出服务类），且不混用 | Host 插件导出形式 |
| 入口只用相对路径与 Node 内置模块，或已声明的包；不得导入 dsh 自带包 | workspace 插件无法解析宿主包 |
| `locale/en.json` 的 `meta.displayName` / `meta.description`，以及图标格式与 256 KiB 上限 | 插件管理器显示元数据 |
| `files[]` 覆盖入口、patch、locale、图标 | `pnpm pack` / 发布不丢文件 |
| 无 UTF-8 BOM；README 表格最新 | 集成与文档 |

## 配置插件

每个插件在 **profile 自己的** `cordis.patch.yml`（例如 `~/.dsh/profiles/desktop/cordis.patch.yml`）
里都能改配置，不需要改本仓库。补丁层会**整体替换** `config`，所以写全需要的键：

```yaml
- id: window-capture
  name: '@local/dsh-plugin-window-capture'
  config:
    timeoutMs: 30000

- id: input-control
  name: '@local/dsh-plugin-input-control'
  config:
    timeoutMs: 15000

- id: seamless-continue
  name: '@local/dsh-plugin-seamless-continue'
  config: {}
```

## 测试插件

每个插件都有无依赖的自检脚本，覆盖纯逻辑、协议解析与注册接线：

```powershell
node scripts/test.mjs                      # 全部插件 + 仓库校验
node .\plugins\window-capture\test\check.mjs  # 单个插件
```

## 目录结构

```
.
├── catalog.json             # 插件清单：安装顺序、成员、默认 engines
├── scripts/
│   ├── validate.mjs         # 零依赖校验器（--write 重新生成文档表格，--list 输出目录名）
│   ├── test.mjs             # 自检 + 校验入口（CI 用同一条命令）
│   └── catalog.schema.json  # catalog.json 的 JSON Schema
├── .github/workflows/validate.yml
├── AGENTS.md                # 给 Agent 的规则：只用 plugin_manager 安装
├── CONTRIBUTING.md          # 新增插件的约定
├── package.json             # 仅为本仓库的元数据（不是 profile，不会被安装）
├── README.md
└── plugins/
    ├── README.md            # 插件索引（表格由校验器生成）
    ├── window-capture/      # -> @local/dsh-plugin-window-capture
    │   ├── package.json     #    dsh.bundle.patch
    │   ├── cordis.patch.yml #    本组合包插入的 Loader 行
    │   ├── index.js         #    插件入口：工具 + Config
    │   ├── capture-worker.cjs #  中完整性的截图工作进程
    │   ├── icon.svg
    │   ├── locale/{en,zh}.json
    │   └── test/check.mjs
    ├── input-control/       # -> @local/dsh-plugin-input-control
    └── seamless-continue/   # -> @local/dsh-plugin-seamless-continue
```

## 许可证

MIT
