/**
 * Tests for the user-editable marker list.
 *
 * The stored entry IS the matcher: no tag-name derivation, no bracket
 * normalisation. Anything the user saves is matched literally, so markers that
 * are not tags (`【思考】`, `THINKING:`, `<<think>>`) behave like `<thinking>`.
 */
import assert from 'node:assert/strict'
import {
  DEFAULT_MARKERS_TEXT,
  MAX_MARKER_LENGTH,
  closingFor,
  compileMarkers,
  splitMarkerEntry,
  safeCompileMarkers,
  validateMarker,
  validateMarkerList,
} from '../core.js'
import { createBlockParser } from '../guard.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${name}`)
}

check('an entry is stored exactly as written', () => {
  assert.equal(validateMarker('<thinking>'), '<thinking>')
  assert.equal(validateMarker('  <thinking>  '), '<thinking>')
  assert.equal(validateMarker('【思考】'), '【思考】')
  assert.equal(validateMarker('THINKING:'), 'THINKING:')
})

check('non-tag markers are accepted and compile without a closing text', () => {
  const markers = compileMarkers(['【思考】', 'THINKING:', '<<think>>'])
  assert.deepEqual(markers.map((m) => m.open), ['【思考】', 'THINKING:', '<<think>>'])
  assert.deepEqual(markers.map((m) => m.close), [undefined, undefined, undefined])
})

check('a plain paired tag yields its closing text', () => {
  assert.equal(closingFor('<thinking>'), '</thinking>')
  assert.equal(closingFor('<thought>'), '</thought>')
  assert.equal(closingFor('<compacted-summary>'), '</compacted-summary>')
})

check('a tag with attributes derives its bare closing tag', () => {
  // Attributes only ever appear on the opening tag, so the close is the name.
  assert.equal(closingFor('<thinking type="x">'), '</thinking>')
  assert.equal(closingFor('<a.b:c_d data-y=1>'), '</a.b:c_d>')
  assert.equal(closingFor('<thinking >'), '</thinking>')
})

check('an unpaired or non-tag entry yields no closing text', () => {
  for (const entry of ['thinking', '<thinking', 'thinking>', '<>', '【思考】', '<<x>>']) {
    assert.equal(closingFor(entry), undefined, entry)
  }
})

check('an explicit closing marker is accepted for a non-tag entry', () => {
  assert.deepEqual(splitMarkerEntry('【思考】 => 【/思考】'), { open: '【思考】', close: '【/思考】' })
  assert.deepEqual(splitMarkerEntry('<thinking>'), { open: '<thinking>', close: '</thinking>' })
  assert.deepEqual(splitMarkerEntry('【思考】'), { open: '【思考】', close: undefined })
})

check('a marker without a closing text never reclaims the whole block', () => {
  // Swallowing an unclosed body would leave the turn with no visible text at all,
  // so such an entry stays inert until the user supplies "=> close".
  const inert = createBlockParser(compileMarkers(['【思考】']))
  assert.deepEqual(inert.push('【思考】body'), [{ kind: 'text', text: '【思考】body' }])

  const active = createBlockParser(compileMarkers(['【思考】 => 【/思考】']))
  assert.deepEqual(active.push('【思考】body【/思考】answer'), [
    { kind: 'reasoning', text: 'body' },
    { kind: 'text', text: 'answer' },
  ])
})

check('entries are de-duplicated by exact text, case-sensitively', () => {
  const markers = compileMarkers(['<thinking>', '<thinking>', '<Thinking>'])
  assert.deepEqual(markers.map((m) => m.open), ['<thinking>', '<Thinking>'])
})

check('empty and oversized entries are rejected', () => {
  assert.throws(() => validateMarker(''), /must not be empty/)
  assert.throws(() => validateMarker('   '), /must not be empty/)
  assert.throws(() => validateMarker(42), /must be a string/)
  assert.throws(() => validateMarker('x'.repeat(MAX_MARKER_LENGTH + 1)), /at most/)
})

check('the shipped defaults cover the two observed thinking tags', () => {
  assert.deepEqual([...DEFAULT_MARKERS_TEXT], ['<thinking>', '<thought>'])
})

check('the defaults do not claim checkpoint tags', () => {
  const compiled = compileMarkers(DEFAULT_MARKERS_TEXT).map((m) => m.open)
  assert.ok(!compiled.includes('<analysis>'))
  assert.ok(!compiled.includes('<summary>'))
})

check('validateMarkerList trims, de-duplicates and rejects an empty list', () => {
  assert.deepEqual(validateMarkerList([' <thinking> ', '<thinking>', '【思考】']), ['<thinking>', '【思考】'])
  assert.throws(() => validateMarkerList([]), /at least one marker/)
  assert.throws(() => validateMarkerList('thinking'), /must be a list/)
})

check('the list has no arbitrary length cap', () => {
  // Cost of one more marker is one string comparison per delta, so there is no
  // count worth rejecting. Only the per-entry length is bounded (buffer hold).
  const many = Array.from({ length: 200 }, (_, i) => `<m${i}>`)
  assert.equal(validateMarkerList(many).length, 200)
})

check('a closing tag is rejected instead of stored as a dead matcher', () => {
  assert.throws(() => validateMarker('</thinking>'), /opening marker/)
})

check('a broken stored list falls back to the defaults instead of throwing', () => {
  assert.deepEqual(safeCompileMarkers(['']).map((m) => m.open), [...DEFAULT_MARKERS_TEXT])
  assert.deepEqual(safeCompileMarkers(undefined).map((m) => m.open), [...DEFAULT_MARKERS_TEXT])
  assert.deepEqual(safeCompileMarkers([]).map((m) => m.open), [...DEFAULT_MARKERS_TEXT])
})

console.log(`\n${checks} checks passed`)
