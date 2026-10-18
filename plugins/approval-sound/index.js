/**
 * Approval alert sound: play a cue whenever dsh asks the user for approval, so
 * a prompt that appears while the app is in the background is noticed.
 *
 * How the cue is produced, and why it is not simpler:
 *
 * - dsh is an Electron application with no console, so a BEL written to stdout
 *   or stderr reaches no device and stays silent.
 * - Running `powershell.exe -Command` (or a hidden window-style variant) plays a
 *   sound but trips HIPS products such as 火绒 ("PowerShell 静默运行").
 * - `rundll32.exe <wav>,<export>` calls the export but also tries to load the
 *   WAV as a DLL and pops "不是有效的 Win32 应用程序".
 *
 * So on Windows the plugin calls the audio API in-process through koffi, the
 * FFI library dsh itself ships (N-API, so it loads unchanged inside Electron and
 * in plain Node). No child process, no PowerShell, no compiler, no network.
 * Linux and macOS use the system players (`paplay`/`aplay`, `afplay`), which
 * neither HIPS conventions nor the absence of a console affect there.
 *
 * No audio file ships with the plugin: one is generated in memory and cached in
 * the OS temp directory, so `files[]` stays plain text and the license is
 * unambiguous. `soundFile` overrides it.
 *
 * The listener is a waterfall pass-through: it observes `approval/request`,
 * plays, and always returns whatever the remaining answerers decide. A question
 * the agent asks (`ask_user_question`) does not pass through this event.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'approval-sound'

/**
 * Row config, overridable from the profile's `cordis.patch.yml`. A patch layer
 * replaces the whole `config` object, so every key stays optional and has a
 * documented default.
 *
 * Declared with Standard Schema's `~standard` protocol (see CONTRIBUTING.md):
 * `validate` returns the resolved config, so `apply` always receives defaults
 * filled in.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugins-approval-sound',
    validate(value) {
      const config = { ...DEFAULTS }
      if (value === undefined || value === null) return { value: config }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, entry] of Object.entries(value)) {
        const check = CHECKS[key]
        if (check === undefined) return { issues: [{ message: `unknown config key: ${key}`, path: [key] }] }
        const issue = check(entry)
        if (issue !== undefined) return { issues: [{ message: issue, path: [key] }] }
        config[key] = entry
      }
      return { value: config }
    },
  },
}

const DEFAULTS = {
  enabled: true,
  soundFile: '',
  minIntervalMs: 3000,
  onlyWhenBackground: false,
  mutedTools: [],
}

const integerIn = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? undefined : `must be an integer from ${min} to ${max}`
const boolean = (value) => (typeof value === 'boolean' ? undefined : 'must be a boolean')

const CHECKS = {
  enabled: boolean,
  soundFile: (value) => (typeof value === 'string' ? undefined : 'must be a string path'),
  minIntervalMs: integerIn(0, 600000),
  onlyWhenBackground: boolean,
  mutedTools: (value) => (Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? undefined
    : 'must be an array of tool names'),
}

/** Instantiated by apply() so one plugin load never bleeds into the next. */
export function createCueState() {
  return { lastPlayedAt: 0, builtinFile: undefined, ffi: undefined, ffiTried: false }
}

/**
 * Decide whether one approval request should play.
 * @param request - the `approval/request` payload.
 * @param config - resolved config.
 * @param state - throttle state shared across requests.
 * @param now - current epoch milliseconds (injectable for tests).
 * @returns the plan to play, or undefined for a silent skip.
 */
export function planCue(request, config, state, now = Date.now()) {
  if (config.enabled !== true) return undefined
  const toolName = typeof request?.toolName === 'string' ? request.toolName : ''
  if (config.mutedTools.includes(toolName)) return undefined
  if (config.onlyWhenBackground && request?.focus === 'focused') return undefined
  if (now - state.lastPlayedAt < config.minIntervalMs) return undefined
  state.lastPlayedAt = now
  return { soundFile: config.soundFile }
}

