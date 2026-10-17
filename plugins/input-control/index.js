/**
 * Input control: let the Agent act on what it screenshots.
 *
 * Actions run in a Node worker spawned through `ctx.subprocess.spawn()`, which
 * is NOT wrapped by `ctx.sandbox.confine()`. That is load-bearing: the shell
 * tools run under a confined token demoted to Low integrity, where Win32
 * `SendInput` reports success while UIPI silently drops every event. A
 * plugin-spawned child keeps the Host's Medium integrity, so input lands.
 *
 * The worker talks JSON in and JSON out, so argument types and text encoding
 * never pass through a shell.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'input-control'

export const inject = ['tools']

const here = dirname(fileURLToPath(import.meta.url))
const WORKER = join(here, 'input-worker.cjs')

/** Structured failure surfaced as a readable tool error. */
export class InputError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'InputError'
    this.code = code
  }
}

/**
 * Run one action in the Medium-integrity worker.
 * @param ctx - plugin context supplying the subprocess service.
 * @param request - the action request.
 * @returns the worker's result payload.
 */
export async function runInput(ctx, request) {
  if (process.platform !== 'win32') throw new InputError('NOT_WINDOWS', '键鼠控制仅在 Windows 上可用。')
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) throw new InputError('NO_SUBPROCESS', '当前组合没有 subprocess 服务，无法注入输入。')

  const handle = subprocess.spawn({
    argv: [process.execPath, WORKER, JSON.stringify(request)],
    cwd: here,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 256 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    },
    graceMs: 10_000,
  })
  const outcome = await handle.done
  const stdout = handle.collected.stdout?.readFrom(0).text ?? ''
  const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
  return parseOutput(stdout, stderr, outcome.exitCode)
}

/**
 * Parse the worker's result line.
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @param exitCode - process exit status.
 * @returns the parsed success payload.
 */
export function parseOutput(stdout, stderr, exitCode) {
  const line = String(stdout).trim().split(/\r?\n/u).filter((part) => part.startsWith('{')).at(-1)
  if (line === undefined) {
    const detail = String(stderr).trim()
    throw new InputError(
      'WORKER_FAILED',
      `输入进程没有返回结果（退出码 ${exitCode}）：${detail === '' ? '无输出' : detail.slice(0, 400)}`,
    )
  }
  let payload
  try {
    payload = JSON.parse(line)
  } catch {
    throw new InputError('WORKER_FAILED', `输入进程返回了无法解析的结果：${line.slice(0, 200)}`)
  }
  if (payload.ok !== true) throw new InputError(payload.code ?? 'INPUT_FAILED', payload.message ?? '输入操作失败')
  return payload
}

/** Shared target parameters for every action tool. */
const TARGET_PARAMS = {
  window: {
    type: 'string',
    description: 'Target window: an exact handle from list_windows, or a unique title substring. '
      + 'Required — actions never fall back to whichever window happens to be focused.',
  },
  scope: {
    type: 'string',
    enum: ['window', 'client'],
    description: 'Coordinate space for every x,y in this call: "client" matches a capture_window screenshot '
      + 'taken with scope=client; "window" matches one taken with scope=window (default).',
  },
  allowBackground: {
    type: 'boolean',
    description: 'Default false: the target must be the foreground window, otherwise the call fails rather than '
      + 'typing into a different window. Set true only when you accept sending input to whatever is focused.',
  },
  activate: {
    type: 'boolean',
    description: 'Default false. Set true to raise and focus the target window first. Windows delivers keystrokes '
      + 'only to the foreground window, so type_text/press_keys need this when the target is in the background; '
      + 'if Windows refuses the focus change the call fails rather than typing into another window.',
  },
}

/** Render the shared result text. */
function describe(payload) {
  const cursor = payload.cursorAfter === undefined ? '' : `，光标现在位于 ${payload.cursorAfter.x},${payload.cursorAfter.y}`
  return `已在窗口「${payload.title}」执行 ${payload.op}（${payload.actions} 个动作）${cursor}。建议再截图确认结果。`
}

