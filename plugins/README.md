# 插件索引

本文件列出 `plugins/` 下的全部插件。新增插件时请同步更新这里和根目录 README 的表格。

## window-capture — 窗口截图

| 项 | 内容 |
| --- | --- |
| 包名 | `@local/dsh-plugin-window-capture` |
| 版本 | 2.0.0 |
| 入口 | `index.js` |
| 工作进程 | `capture-worker.cjs` |
| 注入服务 | `tools`、`attachments` |
| 平台 | Windows |

提供的工具：

- `list_windows` —— 列出可见桌面窗口（句柄、标题、进程、位置与大小），可按标题或进程名过滤。
- `capture_window` —— 按句柄或标题截取单个窗口，或 `mode: "screen"` 截取整个桌面，
  以图片附件的形式直接交给模型。

截取在**中完整性**的工作进程中运行：受限令牌下 `PrintWindow` 对 GPU 合成的窗口（Chromium、
Electron、游戏）会失败，只能退化为屏幕拷贝；在中完整性下即使窗口被遮挡也能后台渲染。

## input-control — 键鼠控制

| 项 | 内容 |
| --- | --- |
| 包名 | `@local/dsh-plugin-input-control` |
| 版本 | 1.0.0 |
| 入口 | `index.js` |
| 工作进程 | `input-worker.cjs` |
| 注入服务 | `tools`、`subprocess`（可选，运行时查找） |
| 平台 | Windows |

提供的工具：`click`、`type_text`、`press_keys`、`scroll`、`drag`、`move_mouse`。

同样通过中完整性的工作进程注入：受限令牌下 Win32 `SendInput` 会“报告成功”但被 UIPI 静默丢弃。
坐标空间（`scope`）与 `capture_window` 的取值范围对应，因此可以“看—操作—再看”闭环。

## seamless-continue — 断点续写

| 项 | 内容 |
| --- | --- |
| 包名 | `@local/dsh-plugin-seamless-continue` |
| 版本 | 1.1.0 |
| 入口 | `index.js` |
| 注入服务 | `commands`、`sessions` |
| 平台 | 任意 |

提供 `/continue` 命令：一轮对话被中途打断后，从断点继续，而不是重新发一条“继续”。

它只修正**模型看到的上下文**，不改动会话日志：`/continue` 投递一条空的载体消息，
在接收该消息的那一步由 `agent/pre-step` 瀑布把它替换掉，并为被中断时缺失结果的工具调用
补上一条说明性的恢复结果，使模型从自身的断点处接着写。持久化日志、GUI 记录、fork
与回放的行为都保持不变。
