# 07 · 排障手册：插件不响、不触发、不显示

按“从便宜到昂贵”的顺序排查。每一步都给出**客观证据**，不要凭感觉判断。

## 0. 先区分三类问题

| 症状 | 可能层面 |
| --- | --- |
| 插件不在「设置 → 插件」里 | 没安装 / 链接失效（经验 05） |
| 在，但改了没效果 | 模块没重载（经验 05） |
| 在，也重载了，但监听不触发 | 事件作用域 / 触发点选错（经验 04） |
| 触发了，但动作失败 | 能力路径（权限、音频、完整性，经验 06） |

## 1. 插件是否装了、链接指向哪里

```
plugin_manager(action: list_bundles)
```

关注每个包的 `source`、`availability`、`error.diagnostic`：

- `availability: "missing"` + `cannot resolve` → 仓库搬过家，重新 `install_bundle`。
- `removable: false` → 内置包，不要试图移除。

## 2. 插件是否真的被加载

```
cordis_inspect_query(platform: "host", provider: "Config", method: "listConfigs",
                     input: { name: "@local/dsh-plugin-xxx" })
```

- 有 `include:<id>` 条目 → 行已进入 Loader。
- `status: "unsupported"` 在本项目中意味着该行没有可展示的 JSON Schema（不是故障）。
- 没有条目 → 包名写错，或 bundle 未被登记。

## 3. 代码是否是新版本

这是最容易误判的一步：

1. 看 profile 里的文件：`~/.dsh/profiles/desktop/node_modules/@local/<pkg>/index.js`
   是否包含你刚写的字符串（例如新监听器名）；
2. **文件是新的、行为是旧的** → 模块没重载。`remove_bundle` → `install_bundle`，
   仍不行就**重启 dsh**（经验 05 §3）。

## 4. 监听器是否被调用（不要靠猜）

- 事件监听类插件：先注册一个**不依赖事件**的工具，用 `Tool.listTools` 确认它出现，
  证明插件在跑；再调用它，确认插件里的其它逻辑正常。
- 需要记录事件时，把日志写到工作区内的文件；**验证完删除**，不要留在插件里。
- 注意：如果用来触发的正是 `remove_bundle`，插件会在审批框出现前被卸载，
  监听器来不及写日志——换一个不会卸载自身的动作来触发。

## 5. 事件是否会被派发

```
cordis_inspect_query(platform: "host", provider: "Event", method: "listEvents",
                     input: { event: "approval/request" })
```

- 看 `mode`（emit / serial / waterfall）与签名里的 `this: Scoped<Agent>`；
  带 Scoped 的事件只在对应作用域派发。
- 本项目实测：`plugin_manager` 提权审批**只**出现在 `tools/pre-execute` 的 `ask` 决策里，
  不会到达插件的 `approval/request` 监听（经验 04 §2）。
- 结论：能挂两个点就挂两个点，用节流去重。

## 6. 动作失败

| 现象 | 说明 |
| --- | --- |
| `TypeError: … reading 'validate'` | `Config` 用了纯 JSON Schema（经验 03） |
| 卡片标题显示成包名 | locale 用了 `displayName` 而不是 `meta.title`（经验 03） |
| 搜不到插件 | 标题/描述里没有用户会搜的词（经验 03 §3） |
| 火绒提示“PowerShell 静默运行” | 插件运行期启动了隐藏窗口的 PowerShell（经验 06 §2） |
| 有 `return true` 但听不到 | 用了 `SND_ASYNC`（经验 06 §3.1） |
| 弹“不是有效的 Win32 应用程序” | `rundll32 <wav>,<export>` 的副作用（经验 06 §3） |

## 7. 验证要“可观察”

- `application: applied` 只代表配置层挂上了；
- 工具类能力：`Tool.listTools` + 真实调用一次；
- 视觉/听觉：Agent 无法可靠截到审批框、也无法听见声音，**必须请用户确认一次**，
  并明确告诉用户“现在应该听到什么”；
- 审批面板弹出时调用方是阻塞的，期间无法执行其它工具。

## 8. 收尾

- 删除所有探针、临时日志、`.probe/` 之类的脚手架；
- `node scripts/test.mjs` 全绿；
- 更新 README 中与行为相关的说明（触发点、限制、配置键）；
- 提交时把**结论**写进 commit message，而不只是“修了 bug”。
