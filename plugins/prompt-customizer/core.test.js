import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, validateOverrides, installOverrides } from './core.js'
test('defaults, blanks and literal template text remain distinct', () => {
  assert.deepEqual(validateOverrides({}), DEFAULTS)
  assert.deepEqual(validateOverrides({ identity: '', prefix: '{{model}}' }), { identity: '', prefix: '{{model}}', suffix: null })
  for (const value of [null, [], { unknown: '' }, { identity: false }, { suffix: 'x'.repeat(32001) }]) assert.throws(() => validateOverrides(value))
})
test('reject prototype property names without changing defaults', () => {
  for (const key of ['constructor', 'toString', '__proto__']) {
    assert.throws(() => validateOverrides(JSON.parse(`{"${key}": "unexpected"}`)), /Unknown override/)
  }
  assert.deepEqual(validateOverrides({}), { identity: null, prefix: null, suffix: null })
})
test('accept the exact length limit and reject one character beyond it', () => {
  assert.equal(validateOverrides({ prefix: 'x'.repeat(32000) }).prefix.length, 32000)
  assert.throws(() => validateOverrides({ prefix: 'x'.repeat(32001) }), /32000/)
})
test('shadow exact sections, preserve ordering, restore defaults, dispose idempotently', () => {
  const entries = new Map()
  const prompt = { getSectionOrder: name => ({ HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_PREFIX: 0, DEPLOYMENT_PERSONA_SUFFIX: 10200 })[name], section(s) { entries.set(s.name,s); return () => entries.delete(s.name) } }
  const dispose = installOverrides(prompt, { identity: '', prefix: '{{unknown}}', suffix: 'tail' })
  assert.equal(entries.size,3)
  assert.equal(entries.get('harness:identity').text, '')
  assert.equal(entries.get('deployment:persona-prefix').interpolate,false)
  assert.equal(entries.get('deployment:persona-suffix').order,10200)
  dispose(); dispose(); assert.equal(entries.size,0)
  installOverrides(prompt, DEFAULTS); assert.equal(entries.size,0)
})
test('duplicate collision rolls back only plugin-owned entries', () => {
  const entries = new Map([['deployment:persona-prefix', 'owned elsewhere']])
  const prompt = { getSectionOrder: () => 0, section(s) { if (entries.has(s.name)) throw Error('duplicate'); entries.set(s.name,s); return () => entries.delete(s.name) } }
  assert.throws(() => installOverrides(prompt, { identity: 'new', prefix: 'new', suffix: 'new' }), /duplicate/)
  assert.deepEqual([...entries], [['deployment:persona-prefix','owned elsewhere']])
})
