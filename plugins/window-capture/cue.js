/**
 * A short cue after a successful capture, played from the Host process.
 *
 * The capture itself happens on the Host, so the confirmation must be audible
 * there too: with the Host and the browser on different machines, a cue played
 * in the page would tell the wrong person nothing, and the agent that asked for
 * the screenshot is the one that should know it happened.
 *
 * How the sound is produced (each alternative was measured and rejected):
 *
 * - A BEL written to stdout/stderr never reaches a device: the desktop app has
 *   no console.
 * - `powershell.exe -Command` plays a file but starts a process on every call
 *   and trips HIPS rules (火绒 "静默运行").
 * - `rundll32.exe <wav>,<export>` loads the WAV as a DLL and pops an error box.
 * - `SND_ASYNC` in this Host returns TRUE in 0 ms and plays nothing; the
 *   synchronous form blocks until the device drained the file and is audible.
 *
 * So Windows plays in-process through koffi — the FFI library dsh itself ships
 * (N-API, loads in Electron and Node alike) — calling `winmm!sndPlaySoundW`
 * synchronously. Linux uses `paplay`/`aplay`, macOS uses `afplay`; a platform
 * without a known player stays silent instead of failing the capture.
 *
 * The WAV is synthesized in memory and cached in the OS temp directory, so the
 * package carries no binary asset and no license question.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Two short notes, rising: "the shot was taken". */
const NOTES = [[1318, 0.09], [1760, 0.16]]

/**
 * Synthesize the cue as 16-bit mono PCM WAV at 22.05 kHz. Each note gets a 6 ms
 * fade in and a 60 ms fade out so no click is audible, and a 25 ms gap keeps
 * the two notes distinct.
 * @returns WAV file bytes.
 */
export function buildShotWav() {
  const rate = 22050
  const gapFrames = Math.round(0.025 * rate)
  const frames = NOTES.map(([, seconds]) => Math.round(seconds * rate))
  const total = frames.reduce((sum, count, index) => sum + count + (index < NOTES.length - 1 ? gapFrames : 0), 0)
  const data = Buffer.alloc(total * 2)
  let offset = 0
  NOTES.forEach(([hertz, seconds], index) => {
    for (let frame = 0; frame < frames[index]; frame += 1) {
      const time = frame / rate
      const envelope = Math.max(0, Math.min(Math.min(1, time / 0.006), Math.min(1, (seconds - time) / 0.06)))
      const value = Math.sin(2 * Math.PI * hertz * time) * envelope * 0.4
      data.writeInt16LE(Math.round(value * 32767), (offset + frame) * 2)
    }
    offset += frames[index]
    if (index < NOTES.length - 1) offset += gapFrames
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

/** Materialize the cue once per plugin load. */
export function shotSoundFile(state) {
  if (state.shotFile !== undefined && existsSync(state.shotFile)) return state.shotFile
  const dir = join(tmpdir(), 'dsh-window-capture')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'shot.wav')
  writeFileSync(path, buildShotWav())
  state.shotFile = path
  return path
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
 * Bind the Windows playback entry point once per plugin load.
 * @param state - cue state; caches the binding.
 * @param logger - optional `{ warn }` sink for the one diagnostic.
 * @param platform - `process.platform`.
 * @param execPath - `process.execPath`.
 * @param exists - file predicate, injectable for tests.
 * @returns the `sndPlaySoundW` binding, or undefined when unavailable.
 */
export function bindWindowsPlayer(state, logger, platform = process.platform, execPath = process.execPath, exists = existsSync) {
  if (platform !== 'win32') return undefined
  if (state.ffiTried) return state.ffi
  state.ffiTried = true
  try {
    const directory = findKoffi(execPath, exists)
    if (directory === undefined) {
      logger?.warn?.('window-capture: koffi was not found under the dsh installation; the capture cue stays silent')
      return undefined
    }
    const loader = createRequire(import.meta.url)
    const koffi = loader(join(directory, 'index.cjs'))
    const winmm = koffi.load('winmm.dll')
    // SND_FILENAME: the string is a file path. No SND_ASYNC on purpose — it
    // returns TRUE in 0 ms in this Host and plays nothing, while the synchronous
    // call blocks until the device drained the file and is audible. The cue is
    // ~0.3 s by design.
    const sndPlaySoundW = winmm.func('bool __stdcall sndPlaySoundW(str16 lpszSound, uint flags)')
    state.ffi = (file) => sndPlaySoundW(file, 0x00020000)
    return state.ffi
  } catch (error) {
    logger?.warn?.('window-capture: could not bind winmm: %s', String(error))
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
export function playerCommand(platform, file, hasPlayer = isExecutable) {
  if (platform === 'darwin') return { command: 'afplay', args: [file] }
  if (platform === 'linux') {
    if (hasPlayer('paplay')) return { command: 'paplay', args: [file] }
    if (hasPlayer('aplay')) return { command: 'aplay', args: ['-q', file] }
  }
  return undefined
}

/** Whether a bare command exists on PATH (Windows' `where` finds `.exe`/`.cmd` too). */
function isExecutable(name) {
  const probe = process.platform === 'win32' ? ['where', [name]] : ['which', [name]]
  try {
    const child = spawnSync(probe[0], probe[1], { stdio: 'ignore' })
    return child.status === 0
  } catch {
    return false
  }
}

/**
 * Play the capture cue. Never throws and never blocks the tool result for long:
 * the Windows path waits for the short cue, the other platforms spawn and
 * forget.
 * @param state - cue state.
 * @param logger - optional `{ warn }` sink.
 * @returns whether a cue was played.
 */
export function playShotCue(state, logger) {
  const file = shotSoundFile(state)
  if (process.platform === 'win32') {
    const play = bindWindowsPlayer(state, logger)
    if (play === undefined) return false
    try {
      return play(file) !== false
    } catch (error) {
      logger?.warn?.('window-capture: capture cue failed: %s', String(error))
      return false
    }
  }
  const command = playerCommand(process.platform, file)
  if (command === undefined) return false
  try {
    const child = spawn(command.command, command.args, { stdio: 'ignore', detached: true })
    child.unref()
    child.on('error', (error) => {
      logger?.warn?.('window-capture: could not start %s: %s', command.command, String(error))
    })
    return true
  } catch (error) {
    logger?.warn?.('window-capture: could not start %s: %s', command.command, String(error))
    return false
  }
}

/** The state the cue needs; exported so `apply` owns one instance. */
export function createCueState() {
  return { shotFile: undefined, ffi: undefined, ffiTried: false }
}

/** Whether a path is a regular file; used by tests. */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