/**
 * A two-tone "ding-dong" cue: 880 Hz then 1175 Hz, each with a linear fade so
 * no click is audible. 16-bit mono PCM at 22.05 kHz, about half a second.
 * @returns WAV file bytes.
 */
export function buildBellWav() {
  const rate = 22050
  const tones = [
    { hertz: 880, seconds: 0.22 },
    { hertz: 1175, seconds: 0.3 },
  ]
  const samples = tones.reduce((total, tone) => total + Math.round(tone.seconds * rate), 0)
  const data = Buffer.alloc(samples * 2)
  let offset = 0
  for (const tone of tones) {
    const frames = Math.round(tone.seconds * rate)
    for (let index = 0; index < frames; index += 1) {
      const seconds = index / rate
      const fadeIn = Math.min(1, seconds / 0.01)
      const fadeOut = Math.min(1, (tone.seconds - seconds) / 0.12)
      const envelope = Math.max(0, Math.min(fadeIn, fadeOut))
      const value = Math.sin(2 * Math.PI * tone.hertz * seconds) * envelope * 0.5
      data.writeInt16LE(Math.round(value * 32767), (offset + index) * 2)
    }
    offset += frames
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Materialize the built-in cue once per plugin load.
 * @param state - cue state; caches the produced path.
 * @returns the WAV path.
 */
export function builtinSoundFile(state) {
  if (state.builtinFile !== undefined && existsSync(state.builtinFile)) return state.builtinFile
  const dir = join(tmpdir(), 'dsh-approval-sound')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'ding-dong.wav')
  writeFileSync(path, buildBellWav())
  state.builtinFile = path
  return path
}

/**
 * Pick the file to play: the configured one when it exists, else the built-in.
 * @param plan - the plan from {@link planCue}.
 * @param state - cue state.
 * @param exists - predicate injectable for tests.
 * @returns the WAV path to play.
 */
export function resolveSoundFile(plan, state, exists = isFile) {
  const wanted = typeof plan.soundFile === 'string' ? plan.soundFile.trim() : ''
  if (wanted !== '' && exists(wanted)) return wanted
  return builtinSoundFile(state)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Locate koffi, the FFI library dsh ships.
 *
 * dsh's own packages cannot be imported by name from a profile-linked plugin
 * (the profile's ancestor chain does not see the dsh installation), so this
 * walks up from the Host executable to the installation root and tries the two
 * layouts that ship: `resources/app.asar.unpacked/dsh/node_modules/koffi`
 * (native binaries must live outside an asar) and a plain `node_modules/koffi`
 * for source checkouts.
 *
 * @param execPath - the Host executable (`process.execPath`).
 * @param exists - file predicate, injectable for tests.
 * @returns the koffi package directory, or undefined.
 */
export function findKoffi(execPath, exists = existsSync) {
  const candidates = []
  let dir = dirname(execPath)
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(dir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'))
    candidates.push(join(dir, 'node_modules', 'koffi'))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const candidate of candidates) {
    if (exists(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Load the koffi module from a directory, through whichever loader this
 * runtime offers (`createRequire` in Node, `require` in an addon host).
 *
 * The plugin is ESM, so it has no ambient `require`: resolve one from this
 * module's own URL, which works in plain Node and inside Electron alike.
 * @param directory - the koffi package directory.
 * @returns the koffi namespace.
 */
export function loadKoffi(directory) {
  const loader = createRequire(import.meta.url)
  return loader(join(directory, 'index.cjs'))
}

/**
 * Bind the Windows playback entry point once per plugin load.
 * @param state - cue state; caches the binding.
 * @param ctx - plugin context, for the one warning when it is unavailable.
 * @param platform - `process.platform`.
 * @param execPath - `process.execPath`.
 * @param exists - file predicate, injectable for tests.
 * @returns the `sndPlaySoundW` binding, or undefined when unavailable.
 */
export function bindWindowsPlayer(state, ctx, platform = process.platform, execPath = process.execPath, exists = existsSync) {
  if (platform !== 'win32') return undefined
  if (state.ffiTried) return state.ffi
  state.ffiTried = true
  try {
    const directory = findKoffi(execPath, exists)
    if (directory === undefined) {
      ctx.logger?.warn?.('approval-sound: koffi was not found under the dsh installation; the cue stays silent')
      return undefined
    }
    const koffi = loadKoffi(directory)
    if (koffi === undefined) {
      ctx.logger?.warn?.('approval-sound: this runtime cannot load a CommonJS FFI module; the cue stays silent')
      return undefined
    }
    const winmm = koffi.load('winmm.dll')
    // SND_FILENAME is the default for a path; SND_ASYNC returns immediately;
    // SND_NODEFAULT keeps a broken file silent instead of beeping.
    const sndPlaySoundW = winmm.func('bool __stdcall sndPlaySoundW(str16 lpszSound, uint flags)')
    state.ffi = (file) => sndPlaySoundW(file, 1 | 0x00020000)
    return state.ffi
  } catch (error) {
    ctx.logger?.warn?.('approval-sound: could not bind winmm: %s', String(error))
    return undefined
  }
}

/**
 * The external player used outside Windows.
 * @param platform - `process.platform`.
 * @param file - the WAV path.
 * @param hasPlayer - predicate for optional executables (injectable for tests).
 * @returns `{ command, args }`, or undefined.
 */
export function playerCommand(platform, file, hasPlayer = () => true) {
  if (platform === 'darwin') return { command: 'afplay', args: [file] }
  if (platform === 'linux') {
    if (hasPlayer('paplay')) return { command: 'paplay', args: [file] }
    if (hasPlayer('aplay')) return { command: 'aplay', args: ['-q', file] }
  }
  return undefined
}

/**
 * Play the cue for one request without blocking the approval waterfall.
 * @param ctx - plugin context.
 * @param request - the `approval/request` payload.
 * @param config - resolved config.
 * @param state - throttle state.
 * @returns whether a cue was played.
 */
export function playCue(ctx, request, config, state) {
  const plan = planCue(request, config, state)
  if (plan === undefined) return false
  const file = resolveSoundFile(plan, state)

  if (process.platform === 'win32') {
    const play = bindWindowsPlayer(state, ctx)
    if (play === undefined) return false
    try {
      // sndPlaySoundW returns TRUE once the sound is queued; FALSE means the
      // device refused it (or the file is unreadable).
      return play(file) !== false
    } catch (error) {
      ctx.logger?.warn?.('approval-sound: winmm playback failed: %s', String(error))
      return false
    }
  }

  const command = playerCommand(process.platform, file)
  if (command === undefined) {
    ctx.logger?.warn?.('approval-sound: no WAV player known for platform %s', process.platform)
    return false
  }
  try {
    const child = spawn(command.command, command.args, { stdio: 'ignore', detached: true })
    child.unref()
    child.on('error', (error) => {
      ctx.logger?.warn?.('approval-sound: could not start %s: %s', command.command, String(error))
    })
    return true
  } catch (error) {
    ctx.logger?.warn?.('approval-sound: could not start %s: %s', command.command, String(error))
    return false
  }
}

/**
 * Register the approval listener.
 * @param ctx - plugin context.
 * @param config - resolved row config (see {@link Config}).
 */
export function apply(ctx, config = DEFAULTS) {
  const settings = { ...DEFAULTS, ...config }
  const state = createCueState()

  const dispose = ctx.on('approval/request', async (request, next) => {
    try {
      playCue(ctx, request, settings, state)
    } catch (error) {
      ctx.logger?.warn?.('approval-sound: could not play the cue: %s', String(error))
    }
    return next()
  })
  if (typeof dispose === 'function') ctx.effect(() => dispose)
}
