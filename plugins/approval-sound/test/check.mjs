/**
 * Check the approval-sound plugin: config validation, the cue plan (throttle,
 * mute list, background rule), and the PowerShell program it builds.
 * Run: node plugins/approval-sound/test/check.mjs
 */
import assert from 'node:assert/strict'
import {
  Config,
  buildSoundScript,
  createCueState,
  planCue,
  resolveSoundFile,
  soundArgv,
} from '../index.js'

const validate = (value) => Config['~standard'].validate(value)

// --- config ------------------------------------------------------------------
assert.equal(Config['~standard'].version, 1, 'config uses the Standard Schema protocol')

const defaults = validate(undefined)
assert.deepEqual(defaults.value, {
  enabled: true,
  sound: 'exclamation',
  soundFile: '',
  repeats: 1,
  gapMs: 700,
  minIntervalMs: 3000,
  onlyWhenBackground: false,
  mutedTools: [],
}, 'defaults are filled in')

assert.equal(validate({ sound: 'asterisk' }).value.sound, 'asterisk', 'a known sound is accepted')
assert.equal(validate({ sound: 'asterisk' }).value.repeats, 1, 'other defaults survive a partial override')
assert.ok(validate({ sound: 'trumpet' }).issues, 'an unknown sound is rejected')
assert.ok(validate({ repeats: 0 }).issues, 'repeats must be at least 1')
assert.ok(validate({ repeats: 11 }).issues, 'repeats is capped')
assert.ok(validate({ minIntervalMs: -1 }).issues, 'a negative interval is rejected')
assert.ok(validate({ mutedTools: 'bash' }).issues, 'mutedTools must be an array')
assert.ok(validate({ mute: [] }).issues, 'unknown keys are rejected')
assert.ok(validate([]).issues, 'a non-object config is rejected')

// --- cue plan ----------------------------------------------------------------
const request = { agent: { id: 'a1' }, toolName: 'pwsh' }
{
  const config = defaults.value
  const state = createCueState()
  const plan = planCue(request, config, state, 10_000)
  assert.deepEqual(plan, { sound: 'exclamation', soundFile: '', repeats: 1, gapMs: 700 }, 'the first request plays')
  assert.equal(planCue(request, config, state, 10_500), undefined, 'a burst is throttled')
  assert.ok(planCue(request, config, state, 13_000), 'the throttle window laps and plays again')
}
assert.equal(planCue(request, { ...defaults.value, enabled: false }, createCueState()), undefined, 'enabled false is silent')
assert.equal(
  planCue(request, { ...defaults.value, mutedTools: ['pwsh'] }, createCueState()),
  undefined,
  'a muted tool is silent',
)
assert.ok(
  planCue({ ...request, toolName: 'fs' }, { ...defaults.value, mutedTools: ['pwsh'] }, createCueState()),
  'an unmuted tool still plays',
)
assert.equal(
  planCue({ ...request, focus: 'focused' }, { ...defaults.value, onlyWhenBackground: true }, createCueState()),
  undefined,
  'onlyWhenBackground skips a focused request',
)
assert.ok(
  planCue({ ...request, focus: 'background' }, { ...defaults.value, onlyWhenBackground: true }, createCueState()),
  'onlyWhenBackground still plays in the background',
)

// --- the program the child runs ----------------------------------------------
const systemScript = buildSoundScript({ sound: 'asterisk', soundFile: '', repeats: 2, gapMs: 500 })
assert.match(systemScript, /SystemSounds\]::Asterisk\.Play\(\)/u)
assert.match(systemScript, /Start-Sleep -Milliseconds 500/u, 'the gap is honored')
assert.equal(systemScript.split('::Asterisk.Play()').length - 1, 2, 'repeats are honored')
assert.match(systemScript, /Start-Sleep -Milliseconds 900/u, 'the child outlives Play()')

const fileScript = buildSoundScript({ sound: 'exclamation', soundFile: "C:\\a b\\o'k.wav", repeats: 1, gapMs: 0 })
assert.match(fileScript, /New-Object System\.Media\.SoundPlayer 'C:\\a b\\o''k\.wav'\)\.PlaySync\(\)/u, 'quotes are escaped')

const argv = soundArgv(systemScript)
assert.equal(argv[0], 'powershell.exe')
assert.ok(argv.includes('-NonInteractive'))
assert.equal(argv.at(-1), systemScript)

// --- sound file resolution ---------------------------------------------------
assert.equal(resolveSoundFile({ soundFile: '' }, () => true), '', 'no file configured')
assert.equal(resolveSoundFile({ soundFile: 'C:\\x.wav' }, () => true), 'C:\\x.wav', 'an existing file wins')
assert.equal(resolveSoundFile({ soundFile: 'C:\\missing.wav' }, () => false), '', 'a stale path falls back')

console.log('approval-sound: all checks passed')
