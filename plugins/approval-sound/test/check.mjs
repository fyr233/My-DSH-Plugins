/**
 * Check the approval-sound plugin: config validation, the three cue plans
 * (throttle, quiet window, mute list, per-cue switches), the generated WAVs and
 * the per-platform players.
 * Run: node plugins/approval-sound/test/check.mjs
 */
import assert from 'node:assert/strict'
import {
  CUES,
  Config,
  bindWindowsPlayer,
  buildCueWav,
  createCueState,
  findKoffi,
  planCue,
  playerCommand,
} from '../index.js'

const validate = (value) => Config['~standard'].validate(value)
const settings = () => validate(undefined).value

// --- config ------------------------------------------------------------------
assert.equal(Config['~standard'].version, 1, 'config uses the Standard Schema protocol')
assert.deepEqual(settings(), {
  enabled: true,
  cue: { approval: true, question: true, done: true },
  sounds: { approval: '', question: '', done: '' },
  minIntervalMs: 800,
  quietMs: 0,
  onlyWhenBackground: false,
  mutedTools: [],
}, 'defaults are filled in')
assert.deepEqual(CUES, ['approval', 'question', 'done'], 'three cues')
assert.equal(validate({ cue: { done: false } }).value.cue.done, false, 'one cue can be disabled')
assert.equal(validate({ cue: { done: false } }).value.cue.approval, true, 'the other cues keep their default')
assert.equal(validate({ sounds: { done: 'C:\\x.wav' } }).value.sounds.done, 'C:\\x.wav', 'a custom file per cue')
assert.equal(validate({ sounds: { done: 'C:\\x.wav' } }).value.sounds.approval, '', 'other cues stay built-in')
assert.ok(validate({ cue: { alarm: false } }).issues, 'an unknown cue name is rejected')
assert.ok(validate({ sounds: { alarm: 'x.wav' } }).issues, 'an unknown sound name is rejected')
assert.ok(validate({ cue: { done: 'yes' } }).issues, 'cue switches are booleans')
assert.ok(validate({ sounds: { done: 3 } }).issues, 'sound paths are strings')
assert.ok(validate({ minIntervalMs: -1 }).issues, 'a negative interval is rejected')
assert.ok(validate({ quietMs: -1 }).issues, 'a negative quiet window is rejected')
assert.ok(validate({ mutedTools: 'bash' }).issues, 'mutedTools must be an array')
assert.ok(validate({ soundFile: 'x.wav' }).issues, 'the retired single-sound key is rejected')
assert.ok(validate([]).issues, 'a non-object config is rejected')

// --- cue plans ---------------------------------------------------------------
{
  const config = settings()
  const state = createCueState()
  assert.deepEqual(planCue('approval', { now: 10_000 }, config, state), { kind: 'approval', soundFile: '' })
  assert.equal(planCue('done', { now: 10_100 }, config, state), undefined, 'a burst is throttled')
  assert.ok(planCue('done', { now: 11_000 }, config, state), 'the throttle window laps')
}
assert.equal(
  planCue('question', {}, { ...settings(), cue: { approval: true, question: false, done: true } }, createCueState()),
  undefined,
  'a disabled cue stays silent',
)
assert.equal(
  planCue('approval', { toolName: 'pwsh' }, { ...settings(), mutedTools: ['pwsh'] }, createCueState()),
  undefined,
  'a muted tool is silent',
)
assert.ok(
  planCue('approval', { toolName: 'fs' }, { ...settings(), mutedTools: ['pwsh'] }, createCueState()),
  'an unmuted tool still rings',
)
assert.equal(
  planCue('done', { focus: 'focused' }, { ...settings(), onlyWhenBackground: true }, createCueState()),
  undefined,
  'onlyWhenBackground skips a focused request',
)

// quietMs: a finished turn stays silent for a moment after a question cue.
{
  const state = createCueState()
  const config = { ...settings(), quietMs: 5000 }
  state.lastQuestionAt = 10_000
  assert.equal(planCue('done', { now: 10_500 }, config, state), undefined, 'done waits out the quiet window')
  assert.ok(planCue('done', { now: 15_000 }, config, state), 'done rings after it')
}

// --- the generated WAVs ------------------------------------------------------
const seen = new Set()
for (const kind of CUES) {
  const wav = buildCueWav(kind)
  assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF', `${kind}: RIFF header`)
  assert.equal(wav.readUInt32LE(4), wav.length - 8, `${kind}: RIFF size covers the payload`)
  assert.equal(wav.subarray(8, 12).toString('latin1'), 'WAVE', `${kind}: WAVE form`)
  assert.equal(wav.readUInt16LE(20), 1, `${kind}: PCM format`)
  assert.equal(wav.readUInt16LE(22), 1, `${kind}: mono`)
  assert.equal(wav.readUInt16LE(34), 16, `${kind}: 16-bit samples`)
  assert.equal(wav.subarray(36, 40).toString('latin1'), 'data', `${kind}: data chunk`)
  assert.equal(wav.readUInt32LE(40), wav.length - 44, `${kind}: data length matches`)
  assert.ok(wav.length > 12_000 && wav.length < 60_000, `${kind}: short but non-trivial`)
  assert.ok(wav.subarray(44).some((byte) => byte !== 0), `${kind}: carries audio`)
  seen.add(wav.subarray(44).toString('base64'))
}
assert.equal(seen.size, 3, 'the three cues are audibly distinct')

// --- koffi discovery ---------------------------------------------------------
const installRoot = 'C:\\Program Files\\DeepSeek Harness'
const bundled = `${installRoot}\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi\\package.json`
assert.equal(
  findKoffi(`${installRoot}\\DeepSeek Harness.exe`, (path) => path === bundled),
  `${installRoot}\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi`,
  'the shipped koffi is found from the Host executable',
)
assert.equal(findKoffi(`${installRoot}\\DeepSeek Harness.exe`, () => false), undefined, 'a missing install reports nothing')
assert.equal(
  bindWindowsPlayer(createCueState(), { logger: { warn() {} } }, 'linux', '', () => true),
  undefined,
  'no Windows binding off Windows',
)

// A missing FFI warns exactly once, and never throws.
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
assert.equal(playerCommand('win32', 'C:\\x.wav'), undefined, 'Windows never spawns a process')

console.log('approval-sound: all checks passed')
