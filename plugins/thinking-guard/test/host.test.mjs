/**
 * Host-side checks for the plugin-owned preferences: validation, the file
 * round-trip, and the loopback trust rule. No Harness runtime involved.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  Config,
  DEFAULTS,
  normalizePreferences,
  readPreferences,
  resolveConfigPath,
  writePreferences,
  isTrustedRequest,
} from '../index.js'
import { DEFAULT_MARKERS_TEXT } from '../core.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${name}`)
}

/** Run the exported Standard Schema validator the way dsh does. */
function validate(value) {
  return Config['~standard'].validate(value)
}

check('an absent config yields the shipped defaults', () => {
  const result = validate(undefined)
  assert.deepEqual(result.value.markers, [...DEFAULT_MARKERS_TEXT])
  assert.equal(result.value.enabled, true)
  assert.equal(result.value.keepMarkers, false)
})

check('unknown keys are rejected', () => {
  const result = validate({ nope: 1 })
  assert.ok(Array.isArray(result.issues))
  assert.match(result.issues[0].message, /unknown config key/)
})

check('a bad marker list is reported, not silently accepted', () => {
  assert.ok(Array.isArray(validate({ markers: [] }).issues))
  assert.ok(Array.isArray(validate({ markers: [''] }).issues))
  assert.ok(Array.isArray(validate({ markers: '</thinking>' }).issues))
})

check('valid values pass through, defaults fill the rest', () => {
  const result = validate({ markers: ['<thinking>', '【思考】 => 【/思考】'], keepMarkers: true })
  assert.deepEqual(result.value.markers, ['<thinking>', '【思考】 => 【/思考】'])
  assert.equal(result.value.keepMarkers, true)
  assert.equal(result.value.enabled, true)
})

check('normalizePreferences coerces a broken stored file to defaults', () => {
  assert.deepEqual(normalizePreferences(null).markers, [...DEFAULT_MARKERS_TEXT])
  assert.deepEqual(normalizePreferences({ markers: [] }).markers, [...DEFAULT_MARKERS_TEXT])
  assert.equal(normalizePreferences({ enabled: 'yes' }).enabled, true)
  assert.equal(normalizePreferences({ keepMarkers: 'yes' }).keepMarkers, false)
})

check('resolveConfigPath honours DSH_HOME', () => {
  assert.equal(resolveConfigPath({ DSH_HOME: 'C:/x' }), join('C:/x', 'thinking-guard', 'settings.json'))
})

check('preferences survive a write/read round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'))
  const file = join(dir, 'nested', 'settings.json')
  try {
    const saved = { markers: ['<thinking>', '【思考】 => 【/思考】'], enabled: false, keepMarkers: true, note: 'n' }
    writePreferences(file, saved)
    assert.deepEqual(readPreferences(file), saved)
    assert.match(readFileSync(file, 'utf8'), /"keepMarkers": true/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a missing or corrupt file reads as defaults', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'))
  try {
    assert.deepEqual(readPreferences(join(dir, 'absent.json')), { ...DEFAULTS })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('only loopback same-origin requests are trusted', () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h' })), true)
  assert.equal(isTrustedRequest(request('::1', { host: 'h' })), true)
  assert.equal(isTrustedRequest(request('10.0.0.5', { host: 'h' })), false, 'non-loopback must be refused')
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h', 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h', origin: 'http://evil.test' })), false)
  assert.equal(isTrustedRequest(request('127.0.0.1', { host: 'h', origin: 'http://h' })), true)
  assert.equal(isTrustedRequest(request('127.0.0.1', {})), false, 'a missing host must be refused')
})

console.log(`\n${checks} checks passed`)
