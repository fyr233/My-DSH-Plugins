# 05 · 安装、卸载与生命周期

本文记录 `plugin_manager` 的真实行为，以及“`applied` 了却不生效”的几种成因。

## 1. 唯一安装入口

| 目的 | 调用 |
| --- | --- |
| 安装 / 重新链接 | `plugin_manager` `action: install_bundle`，`target` = 插件**目录**绝对路径 |
| 卸载 | `plugin_manager` `action: remove_bundle`，`target` = **包名** |
| 查看状态 | `plugin_manager` `action: list_bundles` |
| 验证能力 | `cordis_inspect_query`（`Tool.listTools` / `Config.listConfigs`） |

不要写 `install.ps1`，不要让用户“先退出桌面应用再跑脚本”。
`install_bundle` 在桌面应用运行时也能用，并**当场返回激活结果**。

命令行（`dsh plugin --profile desktop add …`）只给用户/CI 使用：
`desktop` profile 归桌面应用独占，命令行修改会报
`profile "desktop" is managed exclusively by the Electron application`。

## 2. 返回值怎么读

```jsonc
{
  "stage": "enable",
  "application": "applied",      // 唯一表示“已挂进运行中的配置”
  "bundle": "@local/…",
  "warnings": []
}
```

- `{"error":{"code":"already-installed"}}`：包已登记。换代码/换版本时先
  `remove_bundle`（包名）再 `install_bundle`（目录）。
- `application: "failed"`：读 `error.diagnostic`，它通常点名失败的行与异常。
- `application: "restart-required"`：要重启 dsh 才生效，必须如实告诉用户。
- `removable: false` + `readOnlyReason: "management-required"`：内置组合包，不能移除。

## 3. 为什么“改了代码没生效”（重要）

`install_bundle` 对已安装包做的是 pnpm 的 `link:` 更新，**不会重新加载已缓存的模块**。
现象：

- profile 里的 `node_modules/@local/<pkg>/index.js` 已经是新代码；
- 内存里运行的仍是旧版本（新加的监听器不触发、探针不写日志）；
- `install_bundle` 却返回 `applied`。

修复手段（按可靠性排序）：

1. **完全退出 dsh 再启动**（最可靠，本项目最终靠它验证成功）；
2. `remove_bundle` → `install_bundle`：对同一包重新挂载时通常能换新模块，
   但若两次操作之间插件又被卸载，监听器可能来不及运行；
3. 只改 `config`：直接改 profile 的 `cordis.patch.yml` 会触发卸载/重载，无需重启。

## 4. 仓库搬家

安装建立的是指向**绝对路径**的链接。仓库移动后：

- `list_bundles` 显示 `availability: "missing"`，
  `error.diagnostic` 含 `cannot resolve profile bundle "<包名>"`；
- 启动日志打印 `skipping profile bundle …`，界面上看不出差别。

修复：对每个插件 `remove_bundle`（包名）→ `install_bundle`（新目录）。

## 5. 版本与发布

- 改行为、默认值或资源：`version` 升 minor；破坏性变更升 major。
- `engines.dsh` 声明支持的 dsh 范围（本项目 `>=0.2.0 <0.3.0`）；
  范围不满足时安装和启动都会拒绝。
- `peerDependencies` 里的包必须同时写进 `devDependencies`（与宿主共享实例 + 本地检查）。
- 本地仓库的校验入口：`node scripts/test.mjs`（各插件自检 + 仓库校验）。

## 6. 安装后至少验证一次“行为”

`application: applied` 只说明挂了配置层。能力是否可用要另外证明：

- 注册的工具出现在 `Tool.listTools` 中；
- 调用一次并检查真实效果（截图能看到画面、`/continue` 能续写、审批会响）；
- 显示名/图标在插件管理页面正确（需要用户看一眼）。
