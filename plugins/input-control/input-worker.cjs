/**
 * Input worker: performs one Win32 input action, then exits.
 *
 * Runs as a child of the plugin's `ctx.subprocess.spawn()`, i.e. at the Host's
 * Medium integrity. That matters: the shell tools run under a confined token
 * demoted to Low integrity, where `SendInput`/`SetCursorPos` are silently
 * dropped by UIPI. Medium integrity injects normally.
 *
 * Usage: node input-worker.cjs '<json request>'
 * Prints one JSON line: { ok: true, ... } or { ok: false, code, message }.
 */
'use strict'

const KOFFI_CANDIDATES = [
  // Packaged Harness: native modules live outside the asar archive.
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
  // The request arrives as argv[2] (normal path) or on stdin (when a shell
  // would mangle quoting).
  const raw = process.argv[2] ?? readStdin()
  if (raw === null || raw === undefined || raw.trim() === '') return fail('BAD_ARGS', 'missing request JSON')
  let request
  try {
    request = JSON.parse(raw)
  } catch (error) {
    return fail('BAD_ARGS', `request is not JSON: ${error.message}`)
  }

  const koffi = loadKoffi()
  const user32 = koffi.load('user32.dll')

  // --- declarations ---------------------------------------------------------
  const POINT = koffi.struct('POINT_I', { x: 'int', y: 'int' })
  const RECT = koffi.struct('RECT_I', { left: 'int', top: 'int', right: 'int', bottom: 'int' })

  // INPUT { UINT type; union { MOUSEINPUT mi; KEYBDINPUT ki; } u; }
  const MOUSEINPUT = koffi.struct('MOUSEINPUT_I', {
    dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  })
  const KEYBDINPUT = koffi.struct('KEYBDINPUT_I', {
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
  })
  const INPUT_UNION = koffi.union('INPUT_UNION_I', { mi: MOUSEINPUT, ki: KEYBDINPUT })
  const INPUT = koffi.struct('INPUT_I', { type: 'uint32', u: INPUT_UNION })

  const GetCursorPos = user32.func('GetCursorPos', 'bool', [koffi.out(koffi.pointer(POINT))])
  const SetCursorPos = user32.func('SetCursorPos', 'bool', ['int', 'int'])
  const GetForegroundWindow = user32.func('GetForegroundWindow', 'void *', [])
  const IsWindow = user32.func('IsWindow', 'bool', ['void *'])
  const GetWindowRect = user32.func('GetWindowRect', 'bool', ['void *', koffi.out(koffi.pointer(RECT))])
  const GetClientRect = user32.func('GetClientRect', 'bool', ['void *', koffi.out(koffi.pointer(RECT))])
  const ClientToScreen = user32.func('ClientToScreen', 'bool', ['void *', koffi.inout(koffi.pointer(POINT))])
  const IsIconic = user32.func('IsIconic', 'bool', ['void *'])
  const ShowWindow = user32.func('ShowWindow', 'bool', ['void *', 'int'])
  const SetForegroundWindow = user32.func('SetForegroundWindow', 'bool', ['void *'])
  const BringWindowToTop = user32.func('BringWindowToTop', 'bool', ['void *'])
  const GetWindowTextW = user32.func('GetWindowTextW', 'int', ['void *', 'uint16 *', 'int'])
  const MapVirtualKeyW = user32.func('MapVirtualKeyW', 'uint32', ['uint32', 'uint32'])
  const SendInput = user32.func('SendInput', 'uint32', ['uint32', koffi.pointer(INPUT), 'int'])

  const INPUT_TYPE_MOUSE = 0
  const INPUT_TYPE_KEYBOARD = 1
  const MOUSEEVENTF_MOVE = 0x0001
  const LEFT_DOWN = 0x0002, LEFT_UP = 0x0004
  const RIGHT_DOWN = 0x0008, RIGHT_UP = 0x0010
  const MIDDLE_DOWN = 0x0020, MIDDLE_UP = 0x0040
  const MOUSEEVENTF_WHEEL = 0x0800
  const KEYEVENTF_KEYUP = 0x0002
  const KEYEVENTF_UNICODE = 0x0004
  const SW_RESTORE = 9
  const INPUT_SIZE = koffi.sizeof(INPUT)

  /** Sleep without a busy loop; this worker is synchronous by design. */
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

  // --- window resolution ----------------------------------------------------
  const handle = resolveWindow(request.window)
  if (handle === null) return fail('NO_WINDOW', `找不到窗口 "${request.window}"；先用 list_windows 查看可用窗口`)

  const title = windowTitle(handle)
  if (IsIconic(handle)) ShowWindow(handle, SW_RESTORE)

  // Refuse to type into a different window than the caller named.
  const foreground = GetForegroundWindow()
  const focusedNow = Number(foreground) === Number(handle)
  if (!focusedNow) {
    if (request.activate === true) {
      // SendInput targets the FOREGROUND window, so keyboard input cannot be
      // aimed at a background window — it must be raised first.
      if (IsIconic(handle)) ShowWindow(handle, SW_RESTORE)
      BringWindowToTop(handle)
      SetForegroundWindow(handle)
      sleep(180)
      if (Number(GetForegroundWindow()) !== Number(handle)) {
        return fail('NOT_FOREGROUND',
          `无法把「${title}」激活到前台（Windows 会拒绝后台进程抢焦点）。请手动点一下该窗口，或改用 move/scroll 这类不依赖焦点的操作。`)
      }
    } else if (request.allowBackground !== true) {
      return fail('NOT_FOREGROUND',
        `目标窗口「${title}」不在前台，键盘输入会落到当前前台窗口。传 activate=true 让我先激活它，`
        + `或传 allowBackground=true 明确接受输入可能发到别处。`)
    }
    // With allowBackground and no activate, the caller accepted that input may
    // reach whatever is focused; only pointer moves below are target-relative.
  }

  // --- coordinate mapping ---------------------------------------------------
  const clientOrigin = () => {
    const origin = { x: 0, y: 0 }
    ClientToScreen(handle, origin)
    return origin
  }

  /**
   * Map a caller point in the named scope onto screen coordinates.
   * @param point - {x,y} or undefined.
   * @returns screen {x,y} or undefined.
   */
  const toScreen = (point) => {
    if (point === undefined || point === null) return undefined
    if (request.scope === 'client') {
      const origin = clientOrigin()
      return { x: origin.x + point.x, y: origin.y + point.y }
    }
    const rect = {}
    GetWindowRect(handle, rect)
    return { x: rect.left + point.x, y: rect.top + point.y }
  }

  const sendMouse = (flags, data = 0) => {
    // A koffi union value must name exactly one member.
    const inputs = [{
      type: INPUT_TYPE_MOUSE,
      u: { mi: { dx: 0, dy: 0, mouseData: data >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }]
    return SendInput(1, inputs, INPUT_SIZE)
  }

  const buttonFlags = (button) => {
    if (button === 'right') return { down: RIGHT_DOWN, up: RIGHT_UP }
    if (button === 'middle') return { down: MIDDLE_DOWN, up: MIDDLE_UP }
    return { down: LEFT_DOWN, up: LEFT_UP }
  }

  const charInput = (ch, up) => ({
    type: INPUT_TYPE_KEYBOARD,
    u: {
      ki: {
        wVk: 0,
        wScan: ch.charCodeAt(0),
        dwFlags: up ? (KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) : KEYEVENTF_UNICODE,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  })

  const vkInput = (vk, up) => ({
    type: INPUT_TYPE_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: Number(MapVirtualKeyW(vk, 0)),
        dwFlags: up ? KEYEVENTF_KEYUP : 0,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  })

  // --- actions --------------------------------------------------------------
  let actions = 0
  const before = {}
  GetCursorPos(before)

  try {
    switch (request.op) {
      case 'move': {
        const p = toScreen(request.at)
        if (p === undefined) return fail('BAD_ARGS', 'move 需要 at {x,y}')
        if (!SetCursorPos(p.x, p.y)) return fail('INJECT_FAILED', 'SetCursorPos 被系统拒绝（权限不足或非交互桌面）')
        actions = 1
        break
      }
      case 'click': {
        const p = toScreen(request.at)
        if (p !== undefined) { SetCursorPos(p.x, p.y); sleep(40) }
        const { down, up } = buttonFlags(request.button)
        const count = Math.min(3, Math.max(1, request.count ?? 1))
        for (let i = 0; i < count; i += 1) {
          const accepted = sendMouse(down) + sendMouse(up)
          if (accepted === 0) return fail('INJECT_FAILED', 'SendInput 未接受任何鼠标事件（被 UIPI 拦截？）')
          if (i < count - 1) sleep(60)
          actions += 1
        }
        break
      }
      case 'scroll': {
        const delta = Number(request.delta ?? 0)
        if (delta === 0) return fail('BAD_ARGS', 'scroll 需要非零 delta')
        const p = toScreen(request.at)
        if (p !== undefined) { SetCursorPos(p.x, p.y); sleep(40) }
        if (sendMouse(MOUSEEVENTF_WHEEL, delta * 120) === 0) return fail('INJECT_FAILED', 'SendInput 未接受滚轮事件')
        actions = 1
        break
      }
      case 'drag': {
        const from = toScreen(request.from)
        const to = toScreen(request.to)
        if (from === undefined || to === undefined) return fail('BAD_ARGS', 'drag 需要 from 与 to 坐标')
        const { down, up } = buttonFlags(request.button)
        SetCursorPos(from.x, from.y)
        sleep(60)
        sendMouse(down)
        const steps = 12
        for (let i = 1; i <= steps; i += 1) {
          SetCursorPos(Math.round(from.x + ((to.x - from.x) * i) / steps), Math.round(from.y + ((to.y - from.y) * i) / steps))
          sleep(16)
        }
        sleep(60)
        sendMouse(up)
        actions = 1
        break
      }
      case 'type': {
        const text = String(request.text ?? '')
        if (text.length === 0) return fail('BAD_ARGS', 'type 需要非空 text')
        const delay = Math.max(0, Number(request.delayMs ?? 12))
        for (const ch of text) {
          // Newlines arrive as Enter so multi-line input works.
          if (ch === '\n') {
            SendInput(2, [vkInput(0x0D, false), vkInput(0x0D, true)], INPUT_SIZE)
          } else {
            const accepted = SendInput(2, [charInput(ch, false), charInput(ch, true)], INPUT_SIZE)
            if (accepted === 0) return fail('INJECT_FAILED', `SendInput 拒绝了字符 ${JSON.stringify(ch)}`)
          }
          if (delay > 0) sleep(delay)
          actions += 1
        }
        break
      }
      case 'key': {
        const vks = parseKeys(String(request.keys ?? ''))
        if (vks === null) return fail('BAD_ARGS', `无法识别的按键组合："${request.keys}"`)
        if (vks.length === 0) return fail('BAD_ARGS', 'keys 为空')
        // Press in order, always release in reverse even if a press fails.
        try {
          for (const vk of vks) { SendInput(1, [vkInput(vk, false)], INPUT_SIZE); sleep(15) }
        } finally {
          for (let i = vks.length - 1; i >= 0; i -= 1) { SendInput(1, [vkInput(vks[i], true)], INPUT_SIZE); sleep(15) }
        }
        actions = 1
        break
      }
      default:
        return fail('BAD_ARGS', `未知操作：${request.op}`)
    }
  } catch (error) {
    return fail('INJECT_FAILED', `注入失败：${error.message}`)
  }

  const after = {}
  GetCursorPos(after)
  process.stdout.write(JSON.stringify({
    ok: true,
    op: request.op,
    title,
    handle,
    actions,
    scope: request.scope ?? 'window',
    cursorAfter: after,
  }) + '\n')

  function resolveWindow(target) {
    const text = String(target ?? '').trim()
    if (text === '') return null
    if (/^(0x[0-9a-f]+|\d+)$/i.test(text)) {
      const value = text.toLowerCase().startsWith('0x') ? Number.parseInt(text.slice(2), 16) : Number(text)
      // A 0 handle is "no window"; anything else must be a live top-level window.
      if (!Number.isSafeInteger(value) || value <= 0) return null
      return IsWindow(value) ? value : null
    }
    return findWindowByTitle(text)
  }

  function findWindowByTitle(needle) {
    const lower = needle.toLowerCase()
    const candidates = []
    // Enumerate through the UI Automation tree: readable even for windows whose
    // process id we cannot introspect.
    try {
      const shell = require('node:child_process')
      const script = `Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes;` +
        `[System.Windows.Automation.AutomationElement]::RootElement.FindAll(` +
        `[System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)` +
        ` | ForEach-Object { try { [pscustomobject]@{ h=[int64]$_.Current.NativeWindowHandle; t=$_.Current.Name } } catch {} }` +
        ` | ConvertTo-Json -Compress`
      const out = shell.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' })
      const parsed = JSON.parse(out)
      const items = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of items) {
        if (typeof item?.t === 'string' && item.t.toLowerCase().includes(lower) && item.h > 0) {
          candidates.push({ handle: item.h, title: item.t })
        }
      }
    } catch { /* fall through */ }

    if (candidates.length === 0) return null
    if (candidates.length > 1) {
      const list = candidates.map((c) => `[${c.handle}] ${c.title}`).join(' ; ')
      throw Object.assign(new Error(`有多个窗口匹配 "${needle}"，请用句柄精确指定：${list}`), { code: 'AMBIGUOUS' })
    }
    return candidates[0].handle
  }

  function windowTitle(h) {
    const buf = Buffer.alloc(1024)
    const len = GetWindowTextW(h, buf, 512)
    return buf.subarray(0, len * 2).toString('utf16le')
  }

  function parseKeys(spec) {
    const map = {
      ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B,
      enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B,
      space: 0x20, backspace: 0x08, delete: 0x2E, del: 0x2E,
      home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
      up: 0x26, down: 0x28, left: 0x25, right: 0x27,
    }
    const vks = []
    for (const raw of spec.toLowerCase().split('+')) {
      const key = raw.trim()
      if (key === '') continue
      if (map[key] !== undefined) { vks.push(map[key]); continue }
      if (key.length === 1) { vks.push(key.toUpperCase().charCodeAt(0)); continue }
      const fn = /^f([1-9]|1[0-2])$/.exec(key)
      if (fn !== null) { vks.push(0x70 + Number(fn[1]) - 1); continue }
      return null
    }
    return vks
  }
}

/** Emit a structured failure and exit successfully so the caller parses it. */
function fail(code, message) {
  process.stdout.write(JSON.stringify({ ok: false, code, message }) + '\n')
  return 0
}

/** Read the whole of stdin, or undefined when it is a terminal/empty. */
function readStdin() {
  try {
    if (process.stdin.isTTY) return undefined
    const chunks = []
    const fd = 0
    const buf = Buffer.alloc(65536)
    const fs = require('node:fs')
    for (;;) {
      let read
      try {
        read = fs.readSync(fd, buf, 0, buf.length, null)
      } catch (error) {
        if (error.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue }
        if (error.code === 'EOF') break
        throw error
      }
      if (read === 0) break
      chunks.push(Buffer.from(buf.subarray(0, read)))
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    return text === '' ? undefined : text
  } catch {
    return undefined
  }
}

main()
