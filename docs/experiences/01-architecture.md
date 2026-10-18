# 01 · dsh 的架构分层

本文说明一次 dsh 启动由哪些部分组成，以及每部分对插件作者意味着什么。
证据来自安装目录 `resources/app.asar/dsh`、插件管理器的配置文件清单
（`@deepseek-ai/dsh-*/README.md`）与 `cordis_inspect_query`。

## 1. 运行时形态

| 形态 | 入口 | 是否有控制台 | 备注 |
| --- | --- | --- | --- |
| 桌面应用 | `DeepSeek Harness.exe`（Electron） | **没有** | 主进程同时是 Host；`resources/app.asar` 内有全部 dsh 包 |
| CLI | `resources/runtime/cli/bin/dsh.cmd` | 有 | 内部就是 `ELECTRON_RUN_AS_NODE=1` + Electron 跑 `cli.js` |
| 源码检出 | `pnpm dsh ...` | 有 | 与 CLI 相同的组合逻辑 |

关键事实：**桌面应用和 CLI 运行在同一套 Electron 二进制上**
（实测 `Electron 44.7.0 / Node 24.21.0 / NODE_MODULE_VERSION 149 / napi 10`）。
因此“Node 能跑的”CLI 能跑，“桌面里跑不了”的东西通常也不是运行时差异，而是进程形态
（没有控制台、主进程没有消息循环/音频会话）。

## 2. 一次启动由四层叠加

```
空根
 └─ profile 的 dsh.profile.bundles：按顺序应用每个组合包的 patch 层（base → web-app → 第三方）
     └─ profile 自己的 cordis.patch.yml
         └─ $DSH_HOME/cordis.patch.yml（机器本地偏好）
             └─ 每个 --patch <path> overlay（按 argv 顺序）
```

- 后应用的层按**行 id** 覆盖前面；`config` 是**整体替换**，不是深合并。
  所以补丁里要写全该行需要的键。
- 内置组合包（`@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`）始终从 dsh 安装目录解析，
  第三方包从 profile 的 `node_modules` 解析。

## 3. Host 与 Client 两个半边

| 半边 | 运行于 | 能做什么 | 不能做什么 |
| --- | --- | --- | --- |
| **Host** | Electron 主进程（或 CLI 进程） | 工具、服务、事件、文件、进程、审批 | 不能直接操作 DOM |
| **Client** | 浏览器（Web GUI） | 页面、面板、装饰、交互 | 不能直接读本机文件、不能启动进程 |

插件可以只有 Host 半边（本项目全部如此），也可以带 `dsh.client`（需要导出 `./client`）。
两者通过 Remote（`ctx.remote`、`ctx.remote.$on(...)`）通信。

例如审批：Host 侧 `dsh-user-approval` 提供 `ctx.approval`；Client 侧
`@deepseek-ai/dsh-client-ui-approval` 用 `ctx.remote.$on("approval/request", ...)` 收请求、
渲染面板，再把 `allowed-once / rejected / cancelled / unavailable` 送回 Host。

## 4. 主要服务（插件通过 `inject` 使用）

| 服务 | 用途 | 本项目用法 |
| --- | --- | --- |
| `tools` | 注册模型可调用的工具 | window-capture / input-control |
| `subprocess` | 启动受管子进程 | 早期版本用于截图/输入工作进程 |
| `commands` | 注册 `/命令` | seamless-continue 的 `/continue` |
| `sessions` | 会话存储、追加事件 | seamless-continue 读取会话日志 |
| `attachments` | 保存图片附件 | window-capture 把截图交给模型 |
| `approval` | 审批服务（`dsh-user-approval`） | approval-sound 观察审批 |
| `systemPrompt`、`agents`、`llm`… | 其他扩展点 | 未使用 |

用 `cordis_inspect_query`（Host `Service`，`listService`）查询真实方法与签名，
不要凭记忆写 API。示例：`tools.register(definition)` 返回 disposer；
`tools.schemas(scope?)` 返回模型可见的 schema 列表。

## 5. 事件总线的三种模式

`cordis_inspect_query`（Host `Event`，`listEvents`）会给出 `mode`：

| 模式 | 语义 | 典型事件 |
| --- | --- | --- |
| `emit` | 通知，观察即可，不能改结果 | `tools/result`、`session/event` |
| `serial` | 依次 await，返回 `Promise<void>` | `agent/created`、`agent/turn-stopping` |
| `waterfall` | 可改结果，**必须 `return next()`** | `agent/pre-step`、`tools/pre-execute`、`approval/request` |

waterfall 监听器若不调用 `next()`，会截断后续所有监听器——这是插件最常见的破坏方式。

## 6. profile 与磁盘布局

```
$DSH_HOME（默认 ~/.dsh）
├── profiles/desktop/
│   ├── package.json        # dependencies(link:…) + dsh.profile.bundles
│   ├── cordis.patch.yml    # 用户自己的覆盖层
│   ├── pnpm-workspace.yaml
│   └── node_modules/@local # 指向插件目录的符号链接
├── sessions/<workspace>/<session-id>/session.v4.jsonl.zstd
└── attachments/v1/objects  # 图片等附件
```

- `desktop` profile 归桌面应用独占：命令行修改会报
  `profile "desktop" is managed exclusively by the Electron application`。
- 会话日志是 zstd 压缩的 jsonl，第一行是 header；会话进行中可能只刷出 header。
