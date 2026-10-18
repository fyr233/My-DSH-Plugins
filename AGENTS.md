# 面向 Agent 的安装说明

本项目里**安装、卸载、检查插件一律使用 `plugin_manager` 工具**：

| 目的 | 调用 |
| --- | --- |
| 安装 / 重新链接一个插件 | `plugin_manager` `action: install_bundle`，`target` = 插件**目录**绝对路径 |
| 卸载一个插件 | `plugin_manager` `action: remove_bundle`，`target` = **包名** |
| 查看已装状态 | `plugin_manager` `action: list_bundles` |
| 验证工具真的加载 | `cordis_inspect_query` Host `Tool.listTools` |

**没有安装脚本，也没有第二个安装入口**：不要尝试 `install.ps1`、`dsh plugin`，也不要让用户
先退出桌面应用再手工安装。仓库里已删除这类脚本，`scripts/` 只保留校验与测试工具
（`validate.mjs`、`test.mjs`、`catalog.schema.json`），它们不碰 profile。

原因：`install_bundle` 是官方安装入口，执行 pnpm 安装 + 登记 `dsh.profile.bundles`，
并**当场挂载并应用**，直接返回 `application` 与错误诊断；应用运行时也能用，无需重启。

## 流程

1. `list_bundles`。`availability: missing` 且 `source` 指向旧路径的包，说明仓库搬过家。
2. 对每个目录调用 `install_bundle`。已登记过的包会返回
   `{"error":{"code":"already-installed"}}`：按 `nextStep` 先 `remove_bundle`（包名），
   再 `install_bundle`（目录）。
3. 只认 `application: applied`。`failed` 时读 `error.diagnostic`，修代码或清理后重装，
   不要原样重试；`restart-required` 要告诉用户需要重启。
4. 换了代码或版本时，一律 `remove_bundle` → `install_bundle`，否则运行中的旧模块不会被替换；
   仍不生效就请用户重启 dsh。
5. 用 `Tool.listTools` 确认插件的工具确实出现了，再回复用户。
6. 改动行为、监听点或原生调用前，先读 [docs/experiences](./docs/experiences/README.md)：
   那里记录了 `Config` 协议、locale 键名、事件作用域、同步播放、HIPS 拦截等已踩过的坑。

插件目录与顺序以 `catalog.json` 为准，`node scripts/validate.mjs --list` 会按顺序列出目录名。
