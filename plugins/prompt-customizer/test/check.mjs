/**
 * Repo-level entry for prompt-customizer's checks.
 *
 * `core.test.js` already covers the pure override/section helpers; this file
 * also covers the preferences layer this plugin now owns (validation, the file
 * round-trip, and the loopback trust rule), so `scripts/test.mjs` exercises the
 * whole plugin rather than skipping it.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  isTrustedRequest,
  normalizePreferences,
  readPreferences,
  resolveConfigPath,
  writePreferences,
} from '../index.js'
import { DEFAULTS, validateOverrides, installOverrides, SECTIONS } from '../core.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${name}`)
}

/** Run the exported Standard Schema validator the way dsh does. */
const validate = value => Config['~standard'].validate(value)

check('an absent config yields null overrides (inherit everything)', () => {
  const result = validate(undefined)
  assert.deepEqual(result.value.overrides, { ...DEFAULTS })
})

check('unknown keys are rejected', () => {
  assert.ok(Array.isArray(validate({ nope: 1 }).issues))
})

check('a non-string override is rejected', () => {
  assert.ok(Array.isArray(validate({ overrides: { identity: 5 } }).issues))
})

check('valid overrides pass through', () => {
  const result = validate({ overrides: { identity: 'hi', prefix: null, suffix: '' } })
  assert.deepEqual(result.value.overrides, { identity: 'hi', prefix: null, suffix: '' })
})

check('validateOverrides keeps defaults for omitted keys', () => {
  assert.deepEqual(validateOverrides({ identity: 'x' }), { identity: 'x', prefix: null, suffix: null })
})

check('normalizePreferences degrades a broken stored file', () => {
  assert.deepEqual(normalizePreferences(null).overrides, { ...DEFAULTS })
  assert.deepEqual(normalizePreferences({ overrides: { identity: 5 } }).overrides, { ...DEFAULTS })
})

check('resolveConfigPath honours DSH_HOME', () => {
  assert.equal(resolveConfigPath({ DSH_HOME: 'C:/x' }), join('C:/x', 'prompt-customizer', 'settings.json'))
})

check('preferences survive a write/read round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'))
  const file = join(dir, 'nested', 'settings.json')
  try {
    const saved = { overrides: { identity: 'id', prefix: 'pre', suffix: null } }
    writePreferences(file, saved)
    assert.deepEqual(readPreferences(file), saved)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a missing file reads as defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pc-'))
  try {
    assert.deepEqual(readPreferences(join(dir, 'absent.json')), { overrides: { ...DEFAULTS } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('only loopback same-origin requests are trusted', () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h' })), true)
  assert.equal(isTrustedRequest(request('10.0.0.5', { host: 'h' })), false)
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h', origin: 'http://evil.test' })), false)
  assert.equal(isTrustedRequest(request('127.0.0.1', {})), false)
})

check('installOverrides registers exactly the non-null sections and undoes itself', () => {
  const registered = []
  const prompt = {
    getSectionOrder: name => 1,
    section: (definition) => { registered.push(definition); return () => registered.pop() },
  }
  const dispose = installOverrides(prompt, { identity: 'id', prefix: null, suffix: 'suf' })
  assert.equal(registered.length, 2)
  assert.deepEqual(registered.map(s => s.name).sort(), SECTIONS.filter(([key]) => key !== 'prefix').map(([, name]) => name).sort())
  dispose()
  assert.equal(registered.length, 0)
})

check('installOverrides rolls back when a later section throws', () => {
  const registered = []
  const prompt = {
    getSectionOrder: name => 1,
    section: (definition) => {
      if (definition.name.includes('suffix')) throw new Error('boom')
      registered.push(definition)
      return () => registered.pop()
    },
  }
  assert.throws(() => installOverrides(prompt, { identity: 'id', prefix: null, suffix: 'suf' }), /boom/)
  assert.equal(registered.length, 0, 'the first section must be disposed on failure')
})

console.log(`\n${checks} checks passed`)
