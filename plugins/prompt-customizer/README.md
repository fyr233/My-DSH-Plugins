# 提示词自定义 / Prompt Customizer

轻量 Host + Client 插件。在「更多 → 设置 → 提示词自定义」编辑身份开场白、personaPrefix 和 personaSuffix。

## 使用

- 每段独立选择默认或自定义；默认使用 `null`，自定义空字符串明确隐藏该段。
- 「保存并应用」调用 Harness settings 服务，将 overrides 写入当前 profile 配置，成功后重启仍生效。
- 「全部恢复默认」将三段设为 null 并持久保存，撤销本插件覆盖，恢复当前 Harness / preset 的默认值，而不是写回固定字符串。
- 不要在提示词里保存密钥。它们是普通配置文本，且会进入模型请求及会话记录。
- 更新从下一次重新组装的模型步骤生效，不影响已发送的请求。

## 范围及限制

适用于当前 profile 的顶层 Agent；子 Agent 保持委派角色，不覆盖。使用公开 `agent.ctx.systemPrompt.section()` 同名遮蔽上层默认值，不修改安装包、不截获组装 waterfall、不改工具或运行时上下文。

完整提示词 preset 不支持。公开 API 不暴露 complete 标志，因此保守跳过只有一个（或没有）组装段的 Agent；这不是对 complete 的精确识别。同一 Agent 作用域已有同名段时回滚该 Agent 的本次注册，并通过 `prompt_customizer get/inspect` 返回 conflict。不强行删除其他插件的段。

UI 保存确认的是配置落盘；可用 `prompt_customizer inspect` 检查当前会话的实际组装段和应用状态。首次安装不改变默认提示词。

## 工具

`prompt_customizer`：get / inspect / set / reset。set 和 reset 要求 get 返回的 expectedRevision；GUI 与工具都调用同一 settings.update 服务。

## 开发

在插件目录运行 `npm test`；或从仓库根目录运行：

```sh
node --test --test-isolation=none plugins/prompt-customizer/core.test.js
node --check plugins/prompt-customizer/index.js
node --check plugins/prompt-customizer/client.js
```

测试无需加载 Host 依赖；关闭测试进程隔离是为了兼容 Windows 沙箱的子进程管道限制。

Host 使用 schemastery 的 volatile Config 与 settings/document-updated 通知。普通 Node 环境需要安装声明的 schema 依赖；Desktop 的目录链接安装可回退到当前应用自带的 schemastery，不依赖固定的用户安装路径。

插件卸载清理所有注册；原始默认段从未被修改。图标为原创 SVG。测试范围和未验证项见 [VERIFICATION.md](./VERIFICATION.md)。
