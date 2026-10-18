/**
 * Approval alert sound: play a cue whenever dsh asks the user for approval, so
 * a prompt that appears while the app is in the background is noticed.
 *
 * The cue runs in a detached Windows PowerShell child process started through
 * `ctx.subprocess.spawn()`. That is deliberate: the Host runs in an Electron
 * main process where `console.beep()` and `child_process` shares are not
 * dependable, while a child PowerShell with `System.Media.SoundPlayer` always
 * owns a real console and plays the system sound (playback happens before the
 * child exits, so truncation is never a problem).
 *
 * The listener is a waterfall pass-through: it observes `approval/request`,
 * schedules the cue, and always returns whatever the remaining answerers
 * decide. A question the agent asks (`ask_user_question`) does NOT pass through
 * this event, so it stays silent.
 */
import { statSync } from 'node:fs'

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

const SOUNDS = ['exclamation', 'asterisk', 'beep', 'hand', 'question']
const ONLY = ['all', 'background']

const DEFAULTS = {
  enabled: true,
  sound: 'exclamation',
  soundFile: '',
  repeats: 1,
  gapMs: 700,
  minIntervalMs: 3000,
  onlyWhenBackground: false,
  mutedTools: [],
}

const nonEmptyString = (value) => (typeof value === 'string' ? undefined : 'must be a string')
const integerIn = (min, max) => (value) =>
  Number.isInteger(value) && value >= min && value <= max ? undefined : `must be an integer from ${min} to ${max}`
const oneOf = (values) => (value) => (values.includes(value) ? undefined : `must be one of ${values.join(', ')}`)

const CHECKS = {
  enabled: (value) => (typeof value === 'boolean' ? undefined : 'must be a boolean'),
  sound: oneOf(SOUNDS),
  soundFile: nonEmptyString,
  repeats: integerIn(1, 10),
  gapMs: integerIn(0, 10000),
  minIntervalMs: integerIn(0, 600000),
  onlyWhenBackground: (value) => (typeof value === 'boolean' ? undefined : 'must be a boolean'),
  mutedTools: (value) => (Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? undefined
    : 'must be an array of tool names'),
}

/** Instantiated by apply() so one plugin load never bleeds into the next. */
export function createCueState() {
  return { lastPlayedAt: 0 }
}

/**
 * Decide whether one approval request should play a cue.
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
  return {
    sound: config.sound,
    soundFile: config.soundFile,
    repeats: config.repeats,
    gapMs: config.gapMs,
  }
}

const SYSTEM_SOUND_MEMBERS = {
  exclamation: 'Exclamation',
  asterisk: 'Asterisk',
  beep: 'Beep',
  hand: 'Hand',
  question: 'Question',
}

/**
 * Build the Windows PowerShell program that plays one plan.
 * @param plan - the plan from {@link planCue}.
 * @returns a script that plays every repeat, then exits.
 */
export function buildSoundScript(plan) {
  const lines = ["$ErrorActionPreference = 'SilentlyContinue'"]
  for (let index = 0; index < plan.repeats; index += 1) {
    if (index > 0 && plan.gapMs > 0) lines.push(`Start-Sleep -Milliseconds ${plan.gapMs}`)
    if (plan.soundFile !== '') {
      const escaped = plan.soundFile.replace(/'/gu, "''")
      lines.push(`(New-Object System.Media.SoundPlayer '${escaped}').PlaySync()`)
    } else {
      const member = SYSTEM_SOUND_MEMBERS[plan.sound] ?? SYSTEM_SOUND_MEMBERS.exclamation
      lines.push(`[System.Media.SystemSounds]::${member}.Play()`)
    }
  }
  // System.Media's Play() is asynchronous; keep the child alive long enough for
  // the device to drain instead of cutting the cue off on exit.
  lines.push('Start-Sleep -Milliseconds 900')
  return lines.join('; ')
}

/**
 * The child command line used on Windows.
 * @param script - the program from {@link buildSoundScript}.
 * @returns argv for `subprocess.spawn`.
 */
export function soundArgv(script) {
  return [
    'powershell.exe',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script,
  ]
}

/**
 * A sound file configured by the user must exist; a stale path would silently
 * mute the alert. Reported through the plugin logger, not thrown, so one bad
 * value never disables the whole plugin.
 * @param config - resolved config.
 * @returns whether a substituted/system sound should be used instead.
 */
export function resolveSoundFile(config, exists = existsOnDisk) {
  if (typeof config.soundFile !== 'string' || config.soundFile.trim() === '') return ''
  return exists(config.soundFile.trim()) ? config.soundFile.trim() : ''
}

function existsOnDisk(path) {
  try {
    return statSync(path).isFile()
  } catch {
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
      ctx.logger?.warn?.('approval-sound: could not play the approval cue: %s', String(error))
    }
    return next()
  })
  if (typeof dispose === 'function') ctx.effect(() => dispose)
}

/**
 * Play the cue for one request without blocking the approval waterfall.
 * @param ctx - plugin context.
 * @param request - the `approval/request` payload.
 * @param config - resolved config.
 * @param state - throttle state.
 * @returns whether a cue was started.
 */
export function playCue(ctx, request, config, state) {
  if (process.platform !== 'win32') return false
  const plan = planCue(request, config, state)
  if (plan === undefined) return false
  const soundFile = resolveSoundFile(plan, existsOnDisk)
  if (plan.soundFile !== '' && soundFile === '') {
    ctx.logger?.warn?.('approval-sound: soundFile %s does not exist; using the system sound', plan.soundFile)
  }
  const subprocess = ctx.get('subprocess')
  if (subprocess === undefined) {
    ctx.logger?.warn?.('approval-sound: no subprocess service in this composition; the cue is skipped')
    return false
  }
  subprocess.spawn({
    argv: soundArgv(buildSoundScript({ ...plan, soundFile })),
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' },
    graceMs: 1500 + plan.repeats * (plan.gapMs + 1200),
  })
  return true
}
