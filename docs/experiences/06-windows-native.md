# 06 · Windows 系统能力：截图、输入、声音、进程

本项目的三个原生能力插件都遇到同一类问题：**受限令牌、没有控制台、HIPS 拦截**。
下面是每条踩坑与结论。

## 1. 文件系统沙箱与进程完整性

- dsh 的 shell 工具在受限令牌下运行（Windows 上被降为 Low 完整性），写工作区外会被直接拒绝，
  而不是弹审批。
- 需要 `PrintWindow`（GPU 合成的窗口）或 `SendInput`（UIPI 会把事件丢弃）时，
  必须在中完整性进程里做。
- 做法：`ctx.subprocess.spawn({ argv: [process.execPath, WORKER, JSON.stringify(request)], … })`，
  用运行 dsh 的 Node 启动 `*.cjs` 工作进程，走 JSON 进出，不经过 shell。

## 2. 不要隐蔽启动进程

Windows 上的 HIPS（如火绒）会拦截“隐藏窗口启动的进程”，典型触发方式：

```powershell
powershell.exe -WindowStyle Hidden -Command "…"
Start-Process -WindowStyle Hidden …
```

本项目早期用 PowerShell 播放提示音，每次审批都会触发火绒的“PowerShell 静默运行”拦截。
**结论：插件运行期不要启动 PowerShell、不要用隐藏窗口**；开发期一次性脚本可以例外但要在验证后清理。

## 3. 声音：四条方案的实测结果

| 方案 | 结果 |
| --- | --- |
| 向 stdout/stderr 写 `\a`（BEL） | ❌ 桌面应用没有控制台，到不了设备；Linux/macOS 终端里才有意义 |
| `powershell.exe` + `System.Media.SoundPlayer` | ✅ 有声，但每次触发火绒拦截 |
| `rundll32.exe <wav>,<导出名>` | ⚠️ 会调用导出，但顺带把 wav 当 DLL 加载，弹“不是有效的 Win32 应用程序” |
| **koffi 进程内调用 `winmm!sndPlaySoundW`** | ✅ 最终采用；不启动进程、无 HIPS 提示 |

### 3.1 同步，不要异步

```js
const winmm = koffi.load('winmm.dll')
const sndPlaySoundW = winmm.func('bool __stdcall sndPlaySoundW(str16 lpszSound, uint flags)')
sndPlaySoundW(path, 0x00020000)   // SND_FILENAME，同步，播完才返回
```

实测（真实 dsh 进程内）：

- `SND_ASYNC | SND_FILENAME`：**0 ms 返回 true，但没有声音**（主进程没有可用消息循环/音频会话）；
- `SND_FILENAME`（同步）：约 **2.3 s** 返回，声音完整播放。

提示音长约 0.2–0.5 s，同步阻塞可接受。

### 3.2 加载 koffi 的方式

dsh 自带的 koffi 位于：

```
<dsH 安装目录>/resources/app.asar.unpacked/dsh/node_modules/koffi
```

它是 N-API 模块（`napi 10`），Electron 44 与 Node 24 都能加载。插件是 ESM，用：

```js
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const koffi = require(`${KOFFI_DIR}/index.cjs`)
```

从 `process.execPath` 向上探测安装目录找到 `koffi/package.json`；找不到就记一条警告、
静默降级（不要抛错，否则审批流程会被插件拖垮）。

### 3.3 跨平台

- Linux：`paplay`（PulseAudio/PipeWire）或 `aplay`（ALSA）；
- macOS：`afplay`。
  这三者都是系统自带程序，且不在 Windows 的 HIPS 规则范围内。

### 3.4 自生成音频

不随包分发二进制，首次使用时在内存生成 WAV 并缓存到系统临时目录：
16-bit mono 22.05 kHz，880 Hz → 1175 Hz 两段带淡入淡出，约 0.5 s。
`soundFile` 配置可替换为用户自己的 wav。

## 4. 截图与输入的补充

- `PrintWindow` 在 Low 完整性下对 Chromium/Electron/游戏窗口返回空白，
  必须在中完整性工作进程中做；失败要给出明确的错误码（如 `BLANK_CAPTURE`）。
- 坐标空间要与截图 `scope` 对齐（`window` 含边框，`client` 只有内容区）。
- 截图临时文件写到 `tmpdir()`，用完 `rm(..., { force: true })`；
  图片用 `ctx.attachments.saveImage()` 持久化，不要把 PNG 字节塞进 stdout。

## 5. 工具回退清单

出现以下错误时先查本文，而不是改代码猜：

| 现象 | 先查 |
| --- | --- |
| `NO_SUBPROCESS` | profile 是否启用了 `subprocess` 服务 |
| `NOT_WINDOWS` | 平台判断是否正确 |
| `BLANK_CAPTURE` | 是否在受限令牌里调用了 `PrintWindow` |
| 审批提示音无声 | 是否用了异步播放；插件是否真的重载（经验 05） |
| 火绒“静默运行” | 是否有隐藏窗口的 PowerShell/进程启动 |
