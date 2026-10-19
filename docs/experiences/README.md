# DSH 插件开发经验

本目录记录在实际开发与排障中**被证实**的 dsh（DeepSeek Harness）架构、插件机制与开发约定。
每条结论都标注了证据来源：源码位置、`cordis_inspect_query` 查询结果，或一次可复现的实测。
遇到新问题先查这里，再改代码。

## 阅读顺序

| 文档 | 先读它，当你…… |
| --- | --- |
| [01-architecture.md](./01-architecture.md) | 需要理解 dsh 由哪些层组成、谁负责什么 |
| [02-plugin-mechanism.md](./02-plugin-mechanism.md) | 要写插件、注册监听、用 `ctx.*` 服务 |
| [03-config-and-display.md](./03-config-and-display.md) | 要给插件加配置、中文名、图标、搜索关键词 |
| [04-events-and-scopes.md](./04-events-and-scopes.md) | 要挂事件、确认哪个事件真的会被派发 |
| [05-install-and-lifecycle.md](./05-install-and-lifecycle.md) | 要安装/卸载/更新插件，或“改了没生效” |
| [06-windows-native.md](./06-windows-native.md) | 要在 Windows 上做截图、输入、声音等系统能力 |
| [07-debugging-playbook.md](./07-debugging-playbook.md) | 插件不出声/不触发/不显示，需要定位 |
| [08-client-plugins.md](./08-client-plugins.md) | 要写 Web 半边插件（声音、通知、UI 反馈），或分不清该放 Host 还是 Client |

本目录只放 **dsh 机制**层面的结论。本机环境相关的（GitHub 访问、火绒、沙箱、git 位置）
在 [../local-setup](../local-setup/README.md)，两边不混。

## 十条最容易踩坑的结论（速查）

1. **安装只走 `plugin_manager`**（`install_bundle` / `remove_bundle`），不要写安装脚本，
   也不要把“请先退出应用再跑脚本”丢给用户。
2. **`install_bundle` 对已安装包只更新链接，不重新加载模块**——改了代码必须
   `remove_bundle` → `install_bundle`，或重启 dsh。见经验 5。
3. **`Config` 必须用 Standard Schema（`~standard`）**，纯 JSON Schema 会让条目激活失败，
   报 `Cannot read properties of undefined (reading 'validate')`。见经验 3。
4. **locale 只认 `meta.title` 与 `meta.description`**，写成 `displayName` 会被静默忽略，
   卡片标题退回包名。见经验 3。
5. **入口不能 `import '@deepseek-ai/dsh-*'`**，只能走 `inject` + `ctx.*` / `ctx.get()`。
   唯一可用的宿主库是 dsh 自带的 koffi，并且要按绝对路径加载。见经验 6。
6. **事件是 scope-filtered 的，不能假设“事件存在就会派发到你的插件”**。要验证，
   不要推理。见经验 4。
7. **`approval/request` 收不到工具提权类的审批**，那类通过 `tools/pre-execute` 的
   `ask` 决策体现。见经验 4。
8. **Electron 主进程没有控制台**：向 stdout/stderr 写 `\a` 到不了设备；
   也没有可直接使用的异步音频会话（`SND_ASYNC` 返回 true 但不出声）。见经验 6。
9. **不要在 Windows 上隐蔽启动进程**：`powershell.exe -WindowStyle Hidden` 会触发火绒等
   HIPS 的“静默运行”拦截；`Start-Process -WindowStyle Hidden` 同理。见经验 6。
10. **验证要观察真实证据**：`application: applied` 不代表能力生效；用
    `cordis_inspect_query` 看工具是否出现、看配置条目状态，必要时要用户拿耳朵/眼睛确认。
    见经验 7。
11. **反馈要放在“人所在的那一侧”**：Host 与 Client 分离时，Host 播的声音没人听得见；
    但截图这类**动作发生在 Host** 的事情，确认音也该在 Host。见经验 8。
12. **Web 半边最简写法是 `immediately: true` + `inject: []` + `./lib/client.js`**；
    `inject` 里写不存在的包名会让插件永远停在 PENDING。见经验 8。
13. **“待处理交互”（审批/提问）只有 Client 的 `uiSession.sessionStatus.pendingInteraction`
    能拿到**，且必须 `ctx.inject(['uiSession'], …)` 等它出现——一次性 `ctx.get` 永远是
    `undefined`，提醒音会静默失效。见经验 8。
