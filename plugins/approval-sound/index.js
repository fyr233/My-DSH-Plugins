/**
 * Alert sounds for dsh: play a short cue when the user's attention is needed or
 * a turn has finished, so work that happens in the background is noticed.
 *
 * Three cues, one per moment:
 *
 * | kind       | moment                                                        | default tone |
 * | ---------- | ------------------------------------------------------------- | ------------ |
 * | `approval` | dsh is about to ask for a decision (permission panel)         | 880→1175 Hz  |
 * | `question` | the agent calls `ask_user_question` and waits for the answer  | three rising |
 * | `done`     | the agent finished a turn (`agent/turn-stopping`)             | 1047→784 Hz  |
 *
 * How the sound is produced (all of it verified on Windows):
 *
 * - dsh is an Electron app with no console, so a BEL written to stdout or stderr
 *   reaches no device.
 * - `powershell.exe` plays a file but trips HIPS products (火绒 "静默运行").
 * - `rundll32.exe <wav>,<export>` loads the WAV as a DLL and pops an error.
 * - `SND_ASYNC` returns TRUE in 0 ms in the Host and plays nothing; the
 *   synchronous form blocks until the device drains the file and is audible.
 *
 * So Windows plays in-process through koffi (the FFI library dsh ships, N-API,
 * loads in Electron and Node alike) calling `winmm!sndPlaySoundW` synchronously.
 * Linux uses `paplay`/`aplay`, macOS uses `afplay`.
 *
 * Sounds are generated in memory (no binary assets, no licensing question) and
 * cached in the OS temp directory. `sounds.<kind>` overrides any of them with a
 * user WAV file.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export const name = 'approval-sound'

/** The three moments this plugin can announce. */
export const CUES = ['approval', 'question', 'done']

/**
 * Row config, overridable from the profile's `cordis.patch.yml`. A patch layer
 * replaces the whole `config` object, so every key stays optional and has a
 * documented default.
 *
 * Declared with Standard Schema's `~standard` protocol (see docs/experiences/03):
 * `validate` returns the resolved config, so `apply` always receives defaults.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugins-approval-sound',
    validate(value) {
      const config = { ...DEFAULTS, cue: { ...DEFAULTS.cue }, sounds: { ...DEFAULT_SOUNDS } }
      if (value === undefined || value === null) return { value: config }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, entry] of Object.entries(value)) {
        const check = CHECKS[key]
        if (check === undefined) return { issues: [{ message: `unknown config key: ${key}`, path: [key] }] }
        const issue = check(entry)
        if (issue !== undefined) return { issues: [{ message: issue, path: [key] }] }
        if (key === 'cue' || key === 'sounds') {
          // Merge per key: a user setting only `cue.done` keeps the other cues.
          config[key] = { ...config[key], ...entry }
        } else {
          config[key] = entry
        }
      }
      return { value: config }
    },
  },
}

const DEFAULT_SOUNDS = { approval: '', question: '', done: '' }

const DEFAULTS = {
  enabled: true,
  cue: { approval: true, question: true, done: true },
  sounds: DEFAULT_SOUNDS,
  minIntervalMs: 800,
  quietMs: 0,
  onlyWhenBackground: false,
  mutedTools: [],
}

const boolean = (value) => (typeof value === 'boolean' ? undefined : 'must be a boolean')
const integerIn = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? undefined : `must be an integer from ${min} to ${max}`
const stringPath = (value) => (typeof value === 'string' ? undefined : 'must be a string path')
const stringArray = (value) => (Array.isArray(value) && value.every((item) => typeof item === 'string')
  ? undefined
  : 'must be an array of tool names')

/** Config keys accepted from the user. */
const CHECKS = {
  enabled: boolean,
  cue: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object of booleans'
    for (const [kind, flag] of Object.entries(value)) {
      if (!CUES.includes(kind)) return `unknown cue: ${kind} (expected ${CUES.join(', ')})`
      const issue = boolean(flag)
      if (issue !== undefined) return `cue.${kind} ${issue}`
    }
    return undefined
  },
  sounds: (value) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'must be an object of paths'
    for (const [kind, path] of Object.entries(value)) {
      if (!CUES.includes(kind)) return `unknown cue: ${kind} (expected ${CUES.join(', ')})`
      const issue = stringPath(path)
      if (issue !== undefined) return `sounds.${kind} ${issue}`
    }
    return undefined
  },
  minIntervalMs: integerIn(0, 600000),
  quietMs: integerIn(0, 600000),
  onlyWhenBackground: boolean,
  mutedTools: stringArray,
}

