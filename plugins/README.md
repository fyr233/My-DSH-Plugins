# 插件索引

本目录下每个子目录都是一个可独立安装的 DSH 组合包。成员、顺序以仓库根目录的
**`catalog.json`** 为准；下面的表格由 `node scripts/validate.mjs --write` 生成，请勿手改。

<!-- BEGIN PLUGINS -->
<!-- 本表格由 scripts/validate.mjs --write 生成，请勿手改。 -->
| 插件 | 包名 | 版本 | 提供的工具 / 命令 | 平台 |
| --- | --- | --- | --- | --- |
| [窗口截图](./plugins/window-capture) | `@local/dsh-plugin-window-capture` | 2.1.0 | `list_windows`、`capture_window` | Windows |
| [键鼠控制](./plugins/input-control) | `@local/dsh-plugin-input-control` | 1.1.0 | `click`、`type_text`、`press_keys`、`scroll`、`drag`、`move_mouse` | Windows |
| [断点续写](./plugins/seamless-continue) | `@local/dsh-plugin-seamless-continue` | 1.2.0 | `/continue` 命令 | 任意 |
| [对话提示音](./plugins/approval-sound) | `@local/dsh-plugin-approval-sound` | 3.0.0 | — | Windows |
<!-- END PLUGINS -->

## 各插件说明

- **window-capture**：`list_windows` 列出可见桌面窗口（句柄、标题、进程、位置与大小），
  `capture_window` 按句柄或标题截取单个窗口，或 `mode: "screen"` 截取整个桌面，并把图像
  作为附件直接交给模型。截取在**中完整性**的工作进程中运行：受限令牌下 `PrintWindow`
  对 GPU 合成的窗口（Chromium、Electron、游戏）会失败，只能退化为屏幕拷贝；中完整性下
  即使窗口被遮挡也能后台渲染。
- **input-control**：`click`、`type_text`、`press_keys`、`scroll`、`drag`、`move_mouse`。
  同样通过中完整性工作进程注入：受限令牌下 Win32 `SendInput` 会「报告成功」但被 UIPI
  静默丢弃。坐标空间（`scope`）与 `capture_window` 对应，因此可以「看—操作—再看」闭环。
- **seamless-continue**：`/continue` 命令。一轮对话被中途打断后从断点继续，而不是重新发
  一条「继续」。它只修正**模型看到的上下文**，不改动会话日志：`/continue` 投递一条空的
  载体消息，在接收该消息的那一步由 `agent/pre-step` 瀑布处理，并为被中断时缺失结果的工具
  调用补上说明性的恢复结果。持久化日志、GUI 记录、fork 与回放的行为都保持不变。
- **approval-sound**：三个时刻各响一种音——权限申请（`approval/request` +
  `tools/pre-execute` 的 `ask`）、Agent 提问（`user-questions/request`）、一轮结束
  （`agent/turn-stopping`）。以直通方式监听，不改变任何决策；Windows 上在 dsh 进程内经
  koffi 调用 `winmm!sndPlaySoundW` 同步播放（不启动子进程、不用 PowerShell），
  Linux/macOS 用 `paplay`/`aplay`/`afplay`；可按类别单独开关、替换 wav、节流。

新增插件时请阅读 [CONTRIBUTING.md](../CONTRIBUTING.md)。
