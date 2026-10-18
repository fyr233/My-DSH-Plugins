/**
 * Check the input-control plugin's worker protocol handling.
 * Live injection needs the Medium-integrity subprocess path, so this covers the
 * parse boundary and the failure vocabulary the tools rely on.
 * Run: node input-control/test/check.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config, parseOutput, InputError } from '../index.js'

// A successful action reports what it did, so the model can verify afterwards.
const ok = parseOutput(
  '{"ok":true,"op":"type","title":"Notepad","handle":10,"actions":18,"scope":"window","cursorAfter":{"x":5,"y":6}}\n',
  '', 0,
)
assert.equal(ok.ok, true)
assert.equal(ok.actions, 18)
assert.equal(ok.cursorAfter.x, 5)

// The focus guard is the most important failure: it must name the fix.
assert.throws(
  () => parseOutput(
    '{"ok":false,"code":"NOT_FOREGROUND","message":"目标窗口不在前台，键盘输入会落到当前前台窗口。传 activate=true 让我先激活它"}',
    '', 0,
  ),
  (error) => {
    assert.ok(error instanceof InputError)
    assert.equal(error.code, 'NOT_FOREGROUND')
    assert.match(error.message, /activate=true/u)
    return true
  },
)

// A refused injection (UIPI / wrong desktop) keeps its own code.
assert.throws(
  () => parseOutput('{"ok":false,"code":"INJECT_FAILED","message":"SetCursorPos 被系统拒绝"}', '', 0),
  (error) => error.code === 'INJECT_FAILED' && /被系统拒绝/u.test(error.message),
)

// Missing target is a caller error, distinct from an injection failure.
assert.throws(
  () => parseOutput('{"ok":false,"code":"BAD_ARGS","message":"keys 为空"}', '', 0),
  (error) => error.code === 'BAD_ARGS',
)

// No result line: the worker died, and its stderr must survive the report.
assert.throws(
  () => parseOutput('', 'Error: unknown type', 1),
  (error) => {
    assert.equal(error.code, 'WORKER_FAILED')
    assert.match(error.message, /退出码 1/u)
    assert.match(error.message, /unknown type/u)
    return true
  },
)

// Garbage is never treated as success.
assert.throws(() => parseOutput('garbage', '', 0), (error) => error.code === 'WORKER_FAILED')

// --- wiring: six tools, each owned by an effect ------------------------------
{
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
  apply(ctx, {})
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ['click', 'drag', 'move_mouse', 'press_keys', 'scroll', 'type_text'],
  )
  assert.equal(effects.length, 6, 'every registration is an owned effect')
  assert.equal(tools.find((tool) => tool.name === 'move_mouse').isConcurrencySafe(), true)
  assert.equal(tools.find((tool) => tool.name === 'click').isConcurrencySafe(), false)
  assert.equal(Config['~standard'].version, 1, 'config uses the Standard Schema protocol')
  assert.equal(Config['~standard'].validate({ timeoutMs: 15000 }).value.timeoutMs, 15000)
  assert.ok(Config['~standard'].validate({ nope: true }).issues, 'unknown keys are rejected')
}

console.log('input-control: all checks passed')