/**
 * Register the input tools.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  const resultSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      ok: { type: 'boolean' },
      op: { type: 'string' },
      title: { type: 'string' },
      handle: { type: 'integer' },
      actions: { type: 'integer' },
      scope: { type: 'string' },
      cursorAfter: {
        type: 'object',
        additionalProperties: false,
        properties: { x: { type: 'integer' }, y: { type: 'integer' } },
      },
    },
  }

  /** Register one action tool; `build` turns tool args into the worker request. */
  const define = (name, description, parameters, build, concurrencySafe = false) => {
    ctx.effect(() => ctx.tools.register({
      name,
      description,
      parameters: { type: 'object', properties: parameters, additionalProperties: false },
      output: {
        schema: resultSchema,
        render: (_args, value) => [{ type: 'text', text: describe(value) }],
      },
      async execute(args) {
        return runInput(ctx, build(args))
      },
      isConcurrencySafe: () => concurrencySafe,
      presentCall(args) {
        return { card: 'generic', title: `${name}：${args.window ?? ''}`, kind: 'edit' }
      },
    }), `input-control: ${name}`)
  }

  /** Common fields every request carries. */
  const base = (args) => ({
    window: String(args.window ?? ''),
    scope: args.scope === 'client' ? 'client' : 'window',
    ...(args.allowBackground === true ? { allowBackground: true } : {}),
    ...(args.activate === true ? { activate: true } : {}),
  })

  const point = (x, y) => (Number.isInteger(x) && Number.isInteger(y) ? { x, y } : undefined)

  define(
    'click',
    'Click in a desktop window. Give the target window and a point relative to it (x,y), normally taken from '
      + 'a capture_window screenshot of the same scope. Supports left/right/middle and double-click. '
      + 'Screenshot again afterwards to confirm the click had the intended effect.',
    {
      ...TARGET_PARAMS,
      x: { type: 'integer', description: 'X inside the coordinate space named by scope.' },
      y: { type: 'integer', description: 'Y inside the coordinate space named by scope.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default left).' },
      count: { type: 'integer', description: 'Click count, 1–3 (use 2 for double-click). Default 1.' },
    },
    (args) => ({
      op: 'click',
      ...base(args),
      at: point(args.x, args.y),
      button: typeof args.button === 'string' ? args.button : 'left',
      count: Number.isInteger(args.count) ? args.count : 1,
    }),
  )

  define(
    'type_text',
    'Type text into the focused control of a desktop window as real keystrokes (Unicode, so Chinese and '
      + 'symbols work). Click the field first, then type. Screenshot afterwards to verify the text landed.',
    {
      ...TARGET_PARAMS,
      text: { type: 'string', description: 'Exact text to type. Newlines type Enter.' },
      delayMs: { type: 'integer', description: 'Delay between characters in ms (default 12); raise it for slow apps.' },
    },
    (args) => ({
      op: 'type',
      ...base(args),
      text: String(args.text ?? ''),
      ...(Number.isInteger(args.delayMs) ? { delayMs: args.delayMs } : {}),
    }),
  )

  define(
    'press_keys',
    'Press a key combination in a desktop window, such as "ctrl+c", "ctrl+shift+t", "alt+f4", "enter" '
      + 'or "f5". Modifiers and keys are pressed in order and always released.',
    {
      ...TARGET_PARAMS,
      keys: { type: 'string', description: 'Combination joined by "+", e.g. "ctrl+s". Single keys are allowed.' },
    },
    (args) => ({ op: 'key', ...base(args), keys: String(args.keys ?? '') }),
  )

  define(
    'scroll',
    'Scroll a desktop window with the mouse wheel. Positive delta scrolls down, negative scrolls up. '
      + 'Give x,y to move the pointer over the region to scroll first, or omit it to scroll where the pointer is.',
    {
      ...TARGET_PARAMS,
      x: { type: 'integer', description: 'Optional X to hover before scrolling.' },
      y: { type: 'integer', description: 'Optional Y to hover before scrolling.' },
      delta: { type: 'integer', description: 'Wheel ticks; positive = down, negative = up. Must be non-zero.' },
    },
    (args) => ({
      op: 'scroll',
      ...base(args),
      at: point(args.x, args.y),
      delta: Number.isInteger(args.delta) ? args.delta : 0,
    }),
  )

  define(
    'drag',
    'Drag the mouse from one point to another inside a desktop window (press, move in steps, release). '
      + 'Useful for selecting text, moving sliders, or reordering items.',
    {
      ...TARGET_PARAMS,
      fromX: { type: 'integer', description: 'Start X.' },
      fromY: { type: 'integer', description: 'Start Y.' },
      toX: { type: 'integer', description: 'End X.' },
      toY: { type: 'integer', description: 'End Y.' },
      button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Button to hold (default left).' },
    },
    (args) => ({
      op: 'drag',
      ...base(args),
      from: point(args.fromX, args.fromY),
      to: point(args.toX, args.toY),
      button: typeof args.button === 'string' ? args.button : 'left',
    }),
  )

  define(
    'move_mouse',
    'Move the mouse pointer to a point inside a desktop window without clicking. The pointer stays there, '
      + 'which is visible in later screenshots (hover states, tooltips).',
    {
      ...TARGET_PARAMS,
      x: { type: 'integer', description: 'X inside the coordinate space named by scope.' },
      y: { type: 'integer', description: 'Y inside the coordinate space named by scope.' },
    },
    (args) => ({ op: 'move', ...base(args), at: point(args.x, args.y) }),
    true,
  )
}
