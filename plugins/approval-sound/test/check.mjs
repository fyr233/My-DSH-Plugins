/**
 * Check the approval-sound plugin: config validation, the playback plan
 * (throttle, mute list, background rule), the generated WAV, koffi discovery,
 * and the non-Windows player fallback.
 * Run: node plugins/approval-sound/test/check.mjs
 */
import assert from 'node:assert/strict'
import {
  Config,
  bindWindowsPlayer,
  buildBellWav,
  createCueState,
  findKoffi,
  planCue,
  playerCommand,
} from '../index.js'

const validate = (value) => Config['~standard'].validate(value)

// --- config ------------------------------------------------------------------
assert.equal(Config['~standard'].version, 1, 'config uses the Standard Schema protocol')
assert.deepEqual(validate(undefined).value, {
  enabled: true,
  soundFile: '',
  minIntervalMs: 3000,
  onlyWhenBackground: false,
  mutedTools: [],
}, 'defaults are filled in')
assert.equal(validate({ minIntervalMs: 0 }).value.minIntervalMs, 0, 'a known value is accepted')
assert.equal(validate({ minIntervalMs: 0 }).value.enabled, true, 'other defaults survive a partial override')
assert.ok(validate({ minIntervalMs: -1 }).issues, 'a negative interval is rejected')
assert.ok(validate({ mutedTools: 'bash' }).issues, 'mutedTools must be an array')
assert.ok(validate({ repeats: 2 }).issues, 'the retired ring keys are rejected')
assert.ok(validate({ soundFile: 3 }).issues, 'soundFile must be a string')
assert.ok(validate([]).issues, 'a non-object config is rejected')

// --- playback plan -----------------------------------------------------------
const request = { agent: { id: 'a1' }, toolName: 'pwsh' }
{
  const config = validate(undefined).value
  const state = createCueState()
  assert.deepEqual(planCue(request, config, state, 10_000), { soundFile: '' }, 'the first request plays')
  assert.equal(planCue(request, config, state, 10_500), undefined, 'a burst is throttled')
  assert.ok(planCue(request, config, state, 13_000), 'the throttle window laps and plays again')
}
assert.equal(planCue(request, { ...validate({}).value, enabled: false }, createCueState()), undefined, 'enabled false is silent')
assert.equal(
  planCue(request, { ...validate({}).value, mutedTools: ['pwsh'] }, createCueState()),
  undefined,
  'a muted tool is silent',
)
assert.ok(
  planCue({ ...request, toolName: 'fs' }, { ...validate({}).value, mutedTools: ['pwsh'] }, createCueState()),
  'an unmuted tool still plays',
)
assert.equal(
  planCue({ ...request, focus: 'focused' }, { ...validate({}).value, onlyWhenBackground: true }, createCueState()),
  undefined,
  'onlyWhenBackground skips a focused request',
)

// --- the generated WAV -------------------------------------------------------
const wav = buildBellWav()
assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF', 'RIFF header')
assert.equal(wav.readUInt32LE(4), wav.length - 8, 'RIFF size covers the payload')
assert.equal(wav.subarray(8, 12).toString('latin1'), 'WAVE', 'WAVE form')
assert.equal(wav.readUInt16LE(20), 1, 'PCM format')
assert.equal(wav.readUInt16LE(22), 1, 'mono')
assert.equal(wav.readUInt16LE(34), 16, '16-bit samples')
assert.equal(wav.subarray(36, 40).toString('latin1'), 'data', 'data chunk')
assert.equal(wav.readUInt32LE(40), wav.length - 44, 'data length matches')
assert.ok(wav.length > 20_000 && wav.length < 60_000, 'the cue is short but non-trivial')
assert.ok(wav.subarray(44).some((byte) => byte !== 0), 'the payload carries audio')

// --- koffi discovery ---------------------------------------------------------
const installRoot = 'C:\\Program Files\\DeepSeek Harness'
const bundled = `${installRoot}\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi\\package.json`
const exe = `${installRoot}\\DeepSeek Harness.exe`
assert.equal(
  findKoffi(exe, (path) => path === bundled),
  `${installRoot}\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi`,
  'the shipped koffi is found from the Host executable',
)
assert.equal(findKoffi(exe, () => false), undefined, 'a missing install reports nothing')
assert.equal(
  bindWindowsPlayer(createCueState(), { logger: { warn() {} } }, 'linux', exe, () => true),
  undefined,
  'no Windows binding off Windows',
)

// A silent logger records the one warning when koffi is absent.
const warnings = []
bindWindowsPlayer(
  createCueState(),
  { logger: { warn: (...parts) => warnings.push(parts.join(' ')) } },
  'win32',
  'C:\\nowhere\\dsh.exe',
  () => false,
)
assert.equal(warnings.length, 1, 'a missing FFI warns once')
assert.match(warnings[0], /koffi/iu)

// --- non-Windows fallback ----------------------------------------------------
assert.deepEqual(playerCommand('darwin', '/tmp/cue.wav'), { command: 'afplay', args: ['/tmp/cue.wav'] })
assert.deepEqual(playerCommand('linux', '/tmp/cue.wav', () => true), { command: 'paplay', args: ['/tmp/cue.wav'] })
assert.deepEqual(
  playerCommand('linux', '/tmp/cue.wav', (name) => name === 'aplay'),
  { command: 'aplay', args: ['-q', '/tmp/cue.wav'] },
  'aplay is the ALSA fallback',
)
assert.equal(playerCommand('linux', '/tmp/cue.wav', () => false), undefined, 'no Linux player, no playback')
assert.equal(playerCommand('freebsd', '/tmp/cue.wav'), undefined, 'an unknown platform stays silent')
assert.equal(playerCommand('win32', 'C:\\x.wav'), undefined, 'Windows never spawns a process')

console.log('approval-sound: all checks passed')
