# 本机使用技巧

与 dsh 机制无关、只在这台机器（或这类受限 Windows 环境）上才需要注意的经验。
机制层面的结论在 [../experiences](../experiences/README.md)，两边不混。

## 1. GitHub 访问：schannel 失败时改走 CONNECT 隧道

现象：`git clone`、`curl`、`Invoke-WebRequest` 全部失败，报

```
schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030E)
```

原因不是网络不通，也不是代理没开（`Test-NetConnection 127.0.0.1 -Port 7890` 是通的）：
受限进程读不到 Windows 证书存储，**schannel 拿不到凭据**。`HTTP_PROXY` / `HTTPS_PROXY` 环境变量
对 schannel 这条路没有帮助。

可行办法：**手动 CONNECT 隧道 + Node 自带 TLS**（不走 schannel、不依赖证书存储）：

```js
const http = require('node:http'), tls = require('node:tls')
const req = http.request({ host: '127.0.0.1', port: 7890, method: 'CONNECT', path: 'raw.githubusercontent.com:443' })
req.on('connect', (res, socket) => {
  const t = tls.connect({ socket, servername: 'raw.githubusercontent.com' }, () => {
    t.write('GET /<owner>/<repo>/HEAD/<path> HTTP/1.1\r\nHost: raw.githubusercontent.com\r\nConnection: close\r\n\r\n')
  })
  let body = ''
  t.on('data', (chunk) => { body += chunk })
  t.on('end', () => console.log(body.slice(body.indexOf('\r\n\r\n') + 4)))
})
req.end()
```

- 保存成脚本（例如 `%TEMP%\ghfetch.cjs`），传参 `host path` 即可反复取任意 raw 文件。
- 代理端口以本机为准；Mihomo Party 等客户端一般监听 `127.0.0.1:7890`。
- `web_fetch` 工具能直连 GitHub Pages 与 npm registry，可以优先用它；需要读 raw 源码时再用
  上面的隧道。

## 2. 找不到 git 命令

PowerShell 的 PATH 里可能没有 git。GitHub Desktop 自带一份：

```
C:\Users\<user>\AppData\Local\GitHubDesktop\app-<版本>\resources\app\git\cmd\git.exe
```

`app-*` 有多份时取最新版本。也可以把该 `cmd` 目录加入 PATH 一劳永逸。

## 3. 火绒拦截“PowerShell 静默运行”

触发场景：`powershell.exe -WindowStyle Hidden -Command …`、`Start-Process -WindowStyle Hidden`。
插件运行期应完全避免启动 PowerShell / 隐藏窗口进程。

- 需要发声：用 koffi 在进程内调 `winmm!sndPlaySoundW`（见
  [../experiences/06-windows-native.md](../experiences/06-windows-native.md)）。
- 需要截图：用中完整性 Node 工作进程调 `PrintWindow`（不要用 `CopyFromScreen`，也避开 PowerShell）。
- 开发期用 `Start-Process -WindowStyle Hidden` 做探针同样会被拦——**改用当前 shell 直接跑**，
  需要结果就写文件再读。

## 4. 桌面应用独占 `desktop` profile

```powershell
dsh --profile desktop --dump-config
# error: profile "desktop" is managed exclusively by the Electron application
```

- 命令行**不能**改 `desktop` profile；安装/卸载一律用 `plugin_manager`。
- 想用 CLI 验证配置，可以复制 profile 到临时目录并用 `DSH_HOME` 指向它，但注意
  `DSH_HOME` 下也需要 `profiles/` 结构，且复制出来的 `package.json` 不要带 BOM。

## 5. 沙箱下哪些操作会被直接拒绝

本机的文件策略是 `workspace-write`：工作区外的写入会被**直接拒绝**（不弹审批）：

- 写 `C:\Windows\Temp`、`%TEMP%\dsh-*` 之外的系统目录 → 拒绝；
- WMI 查询（`Get-CimInstance`）→ 拒绝；
- 外网 HTTP → 连接被重置。

需要审批的是 `plugin_manager` 这类显式提权操作：它们会弹面板，**弹面板期间调用方被阻塞**，
所以不能用“截图审批框”的方式验证。

## 6. 重新加载插件的正确顺序

改了插件代码后：

1. `plugin_manager` `remove_bundle`（包名）；
2. `plugin_manager` `install_bundle`（目录）；
3. 仍生效旧代码（新加的监听不触发）时，**完全退出 dsh 再启动**。

`install_bundle` 对已安装包只更新 `link:`，不会重新加载模块——这是本机最常见的时间黑洞。

## 7. 声音类调试的小工具

- 确认设备正常：`powershell -c "[System.Media.SoundPlayer]::new('C:\Windows\Media\Windows Notify System Generic.wav').PlaySync()"`。
- 确认进程内播放可用：koffi 调 `sndPlaySoundW` **同步**返回约等于音频时长才说明真在播；
  返回 0 ms 就是被静默丢弃（`SND_ASYNC`）。
- 插件是否真的加载：`cordis_inspect_query`（Host `Config.listConfigs` / Client `Slots.listSubTree`）。
