# DSH 插件集

一组可独立安装的 **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 插件组合包**。

`plugins/` 下每个子目录都是一个自包含的 npm 包，在 `package.json` 中声明 `dsh.bundle.patch`。
用 `dsh plugin add` 安装后，它会被链接进某个 [profile](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)，
并被追加到该 profile 的 `dsh.profile.bundles` 列表——正是这一步让 dsh 在启动时应用插件的 patch 层。

| 插件 | 包名 | 版本 | 提供的工具 / 命令 | 平台 |
| --- | --- | --- | --- | --- |
| [`window-capture`](./plugins/window-capture) | `@local/dsh-plugin-window-capture` | 2.0.0 | `list_windows`、`capture_window` | Windows |
| [`input-control`](./plugins/input-control) | `@local/dsh-plugin-input-control` | 1.0.0 | `click`、`type_text`、`press_keys`、`scroll`、`drag`、`move_mouse` | Windows |
| [`seamless-continue`](./plugins/seamless-continue) | `@local/dsh-plugin-seamless-continue` | 1.1.0 | `/continue` 命令 | 任意 |

`window-capture` 与 `input-control` 设计为配合使用：先截图，再按截图中看到的坐标操作，
然后再次截图确认结果。

## 环境要求

- **DeepSeek Harness** `0.2.x`。每个包都声明 `engines.dsh` 为 `>=0.2.0 <0.3.0`，
  版本范围不匹配时 dsh 会拒绝加载该组合包。
- **Node.js**（`window-capture` 与 `input-control` 需要用运行 dsh 的 Node 可执行文件启动工作进程）。
- **Windows**：`window-capture` 与 `input-control` 仅支持 Windows，在其它平台会返回明确的
  `NOT_WINDOWS` 错误，而不是静默出错。
- 一个可用的 `dsh` 命令。桌面应用自带一个：
  `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`，
  如果它不在 `PATH` 中，本仓库的脚本会自动找到它。

## 安装

把本仓库克隆到任意位置，然后在仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

这会把**全部**插件装入 `$env:DSH_PROFILE` 指定的 profile（默认 `desktop`）。常用参数：

```powershell
# 装入其它 profile
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Profile web

# 只装其中两个
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Plugin window-capture, input-control

# 只预览，不执行
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DryRun
```

### 为什么必须加 `-ExecutionPolicy Bypass`

本机执行策略是 `RemoteSigned`，从网络或克隆得到的 `.ps1` 没有数字签名，直接 `& .\install.ps1`
会报“未对文件进行数字签名”。上面这条命令只对**本次进程**放宽策略，不修改系统设置，
是最省事的做法（`-ExecutionPolicy Bypass` 在 `powershell.exe` 自身的参数列表中排在 `-File` 之前）。

另一种方式是把文件标记为本地来源后直接运行：

```powershell
Unblock-File .\install.ps1
.\install.ps1
```

### 先退出桌面应用

`desktop` profile 归桌面应用所有，dsh 会锁住它的 `package.json`。请**完全退出 DeepSeek Harness**
后再安装，装完再启动。装入 CLI profile（`web`、`headless` 等）没有这个限制。

安装动作本身，就是对每个插件执行一次：

```powershell
dsh plugin --profile <profile> add <插件目录的绝对路径>
```

本仓库没有构建步骤：插件直接以 ESM `index.js` 作为入口，克隆下来即可运行。

### 验证是否已加载

```powershell
dsh --profile desktop --dump-config | Select-String 'window-capture|input-control|seamless-continue'
```

每个已安装的组合包都会贡献一个带 `# == <包名>` 注释的层。若某个层缺失，说明该包没被加入
`dsh.profile.bundles`，重新运行安装脚本即可。

## 卸载

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

`dsh plugin remove` 会同时删除依赖项与对应的 bundle 层，不留残余。
可加 `-Plugin <名称>` 只卸载单个，或 `-DryRun` 预览。

## 移动或重命名仓库后

安装建立的是一条**链接**，指向当前目录。所以移动文件夹会让链接失效：
dsh 仍指向旧路径，插件导入失败且不会报出明显错误。

移动之后，**在新位置重新运行一次 `install.ps1`** 即可。它会在新的绝对路径上重新添加每个组合包，
而已经在 `dsh.profile.bundles` 中的包不会被重复添加。

## 什么样的目录才是一个 DSH 组合包

按[发布文档](https://deepseek-harness.github.io/deepseek-harness/develop/basic/publish)的要求，manifest 约定如下：

```jsonc
{
  "name": "@local/dsh-plugin-example",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "main": "index.js",                         // ESM 入口，导出 `name` 与 `apply(ctx)`
  "exports": { ".": "./index.js" },
  "files": ["index.js", "cordis.patch.yml"],  // `pnpm pack` 会打包的文件
  "engines": { "dsh": ">=0.2.0 <0.3.0" },     // 声明支持的 dsh 版本范围
  "peerDependencies": { "@deepseek-ai/cordis": "~4.0.5" },  // 与宿主共享同一实例
  "devDependencies": { "@deepseek-ai/cordis": "~4.0.5" },   // 供本地类型检查
  "dsh": {
    "manifestVersion": 1,
    "bundle": { "patch": "./cordis.patch.yml" }             // 组合包声明
  }
}
```

`cordis.patch.yml` 是一个 YAML 数组，用 insert 条目插入本插件的 Loader 行：

```yaml
- insert:
    - id: example
      name: '@local/dsh-plugin-example'
      config: {}
```

行中的 `name` 必须是**包名**，不能写相对路径，这样 Node 的模块解析才能找到已安装的副本。

### 字段说明

- **`engines.dsh`** —— SemVer 范围。声明了它时，只由它决定兼容性（`peerDependencies` 的范围被忽略）；
  没声明时 dsh 改为检查 `peerDependencies` 里的 `@deepseek-ai/dsh*`。
  本插件集是 `private` 且从不发布，peer 回退路径永远不会生效，所以显式写 `engines.dsh`
  才是防止它被装入不兼容未来版本的唯一手段。
- **`private: true`** —— 这些是按路径安装的本地检出，不是注册表包。若将来决定发布，应去掉此字段。
- **没有 `dsh.client`** —— 这些插件都不带浏览器端 bundle，因此都不声明它。
  `dsh.client` 声明要求存在真实的 `./client` 导出，不声明才是正确的。

## 测试插件

每个插件都有无依赖的检查脚本，覆盖纯逻辑与协议解析：

```powershell
node .\plugins\window-capture\test\check.mjs
node .\plugins\input-control\test\check.mjs
node .\plugins\seamless-continue\test\check.mjs
```

## 目录结构

```
.
├── install.ps1              # 把全部组合包装入 profile（或重新链接）
├── uninstall.ps1            # 从 profile 中移除全部组合包
├── package.json             # 仅为本集合的元数据（不是 profile，也不会被安装）
├── README.md
└── plugins/
    ├── window-capture/      # -> @local/dsh-plugin-window-capture
    │   ├── package.json     #    dsh.bundle.patch
    │   ├── cordis.patch.yml #    本组合包插入的 Loader 行
    │   ├── index.js         #    插件入口：工具
    │   ├── capture-worker.cjs #  中完整性的截图工作进程
    │   ├── icon.svg
    │   ├── locale/{en,zh}.json
    │   └── test/check.mjs
    ├── input-control/       # -> @local/dsh-plugin-input-control
    └── seamless-continue/   # -> @local/dsh-plugin-seamless-continue
```

`plugins/` 只放可安装的插件，脚本与文档留在仓库根目录，方便以后继续往里加插件。

## 许可证

MIT
