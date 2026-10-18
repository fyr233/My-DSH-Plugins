# 03 · 配置、显示元数据与搜索

本文记录 `Config`、`locale`、图标与打包字段的**确切**约定。三条都踩过坑，
每条都附带“错误写法会怎样”。

## 1. Config 必须是 Standard Schema

dsh 用 Cordis 的 Standard Schema 接口校验插件行配置。导出**纯 JSON Schema 对象**时，
dsh 会尝试寻找一个校验器包——workspace 插件解析不到它，于是整行激活失败：

```
window-capture (@local/dsh-plugin-window-capture): TypeError: Cannot read properties of undefined (reading 'validate')
```

正确写法：

```js
const DEFAULTS = { timeoutMs: 20000 }

export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugins-example',
    validate(value) {
      const config = { ...DEFAULTS }          // 先铺默认值
      if (value === undefined || value === null) return { value: config }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, entry] of Object.entries(value)) {
        if (!(key in DEFAULTS)) return { issues: [{ message: `unknown config key: ${key}`, path: [key] }] }
        // …范围/类型检查
        config[key] = entry
      }
      return { value: config }
    },
  },
}
```

要点：

- `validate` 返回 `{ value }` 或 `{ issues }`；`apply(ctx, config)` 收到的就是补齐默认值后的值。
- 补丁层**整体替换** `config`，所以每个键都要有默认值，用户只写想改的键即可。
- 校验器（`scripts/validate.mjs`）会检查：空配置能通过、未知键被拒绝。
- `await import(entry)` 检查其 `Config` 是否带 `~standard`。

## 2. locale：只有 meta.title 和 meta.description

插件管理器用 Node 解析 `<包名>/locale/<语言>.json`，读取代码是：

```js
title: textOf(meta?.title, `${file}: meta.title`),
description: textOf(meta?.description, `${file}: meta.description`)
```

- 键名写成 `displayName` 会被**静默忽略**，卡片标题退回包名
  （本项目 `plugin-window-capture` 曾一直这样显示）。
- 必须导出 `"./locale/*.json": "./locale/*.json"`，并在 `files[]` 包含 `locale/*.json`。
- `zh.json` 的 `meta.title` 用中文；`en.json` 覆盖同一批关键词。

```json
{ "meta": { "title": "窗口截图", "description": "截取某个程序窗口或整个桌面（截图 / 截屏 / screenshot / capture）…" } }
```

## 3. 搜索是对标题与描述的**子串匹配**

插件管理器的搜索框匹配卡片标题与描述，不是分词、不是同义词：

- 描述里要写用户会搜的中英文词与工具/命令名，例如 `截图 / 截屏 / screenshot / capture`、
  `capture_window`、`/continue`、`click / type / scroll`。
- 多个插件共享的词（例如“截图”）会让它们同时命中——这是正常结果，不是命名错误。
  想让某个插件独占一个词，就别把它写进别的插件描述里。

## 4. 图标

- SVG / PNG / JPEG / WebP，≤ 256 KiB，必须在包内。
- 两种声明方式：`package.json` 的 `"icon": "./icon.svg"`（优先）或导出 `"./icon"`。
- 校验器会检查字节头（PNG `89 50 4E 47`、SVG 以 `<svg` 开始等），
  **只改扩展名不算**。
- 图标要自绘或有许可；内置插件里没有可复用的图标资源。

## 5. files[] 与发布

- 本地目录安装时 `files[]` 不会裁剪文件，但 `pnpm pack`/发布时会。
- `files[]` 必须包含：入口、worker、`cordis.patch.yml`、`locale/*.json`、图标。
- 校验器会按 npm 语义展开 `files[]`，报告“应包含但没包含”的文件。

## 6. 验证显示效果

`cordis_inspect_query` 的 `Config.listConfigs`（`name` 填包名）能看到该行状态；
显示名/描述/图标最终由**插件管理页面**渲染，Agent 无法可靠截图审批类 UI，
所以显示层面的验收需要用户确认一次（本项目都是让用户看「设置 → 插件」）。
