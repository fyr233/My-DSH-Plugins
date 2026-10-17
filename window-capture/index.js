/**
 * Window capture: screenshot a desktop window or the screen and hand it to the
 * Agent as an image attachment.
 *
 * Capture runs in a Node worker spawned through `ctx.subprocess.spawn()`, i.e.
 * at the Host's Medium integrity. That is load-bearing: the shell tools run
 * under a confined token demoted to Low integrity, where `PrintWindow` fails
 * for every GPU-composited window (Chromium, Electron, games) and only a screen
 * copy remains — which returns whatever is actually on top of that region.
 * At Medium, `PrintWindow` renders the window even when it is occluded.
 *
 * The worker emits one JSON line; PNG bytes are read back from the path it
 * reports, so image data never crosses stdout.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'window-capture'

export const inject = ['tools', 'attachments']

const here = dirname(fileURLToPath(import.meta.url))
const WORKER = join(here, 'capture-worker.cjs')

/** Structured failure surfaced as a readable tool error. */
export class CaptureError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

/**
 * Run the capture worker and parse its result line.
 * @param ctx - plugin context supplying the subprocess service.
 * @param request - the capture request.
 * @returns the worker's success payload.
 */
export async function runCapture(ctx, request) {
  if (process.platform !== 'win32') throw new CaptureError('NOT_WINDOWS', '窗口截图仅在 Windows 上可用。')
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new CaptureError('NO_SUBPROCESS', '当前组合没有 subprocess 服务，无法截图。')

  const handle = subprocess.spawn({
    argv: [process.execPath, WORKER, JSON.stringify(request)],
    cwd: here,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 256 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 20_000,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return parseOutput(stdout, stderr, outcome.exitCode)
}

/**
 * Parse the worker's result line, mapping failures onto {@link CaptureError}.
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @param exitCode - process exit status.
 * @returns the parsed success payload.
 */
export function parseOutput(stdout, stderr, exitCode) {
  const line = String(stdout).trim().split(/\r?\n/u).filter((part) => part.startsWith('{')).at(-1)
  if (line === undefined) {
    const detail = String(stderr).trim()
    throw new CaptureError(
      'WORKER_FAILED',
      `截图进程没有返回结果（退出码 ${exitCode}）：${detail === '' ? '无输出' : detail.slice(0, 400)}`,
    )
  }
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    throw new CaptureError('WORKER_FAILED', `截图进程返回了无法解析的结果：${line.slice(0, 200)}`)
  }
  if (payload.ok !== true) throw new CaptureError(payload.code ?? 'CAPTURE_FAILED', payload.message ?? '截图失败')
  return payload
}

/** Render one window row for lists and hints. */
export function describeWindow(window) {
  return `[${window.handle}] ${window.title} (${window.process || 'unknown'}, pid ${window.pid}) ${window.width}x${window.height}`
}

/** How a capture was rendered, in words the model can act on. */
function methodText(method) {
  return String(method ?? '').startsWith('printwindow') ? '后台渲染，未置顶' : '屏幕拷贝'
}

/**
 * Register the capture tools.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.effect(() => ctx.tools.register({
    name: 'list_windows',
    description: 'List visible desktop windows (handle, title, process, position and size). '
      + 'Use this before capture_window when you do not know the exact window title, '
      + 'or when a capture reported multiple matches.',
    parameters: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          description: 'Optional case-insensitive substring; matches the window title or process name.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'integer' },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                handle: { type: 'integer' },
                title: { type: 'string' },
                process: { type: 'string' },
                pid: { type: 'integer' },
                width: { type: 'integer' },
                height: { type: 'integer' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const rows = (value.windows ?? []).map((window) => describeWindow(window))
        return [{
          type: 'text',
          text: rows.length === 0 ? '没有匹配的可见窗口。' : [`共 ${rows.length} 个可见窗口：`, ...rows].join('\n'),
        }]
      },
    },
    async execute(args) {
      const payload = await runCapture(ctx, { action: 'list' })
      let windows = Array.isArray(payload.windows) ? payload.windows : []
      if (typeof args.filter === 'string' && args.filter.trim() !== '') {
        const needle = args.filter.trim().toLowerCase()
        windows = windows.filter((window) =>
          window.title.toLowerCase().includes(needle) || window.process.toLowerCase().includes(needle))
      }
      return { count: windows.length, windows }
    },
  }), 'window-capture: list_windows')

  ctx.effect(() => ctx.tools.register({
    name: 'capture_window',
    description: 'Capture one desktop window as a PNG and return it as an image you can see directly. '
      + 'Identify the window by its exact handle (from list_windows) or by a title substring. '
      + 'Captures in the background by default: the window is not raised, focused or resized, '
      + 'so it works while the user keeps working in another window — including windows that are '
      + 'partly covered. Scope "window" includes the frame and title bar; "client" keeps only the '
      + 'content area and matches the coordinates input-control tools expect. '
      + 'Use mode "screen" to capture the whole desktop instead.',
    parameters: {
      type: 'object',
      properties: {
        handle: {
          type: 'integer',
          description: 'Exact window handle from list_windows. Takes precedence over title.',
        },
        title: {
          type: 'string',
          description: 'Case-insensitive substring of the window title or process name. '
            + 'Must match exactly one window; use list_windows to disambiguate.',
        },
        scope: {
          type: 'string',
          enum: ['window', 'client'],
          description: 'Capture area: the whole window with frame (default), or just the content area.',
        },
        mode: {
          type: 'string',
          enum: ['window', 'screen'],
          description: 'Capture a single window (default) or the whole desktop.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          pid: { type: 'integer' },
          handle: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          scope: { type: 'string' },
          method: { type: 'string' },
          attachment: {
            type: 'object',
            description: 'Durable image reference the tool result carries to the model.',
            additionalProperties: false,
            properties: {
              attachmentId: { type: 'string' },
              mediaType: { type: 'string' },
              bytes: { type: 'integer' },
              width: { type: 'integer' },
              height: { type: 'integer' },
              name: { type: 'string' },
              originalDimensions: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已截取窗口「${value.title}」，${value.width}x${value.height}，范围 ${value.scope}（${methodText(value.method)}）。`,
      }],
    },
    async execute(args) {
      const mode = args.mode === 'screen' ? 'screen' : 'window'
      const handle = typeof args.handle === 'number' ? args.handle : undefined
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      if (mode === 'window' && handle === undefined && title === '') {
        throw new CaptureError('NO_TARGET', '需要 handle 或 title 之一来指定窗口；先用 list_windows 查看可用窗口。')
      }

      const output = join(tmpdir(), `dsh-window-capture-${randomUUID()}.png`)
      try {
        const payload = await runCapture(ctx, {
          action: 'capture',
          ...(mode === 'screen' ? { mode: 'screen' } : { window: handle !== undefined ? String(handle) : title }),
          scope: args.scope === 'client' ? 'client' : 'window',
          output,
        })
        const data = await readFile(output)
        if (data.length === 0) throw new CaptureError('CAPTURE_FAILED', '截图返回了空图片。')
        const attachment = await ctx.attachments.saveImage({
          data,
          mediaType: 'image/png',
          name: `window-${payload.pid || 'screen'}.png`,
        })
        return {
          title: payload.title ?? '',
          pid: payload.pid ?? 0,
          handle: payload.handle ?? 0,
          width: payload.width ?? attachment.width,
          height: payload.height ?? attachment.height,
          scope: payload.scope ?? 'window',
          method: payload.method ?? 'unknown',
          attachment,
        }
      } finally {
        await rm(output, { force: true }).catch(() => {})
      }
    },
    // The model must see the pixels in the same round, not after a round-trip.
    finalizeContent(_exec, result) {
      if (result.isError === true) return undefined
      const value = result.value
      if (value === undefined || value === null || typeof value !== 'object') return undefined
      const attachment = value.attachment
      if (attachment === undefined) return undefined
      return [
        {
          type: 'text',
          text: `已截取窗口「${value.title}」，${value.width}x${value.height}，范围 ${value.scope}（${methodText(value.method)}）。图像如下。`,
        },
        { type: 'image', attachment },
      ]
    },
    presentCall(args) {
      const label = typeof args.handle === 'number' ? `#${args.handle}` : String(args.title ?? args.mode ?? '')
      return { card: 'generic', title: `截取窗口：${label}`, kind: 'read' }
    },
    // One capture at a time keeps GPU surfaces from racing.
    isConcurrencySafe: () => false,
  }), 'window-capture: capture_window')
}
