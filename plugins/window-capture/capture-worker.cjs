/**
 * Capture worker: screenshot one window or the screen, then exit.
 *
 * Runs as a child of the plugin's `ctx.subprocess.spawn()`, i.e. at the Host's
 * Medium integrity. That is required: under the confined Low-integrity token
 * used by the shell tools, `PrintWindow` fails for every GPU-composited window
 * (Chromium, Electron, games), leaving only a screen BitBlt that needs the
 * window unobstructed. At Medium, `PrintWindow` renders occluded windows.
 *
 * Usage: node capture-worker.cjs '<json request>'
 * Prints one JSON line: { ok: true, path, width, height, title, ... }.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const KOFFI_CANDIDATES = [
  String.raw`C:\Users\fyr\AppData\Local\Programs\DeepSeek Harness\resources\app.asar.unpacked\dsh\node_modules\koffi`,
  'koffi',
]

/** Load koffi from the packaged location or from normal resolution. */
function loadKoffi() {
  const errors = []
  for (const candidate of KOFFI_CANDIDATES) {
    try {
      return require(candidate)
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`)
    }
  }
  throw new Error(`koffi unavailable: ${errors.join(' | ')}`)
}

function main() {
  const raw = process.argv[2] ?? readStdin()
  if (raw === null || raw === undefined || raw.trim() === '') return fail('BAD_ARGS', 'missing request JSON')
  let request
  try {
    request = JSON.parse(raw)
  } catch (error) {
    return fail('BAD_ARGS', `request is not JSON: ${error.message}`)
  }

  let koffi
  try {
    koffi = loadKoffi()
  } catch (error) {
    return fail('NO_KOFFI', error.message)
  }

  const user32 = koffi.load('user32.dll')
  const gdi32 = koffi.load('gdi32.dll')

  const RECT = koffi.struct('CAP_RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' })
  const POINT = koffi.struct('CAP_POINT', { x: 'int', y: 'int' })
  const BITMAPINFOHEADER = koffi.struct('CAP_BIH', {
    biSize: 'uint32', biWidth: 'int32', biHeight: 'int32', biPlanes: 'uint16', biBitCount: 'uint16',
    biCompression: 'uint32', biSizeImage: 'uint32', biXPelsPerMeter: 'int32', biYPelsPerMeter: 'int32',
    biClrUsed: 'uint32', biClrImportant: 'uint32',
  })

  const GetWindowRect = user32.func('GetWindowRect', 'bool', ['void *', koffi.out(koffi.pointer(RECT))])
  const GetClientRect = user32.func('GetClientRect', 'bool', ['void *', koffi.out(koffi.pointer(RECT))])
  const ClientToScreen = user32.func('ClientToScreen', 'bool', ['void *', koffi.inout(koffi.pointer(POINT))])
  const IsWindow = user32.func('IsWindow', 'bool', ['void *'])
  const IsWindowVisible = user32.func('IsWindowVisible', 'bool', ['void *'])
  const IsIconic = user32.func('IsIconic', 'bool', ['void *'])
  const ShowWindow = user32.func('ShowWindow', 'bool', ['void *', 'int'])
  const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['void *', koffi.out(koffi.pointer('uint16')), 'int'])
  const GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', [])
  const GetDC = user32.func('GetDC', 'void *', ['void *'])
  const ReleaseDC = user32.func('ReleaseDC', 'int', ['void *', 'void *'])
  const PrintWindow = user32.func('PrintWindow', 'bool', ['void *', 'void *', 'uint32'])
  const GetWindowThreadProcessId = user32.func('GetWindowThreadProcessId', 'uint32', ['void *', koffi.out(koffi.pointer('uint32'))])

  const CreateCompatibleDC = gdi32.func('CreateCompatibleDC', 'void *', ['void *'])
  const CreateCompatibleBitmap = gdi32.func('CreateCompatibleBitmap', 'void *', ['void *', 'int', 'int'])
  const SelectObject = gdi32.func('SelectObject', 'void *', ['void *', 'void *'])
  const DeleteObject = gdi32.func('DeleteObject', 'bool', ['void *'])
  const DeleteDC = gdi32.func('DeleteDC', 'bool', ['void *'])
  const BitBlt = gdi32.func('BitBlt', 'bool', ['void *', 'int', 'int', 'int', 'int', 'void *', 'int', 'int', 'uint32'])
  const GetDIBits = gdi32.func('GetDIBits', 'int', [
    'void *', 'void *', 'uint32', 'uint32', 'void *', koffi.inout(koffi.pointer(BITMAPINFOHEADER)), 'uint32',
  ])

  const SW_RESTORE = 9
  const SRCCOPY = 0x00CC0020
  const GWL_EXSTYLE = -20
  const WS_EX_TOOLWINDOW = 0x00000080
  const WS_EX_LAYERED = 0x00080000

  // --- listing --------------------------------------------------------------
  /** Cached pid → image-name map; declared before its first use (TDZ). */
  let processMapCache

  if (request.action === 'list') {
    const windows = listWindows().map((w) => ({
      handle: w.handle,
      title: w.title,
      process: w.process,
      pid: w.pid,
      width: w.width,
      height: w.height,
    }))
    windows.sort((a, b) => a.title.localeCompare(b.title))
    process.stdout.write(JSON.stringify({ ok: true, count: windows.length, windows }) + '\n')
    return 0
  }

  // --- target resolution ----------------------------------------------------
  let handle = 0
  let mode = request.mode ?? 'window'
  if (mode === 'screen') {
    handle = 0
  } else {
    const resolved = resolveWindow(request.window)
    if (resolved === null) return fail('NO_WINDOW', `找不到窗口 "${request.window}"；先用 list_windows 查看可用窗口`)
    handle = resolved
  }

  // Win32 receives HWND as a pointer; a bare JS number is rejected by koffi, so
  // convert once and pass the pointer everywhere below.
  const hwnd = handle === 0 ? 0 : koffi.as(handle, 'void *')
  const title = handle === 0 ? '(screen)' : windowTitle(hwnd)
  if (handle !== 0 && IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)

  // --- target geometry ------------------------------------------------------
  let target
  if (handle === 0) {
    // Whole virtual screen.
    const bounds = screenBounds()
    target = { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }
  } else if (request.scope === 'client') {
    const client = {}
    const origin = { x: 0, y: 0 }
    if (!GetClientRect(hwnd, client) || !ClientToScreen(hwnd, origin)) {
      return fail('NO_WINDOW', '无法读取窗口客户区尺寸')
    }
    target = { x: origin.x, y: origin.y, width: client.right - client.left, height: client.bottom - client.top }
  } else {
    const rect = {}
    if (!GetWindowRect(hwnd, rect)) return fail('NO_WINDOW', '无法读取窗口尺寸')
    target = { x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }
  }
  if (target.width <= 0 || target.height <= 0) return fail('CAPTURE_FAILED', '窗口尺寸为 0，可能已最小化或不可见')

  // --- render ---------------------------------------------------------------
  const screenDc = GetDC(0)
  if (!screenDc) return fail('CAPTURE_FAILED', '无法获取屏幕 DC')
  const memDc = CreateCompatibleDC(screenDc)
  const bitmap = CreateCompatibleBitmap(screenDc, target.width, target.height)
  if (!memDc || !bitmap) {
    ReleaseDC(0, screenDc)
    return fail('CAPTURE_FAILED', '无法创建兼容位图')
  }
  const previous = SelectObject(memDc, bitmap)

  let method = null
  try {
    if (handle !== 0) {
      // PW_RENDERFULLCONTENT first: it renders occluded DWM-composited windows.
      for (const flags of [2, 0, 3, 1]) {
        if (PrintWindow(hwnd, memDc, flags) && !isBlank(memDc, bitmap, target.width, target.height)) {
          method = `printwindow+${flags}`
          break
        }
      }
    }
    if (method === null) {
      // Screen copy: works for anything currently visible, needs the window
      // unobstructed when it belongs to a GPU surface.
      if (!BitBlt(memDc, 0, 0, target.width, target.height, screenDc, target.x, target.y, SRCCOPY)) {
        return fail('CAPTURE_FAILED', 'PrintWindow 与屏幕拷贝均失败')
      }
      if (isBlank(memDc, bitmap, target.width, target.height)) {
        return fail('BLANK_CAPTURE',
          `窗口「${title}」渲染结果为空白。它可能被完全遮挡或使用 GPU 合成，前台化后重试可以解决。`)
      }
      method = 'bitblt'
    }

    // --- read pixels and encode PNG ----------------------------------------
    const bih = {
      biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: target.width, biHeight: -target.height,
      biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0,
      biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    }
    const bgra = Buffer.alloc(target.width * target.height * 4)
    const lines = GetDIBits(memDc, bitmap, 0, target.height, koffi.as(bgra, 'void *'), bih, 0)
    if (lines !== target.height) return fail('CAPTURE_FAILED', `读取像素失败（得到 ${lines}/${target.height} 行）`)

    // Client-area capture from a screen copy must be cropped out of the frame.
    const pngBuffer = encodePng(bgra, target.width, target.height)
    const outPath = request.output ?? path.join(os.tmpdir(), `dsh-capture-${process.pid}.png`)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, pngBuffer)

    let pid = 0
    if (handle !== 0) {
      const pidBuf = new Uint32Array(1)
      GetWindowThreadProcessId(hwnd, pidBuf)
      pid = pidBuf[0]
    }

    process.stdout.write(JSON.stringify({
      ok: true,
      path: outPath,
      width: target.width,
      height: target.height,
      title,
      handle,
      pid,
      scope: mode === 'screen' ? 'screen' : (request.scope === 'client' ? 'client' : 'window'),
      method,
      bytes: pngBuffer.length,
    }) + '\n')
    return 0
  } finally {
    SelectObject(memDc, previous)
    DeleteObject(bitmap)
    DeleteDC(memDc)
    ReleaseDC(0, screenDc)
  }

  function screenBounds() {
    // SystemMetrics: SM_XVIRTUALSCREEN 76, SM_YVIRTUALSCREEN 77,
    // SM_CXVIRTUALSCREEN 78, SM_CYVIRTUALSCREEN 79.
    const GetSystemMetrics = user32.func('GetSystemMetrics', 'int', ['int'])
    return {
      left: GetSystemMetrics(76), top: GetSystemMetrics(77),
      right: GetSystemMetrics(76) + GetSystemMetrics(78),
      bottom: GetSystemMetrics(77) + GetSystemMetrics(79),
    }
  }

  /** A render that produced only black pixels is treated as a failed render. */
  function isBlank(dc, bmp, w, h) {
    const bih = {
      biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32,
      biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0,
    }
    const probe = Buffer.alloc(w * h * 4)
    if (GetDIBits(dc, bmp, 0, h, koffi.as(probe, 'void *'), bih, 0) !== h) return true
    const stepX = Math.max(1, Math.floor(w / 24))
    const stepY = Math.max(1, Math.floor(h / 24))
    let sum = 0
    let sumSq = 0
    let n = 0
    for (let y = 0; y < h; y += stepY) {
      for (let x = 0; x < w; x += stepX) {
        const i = (y * w + x) * 4
        const luma = (probe[i] * 299 + probe[i + 1] * 587 + probe[i + 2] * 114) / 1000
        sum += luma
        sumSq += luma * luma
        n += 1
      }
    }
    if (n === 0) return true
    const mean = sum / n
    const variance = sumSq / n - mean * mean
    // Flat and near-black means nothing was drawn.
    return variance < 1 && mean < 6
  }

  function resolveWindow(targetRef) {
    const text = String(targetRef ?? '').trim()
    if (text === '') return null
    if (/^(0x[0-9a-f]+|\d+)$/i.test(text)) {
      const value = text.toLowerCase().startsWith('0x') ? Number.parseInt(text.slice(2), 16) : Number(text)
      if (!Number.isSafeInteger(value) || value <= 0) return null
      return IsWindow(koffi.as(value, 'void *')) ? value : null
    }
    return findWindowByTitle(text)
  }

  function findWindowByTitle(needle) {
    const lower = needle.toLowerCase()
    const candidates = listWindows().filter((w) =>
      w.title.toLowerCase().includes(lower) || w.process.toLowerCase().includes(lower))
    if (candidates.length === 0) return null
    if (candidates.length > 1) {
      const list = candidates.map((c) => `[${c.handle}] ${c.title} (${c.process})`).join(' ; ')
      throw Object.assign(new Error(`有多个窗口匹配 "${needle}"，请用句柄精确指定：${list}`), { code: 'AMBIGUOUS' })
    }
    return candidates[0].handle
  }

  function listWindows() {
    // Enumerate through UI Automation. EnumWindows with a koffi callback is not
    // an option: a mismatched native callback signature crashes the process
    // outright (0xC0000005).
    //
    // The PowerShell child is only spawnable when this worker runs at a
    // permissive integrity. Under the confined shell token the spawn is denied
    // (EPERM) and listing degrades to an empty result; the plugin always runs
    // this worker through `ctx.subprocess`, where it succeeds.
    const windows = []
    let scriptPath
    try {
      const { execFileSync } = require('node:child_process')
      // A temp script file avoids every quoting layer of -Command.
      scriptPath = path.join(os.tmpdir(), `dsh-list-windows-${process.pid}.ps1`)
      fs.writeFileSync(scriptPath, [
        '\ufeff$ErrorActionPreference = "Stop"',
        'try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }',
        'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes',
        '$root = [System.Windows.Automation.AutomationElement]::RootElement',
        '$all = $root.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)',
        '$out = @()',
        'foreach ($e in $all) {',
        '  try {',
        '    if ([string]::IsNullOrWhiteSpace($e.Current.Name)) { continue }',
        '    $r = $e.Current.BoundingRectangle',
        '    $out += [pscustomobject]@{ hwnd = [int64]$e.Current.NativeWindowHandle; name = $e.Current.Name; w = [int]$r.Width; ht = [int]$r.Height }',
        '  } catch { }',
        '}',
        'ConvertTo-Json -InputObject @($out) -Compress -Depth 4',
      ].join('\n'), 'utf8')

      const raw = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20000 })
      const parsed = JSON.parse(raw)
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        const handle = Number(item?.hwnd)
        if (!Number.isSafeInteger(handle) || handle <= 0) continue
        // Win32 takes HWND as a pointer: a bare number is rejected by koffi.
        const hwndPtr = koffi.as(handle, 'void *')
        if (!IsWindow(hwndPtr) || !IsWindowVisible(hwndPtr)) continue
        const width = Number(item.w) || 0
        const height = Number(item.ht) || 0
        if (width <= 0 || height <= 0) continue
        const pidBuf = new Uint32Array(1)
        GetWindowThreadProcessId(hwndPtr, pidBuf)
        windows.push({
          handle,
          title: String(item.name ?? ''),
          pid: pidBuf[0],
          process: processName(pidBuf[0]),
          width,
          height,
        })
      }
    } catch (error) {
      // Never hide enumerations failures: an empty list would read as "no windows".
      throw new Error(`window enumeration failed: ${error.message}`)
    } finally {
      if (scriptPath !== undefined) { try { fs.unlinkSync(scriptPath) } catch { } }
    }
    return windows
  }

  /** Map pid to image name once per run; tasklist is far too slow per window. */
  function processMap() {
    if (processMapCache !== undefined) return processMapCache
    processMapCache = new Map()
    try {
      const { execFileSync } = require('node:child_process')
      const out = execFileSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      for (const line of out.split(/\r?\n/u)) {
        const match = /^"([^"]+)","(\d+)"/.exec(line.trim())
        if (match !== null) processMapCache.set(Number(match[2]), match[1].replace(/\.exe$/i, ''))
      }
    } catch { /* names stay empty */ }
    return processMapCache
  }

  function processName(pid) {
    return processMap().get(pid) ?? ''
  }

  function windowTitle(h) {
    const buf = Buffer.alloc(1024)
    const len = GetWindowTextW(h, buf, 512)
    return buf.subarray(0, len * 2).toString('utf16le')
  }

  function fail(code, message) {
    process.stdout.write(JSON.stringify({ ok: false, code, message }) + '\n')
    return 0
  }
}

/**
 * Encode a top-down BGRA buffer as a PNG without external dependencies.
 * Uses stored (uncompressed) deflate blocks: capture PNGs are transient and
 * the Harness re-encodes them on attachment admission anyway.
 * @param bgra - width*height*4 bytes, BGRA order.
 * @param width - image width.
 * @param height - image height.
 * @returns PNG file bytes.
 */
function encodePng(bgra, width, height) {
  const zlib = require('node:zlib')

  // PNG scanlines: filter byte 0 then RGB triples.
  const stride = width * 3 + 1
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * stride
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4
      const dst = rowStart + 1 + x * 3
      raw[dst] = bgra[src + 2]
      raw[dst + 1] = bgra[src + 1]
      raw[dst + 2] = bgra[src]
    }
  }
  const idat = zlib.deflateSync(raw, { level: 6 })

  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body) >>> 0)
    return Buffer.concat([len, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** CRC-32 as required by PNG chunks. */
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return c ^ 0xffffffff
}

/** Read the whole of stdin, or undefined when it is a terminal/empty. */
function readStdin() {
  try {
    if (process.stdin.isTTY) return undefined
    const fs = require('node:fs')
    const chunks = []
    const buf = Buffer.alloc(65536)
    for (;;) {
      let n
      try {
        n = fs.readSync(0, buf, 0, buf.length, null)
      } catch (error) {
        if (error.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue }
        if (error.code === 'EOF') break
        throw error
      }
      if (n === 0) break
      chunks.push(Buffer.from(buf.subarray(0, n)))
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

main()