/** Instantiated by apply() so one plugin load never bleeds into the next. */
export function createCueState() {
  return { lastPlayedAt: 0, builtinFiles: {}, ffi: undefined, ffiTried: false }
}

/** Sound shapes per cue: note list [frequency Hz, seconds]. */
const CUE_NOTES = {
  // Ding-dong: a question is waiting for you.
  approval: [[880, 0.22], [1175, 0.3]],
  // Three short rising notes: the agent asks, the floor is yours.
  question: [[660, 0.12], [880, 0.12], [1320, 0.2]],
  // Falling pair: the turn is over.
  done: [[1047, 0.16], [784, 0.28]],
}

/**
 * Synthesize one cue as 16-bit mono PCM WAV at 22.05 kHz. Each note gets a 10 ms
 * fade in and a 120 ms fade out so no click is audible, and a 40 ms gap keeps
 * consecutive notes distinct.
 * @param kind - one of {@link CUES}.
 * @returns WAV file bytes.
 */
export function buildCueWav(kind) {
  const notes = CUE_NOTES[kind] ?? CUE_NOTES.approval
  const rate = 22050
  const gapSeconds = 0.04
  const frames = notes.map(([, seconds]) => Math.round(seconds * rate))
  const gap = Math.round(gapSeconds * rate)
  const samples = frames.reduce((total, count, index) => total + count + (index < notes.length - 1 ? gap : 0), 0)
  const data = Buffer.alloc(samples * 2)
  let offset = 0
  notes.forEach(([hertz, seconds], index) => {
    for (let frame = 0; frame < frames[index]; frame += 1) {
      const time = frame / rate
      const fadeIn = Math.min(1, time / 0.01)
      const fadeOut = Math.min(1, (seconds - time) / 0.12)
      const envelope = Math.max(0, Math.min(fadeIn, fadeOut))
      const value = Math.sin(2 * Math.PI * hertz * time) * envelope * 0.45
      data.writeInt16LE(Math.round(value * 32767), (offset + frame) * 2)
    }
    offset += frames[index]
    if (index < notes.length - 1) offset += gap
  })
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'latin1')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'latin1')
  header.write('fmt ', 12, 'latin1')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'latin1')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

/**
 * Materialize one built-in cue (once per kind per plugin load).
 * @param state - cue state; caches produced paths.
 * @param kind - one of {@link CUES}.
 * @returns the WAV path.
 */
