/**
 * Check the window-capture plugin: worker protocol parsing and the PNG encoder.
 * The live capture path needs a spawnable host, so it is exercised through
 * parseOutput with real worker output shapes.
 * Run: node window-capture/test/check.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { apply, Config, parseOutput, describeWindow, CaptureError } from '../index.js'
import { buildShotWav, createCueState, findKoffi, playerCommand, shotSoundFile } from '../cue.js'

// --- config: the capture cue is optional and off can be asked for ------------
assert.equal(Config['~standard'].validate(undefined).value.cue, true, 'the cue is on by default')
assert.equal(Config['~standard'].validate({ cue: false }).value.cue, false, 'the cue can be disabled')
assert.equal(Config['~standard'].validate({ cue: false }).value.timeoutMs, 20000, 'other defaults survive')
assert.ok(Config['~standard'].validate({ cue: 'yes' }).issues, 'cue must be a boolean')

// --- the capture cue ---------------------------------------------------------
const wav = buildShotWav()
assert.equal(wav.subarray(0, 4).toString('latin1'), 'RIFF', 'RIFF header')
assert.equal(wav.subarray(8, 12).toString('latin1'), 'WAVE', 'WAVE form')
assert.equal(wav.readUInt16LE(20), 1, 'PCM format')
assert.equal(wav.readUInt16LE(22), 1, 'mono')
assert.equal(wav.readUInt32LE(40), wav.length - 44, 'data length matches')
assert.ok(wav.length > 8000 && wav.length < 40000, 'short but non-trivial')
assert.ok(wav.subarray(44).some((byte) => byte !== 0), 'carries audio')

const state = createCueState()
const cueFile = shotSoundFile(state)
assert.ok(existsSync(cueFile), 'the cue is materialized in the temp directory')
assert.equal(shotSoundFile(state), cueFile, 'the cue is cached per plugin load')

const bundled = 'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi\\package.json'
assert.equal(
  findKoffi('C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe', (path) => path === bundled),
  'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar.unpacked\\dsh\\node_modules\\koffi',
  'the shipped koffi is found from the Host executable',
)
assert.equal(findKoffi('C:\\x\\dsh.exe', () => false), undefined, 'a missing install reports nothing')

assert.deepEqual(playerCommand('darwin', '/tmp/a.wav'), { command: 'afplay', args: ['/tmp/a.wav'] })
assert.deepEqual(
  playerCommand('linux', '/tmp/a.wav', (name) => name === 'aplay'),
  { command: 'aplay', args: ['-q', '/tmp/a.wav'] },
  'aplay is the ALSA fallback',
)
assert.equal(playerCommand('linux', '/tmp/a.wav', () => false), undefined, 'no player, no cue')
assert.equal(playerCommand('win32', 'C:\\a.wav'), undefined, 'Windows never spawns a process')


// --- result parsing (the worker → plugin boundary) --------------------------
const ok = parseOutput(
  'noise\n{"ok":true,"path":"C:\\\\t\\\\a.png","width":800,"height":600,"title":"Notepad","handle":10,"pid":100,"scope":"window","method":"printwindow+2","bytes":1234}\n',
  '', 0,
)
assert.equal(ok.ok, true)
assert.equal(ok.width, 800)
assert.equal(ok.method, 'printwindow+2')

// A structured worker failure keeps its code so tools can explain it.
assert.throws(
  () => parseOutput('{"ok":false,"code":"NO_WINDOW","message":"找不到窗口"}', '', 0),
  (error) => {
    assert.ok(error instanceof CaptureError)
    assert.equal(error.code, 'NO_WINDOW')
    assert.equal(error.message, '找不到窗口')
    return true
  },
)

// An ambiguous title must surface as AMBIGUOUS, not as a generic failure.
assert.throws(
  () => parseOutput('{"ok":false,"code":"AMBIGUOUS","message":"有两个窗口匹配"}', '', 0),
  (error) => error.code === 'AMBIGUOUS',
)

// A GPU window that renders blank reports BLANK_CAPTURE with guidance.
assert.throws(
  () => parseOutput('{"ok":false,"code":"BLANK_CAPTURE","message":"渲染结果为空白"}', '', 0),
  (error) => error.code === 'BLANK_CAPTURE' && /空白/u.test(error.message),
)

// No JSON line at all is a worker failure carrying the exit code and stderr.
assert.throws(
  () => parseOutput('', 'Error: boom', 1),
  (error) => {
    assert.equal(error.code, 'WORKER_FAILED')
    assert.match(error.message, /退出码 1/u)
    assert.match(error.message, /boom/u)
    return true
  },
)

// Unparseable output is a failure, never a silent success.
assert.throws(() => parseOutput('{not json', '', 0), (error) => error.code === 'WORKER_FAILED')

// --- window rows ------------------------------------------------------------
assert.equal(
  describeWindow({ handle: 11, title: 'README - Code', process: 'Code', pid: 300, width: 1000, height: 700 }),
  '[11] README - Code (Code, pid 300) 1000x700',
)
assert.match(
  describeWindow({ handle: 0, title: 'x', process: '', pid: 1, width: 1, height: 1 }),
  /unknown/u,
  'a missing process name reads as unknown',
)
assert.match(
  describeWindow({ handle: 0, title: '', process: 'Code', pid: 1, width: 1, height: 1 }),
  /无标题/u,
  'an untitled window still renders a readable row',
)

// --- wiring: two tools, each owned by an effect ------------------------------
/** A minimal Cordis-like context that records tool definitions. */
function fakeContext() {
  const tools = []
  const effects = []
  const ctx = {
    effect(fn) {
      effects.push(fn)
      return fn()
    },
    tools: {
      register(definition) {
        tools.push(definition)
        return () => {}
      },
    },
    get: () => undefined,
  }
  return { ctx, tools, effects }
}

assert.equal(Config['~standard'].version, 1, 'config uses the Standard Schema protocol')
assert.equal(Config['~standard'].validate(undefined).value.timeoutMs, 20000, 'defaults apply')
assert.equal(Config['~standard'].validate({ timeoutMs: 30000 }).value.timeoutMs, 30000)
assert.ok(Config['~standard'].validate({ timeout: 5 }).issues, 'unknown keys are rejected')
{
  const { ctx, tools, effects } = fakeContext()
  apply(ctx, {})
  assert.deepEqual(tools.map((tool) => tool.name), ['list_windows', 'capture_window'])
  assert.equal(effects.length, 2, 'both registrations are owned effects')
  assert.equal(tools[1].isConcurrencySafe(), false, 'captures never run concurrently')
}

console.log('window-capture: all checks passed')