export function builtinSoundFile(state, kind) {
  const cached = state.builtinFiles[kind]
  if (cached !== undefined && existsSync(cached)) return cached
  const dir = join(tmpdir(), 'dsh-approval-sound')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${kind}.wav`)
  writeFileSync(path, buildCueWav(kind))
  state.builtinFiles[kind] = path
  return path
}

/**
 * Decide whether one cue should play.
 *
 * Throttling has two parts: `minIntervalMs` collapses the two events that can
 * describe one decision (the tool policy and the approval panel), and `quietMs`
 * keeps a finished turn from being announced while the user just answered a
 * question.
 *
 * @param kind - one of {@link CUES}.
 * @param options - `{ toolName?, now? }`; `toolName` only matters for approval.
 * @param config - resolved config.
 * @param state - throttle state shared across cues.
 * @returns the effective sound path, or undefined for a silent skip.
 */
export function planCue(kind, options, config, state) {
  const now = options?.now ?? Date.now()
  if (config.enabled !== true) return undefined
  if (config.cue?.[kind] === false) return undefined
  const toolName = typeof options?.toolName === 'string' ? options.toolName : ''
  if (toolName !== '' && config.mutedTools.includes(toolName)) return undefined
  if (config.onlyWhenBackground && options?.focus === 'focused') return undefined
  if (now - state.lastPlayedAt < config.minIntervalMs) return undefined
  if (kind === 'done' && state.lastQuestionAt !== undefined && now - state.lastQuestionAt < config.quietMs) {
    return undefined
  }
  state.lastPlayedAt = now
  return { kind, soundFile: config.sounds?.[kind] ?? '' }
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
  return builtinSoundFile(state, plan.kind)
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
 * dsh's own packages cannot be imported by name from a profile-linked plugin,
 * so this walks up from the Host executable and tries the two layouts that
 * ship: `resources/app.asar.unpacked/dsh/node_modules/koffi` (native binaries
 * must live outside an asar) and a plain `node_modules/koffi` for a checkout.
 * @param execPath - the Host executable (`process.execPath`).
 * @param exists - file predicate, injectable for tests.
 * @returns the koffi package directory, or undefined.
 */
export function findKoffi(execPath, exists = existsSync) {
  let dir = dirname(execPath)
  for (let depth = 0; depth < 6; depth += 1) {
    for (const candidate of [
      join(dir, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi'),
      join(dir, 'node_modules', 'koffi'),
    ]) {
      if (exists(join(candidate, 'package.json'))) return candidate
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * Load the koffi module from a directory.
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
      ctx.logger?.warn?.('approval-sound: koffi was not found under the dsh installation; cues stay silent')
      return undefined
    }
    const koffi = loadKoffi(directory)
    const winmm = koffi.load('winmm.dll')
    // SND_FILENAME: the string is a file path. No SND_ASYNC on purpose — it
    // returns TRUE in 0 ms in this Host and plays nothing, while the synchronous
    // call blocks until the device drained the file and is audible.
    const sndPlaySoundW = winmm.func('bool __stdcall sndPlaySoundW(str16 lpszSound, uint flags)')
    state.ffi = (file) => sndPlaySoundW(file, 0x00020000)
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
 * Play one cue.
 * @param ctx - plugin context.
 * @param kind - one of {@link CUES}.
 * @param options - `{ toolName?, focus?, now? }` from the triggering event.
 * @param config - resolved config.
 * @param state - throttle state.
 * @returns whether a cue was played.
 */
export function playCue(ctx, kind, options, config, state) {
  const plan = planCue(kind, options, config, state)
  if (plan === undefined) return false
  if (kind === 'question') state.lastQuestionAt = Date.now()
  const file = resolveSoundFile(plan, state)

  if (process.platform === 'win32') {
    const play = bindWindowsPlayer(state, ctx)
    if (play === undefined) return false
    try {
      const played = play(file) !== false
      if (!played) ctx.logger?.warn?.('approval-sound: sndPlaySoundW refused %s', file)
      return played
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
 * Register the listeners for the three cues.
 *
 * - `approval`: `approval/request` (the user-approval waterfall that
 *   `ui-approval` renders a panel from) **and** `tools/pre-execute` returning
 *   `ask`. Both are needed: a plugin-management call asking for elevation
 *   appears only as the latter. `minIntervalMs` folds them into one cue.
 * - `question`: `user-questions/request`, the `ask_user_question` seam.
 * - `done`: `agent/turn-stopping`, dispatched right before a turn closes.
 *
 * Every listener is a pass-through: it never changes a decision, and a failing
 * cue is swallowed so an alert can never block dsh.
 *
 * @param ctx - plugin context.
 * @param config - resolved row config (see {@link Config}).
 */
export function apply(ctx, config = DEFAULTS) {
  const settings = {
    ...DEFAULTS,
    ...config,
    cue: { ...DEFAULTS.cue, ...(config?.cue ?? {}) },
    sounds: { ...DEFAULT_SOUNDS, ...(config?.sounds ?? {}) },
  }
  const state = createCueState()

  // Bind once at load so a broken FFI shows up at startup, not mid-conversation.
  if (process.platform === 'win32') bindWindowsPlayer(state, ctx)

  const cue = (kind, options = {}) => {
    try {
      playCue(ctx, kind, options, settings, state)
    } catch (error) {
      ctx.logger?.warn?.('approval-sound: could not play the %s cue: %s', kind, String(error))
    }
  }

  const disposers = [
    ctx.on('approval/request', async (request, next) => {
      cue('approval', { toolName: request?.toolName })
      return next()
    }),
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (decision?.kind === 'ask' || decision?.action === 'ask' || decision === 'ask') {
        cue('approval', { toolName: typeof exec?.name === 'string' ? exec.name : '' })
      }
      return decision
    }),
    ctx.on('user-questions/request', async (request, next) => {
      cue('question')
      return next()
    }),
    ctx.on('agent/turn-stopping', async () => {
      cue('done')
    }),
  ]
  for (const dispose of disposers) {
    if (typeof dispose === 'function') ctx.effect(() => dispose)
  }
}
