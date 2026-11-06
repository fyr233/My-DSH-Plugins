import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pickMemberModel, pickSelectedRoute, planTeammateModelChange, planTeammateRoute, sameRoute } from '../route.js'
import { withTeammateAgentOptions, currentTeammateAgentOptions } from '../als.js'
import { apply as applyBridge } from '../bridge/index.js'
import { createHostResolvers, loadHostPackage, resolveHostPackage } from '../host.js'
import { traceableProxy } from './support/cordis-traps.mjs'

let passed = 0
const failures = []
const pending = []

/**
 * Run one named case and collect failures instead of aborting the suite.
 * @param name - case name.
 * @param fn - the case; an async case is awaited before the report.
 */
function test(name, fn) {
  try {
    const result = fn()
    if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
      // An unawaited async case would both miscount and hide its own failure.
      pending.push(result.then(
        () => { passed += 1 },
        (error) => { failures.push(`${name}\n    ${error.message.split('\n').join('\n    ')}`) },
      ))
      return
    }
    passed += 1
  } catch (error) {
    failures.push(`${name}\n    ${error.message.split('\n').join('\n    ')}`)
  }
}

const LEAD = { provider: 'my-provider', model: 'lead-model', reasoningEffort: 'medium' }
const ENABLED = (routes) => ({
  current: () => ({ enabled: true, allowedModels: routes }),
})
const ROUTES = [
  { provider: 'my-provider', model: 'lead-model' },
  { provider: 'my-provider', model: 'teammate-model' },
]

// --- route planning -------------------------------------------------------

test('no arguments inherits everything', () => {
  assert.equal(planTeammateRoute(ENABLED(ROUTES), LEAD, {}), undefined)
})

test('model only keeps the Lead provider', () => {
  const plan = planTeammateRoute(ENABLED(ROUTES), LEAD, { model: 'teammate-model' })
  assert.equal(plan.provider, 'my-provider')
  assert.equal(plan.model, 'teammate-model')
  assert.deepEqual(plan.agentOptions, { model: 'teammate-model' })
})

test('provider plus model sends both', () => {
  const plan = planTeammateRoute(ENABLED(ROUTES), LEAD, { provider: 'my-provider', model: 'teammate-model' })
  assert.deepEqual(plan.agentOptions, { provider: 'my-provider', model: 'teammate-model' })
})

test('effort alone keeps the inherited route', () => {
  const plan = planTeammateRoute(ENABLED(ROUTES), LEAD, { reasoning_effort: 'high' })
  assert.deepEqual(plan.agentOptions, { reasoningEffort: 'high' })
  assert.equal(plan.model, LEAD.model)
})

test('provider without model is rejected instead of dropped', () => {
  assert.throws(
    () => planTeammateRoute(ENABLED(ROUTES), LEAD, { provider: 'my-provider' }),
    /`provider` requires `model`/,
  )
})

test('route outside the whitelist is rejected with the allowed list', () => {
  assert.throws(
    () => planTeammateRoute(ENABLED(ROUTES), LEAD, { model: 'other-model' }),
    /"my-provider\/other-model" is not allowed; allowed routes: my-provider\/lead-model, my-provider\/teammate-model/,
  )
})

test('disabled selection rejects any model', () => {
  const settings = { current: () => ({ enabled: false, allowedModels: ROUTES }) }
  assert.throws(() => planTeammateRoute(settings, LEAD, { model: 'teammate-model' }), /disabled in Settings/)
})

test('effort-only is still checked against the whitelist', () => {
  const outside = { provider: 'my-provider', model: 'other-model' }
  assert.throws(
    () => planTeammateRoute(ENABLED(ROUTES), outside, { reasoning_effort: 'high' }),
    /"my-provider\/other-model" is not allowed; allowed routes/,
  )
})

test('disabled selection blocks an effort-only spawn', () => {
  const settings = { current: () => ({ enabled: false, allowedModels: ROUTES }) }
  assert.throws(() => planTeammateRoute(settings, LEAD, { reasoning_effort: 'high' }), /disabled in Settings/)
})

test('absent service allows any route', () => {
  const plan = planTeammateRoute(undefined, LEAD, { model: 'other-model' })
  assert.deepEqual(plan.agentOptions, { model: 'other-model' })
})

test('a broken service surfaces its own reason', () => {
  const settings = { current: () => { throw new Error('enabled subagent model selection requires at least one allowed model') } }
  assert.throws(
    () => planTeammateRoute(settings, LEAD, { model: 'teammate-model' }),
    /misconfigured \(enabled subagent model selection requires at least one allowed model\)/,
  )
})

test('no resolvable parent provider is a clear error, not a whitelist miss', () => {
  assert.throws(
    () => planTeammateRoute(ENABLED(ROUTES), { model: 'teammate-model' }, { model: 'teammate-model' }),
    /cannot resolve an effective provider/,
  )
})

// --- async local storage --------------------------------------------------

test('tag is visible only inside its own run', () => {
  assert.equal(currentTeammateAgentOptions(), undefined)
  const inner = withTeammateAgentOptions({ model: 'x' }, () => currentTeammateAgentOptions())
  assert.deepEqual(inner, { model: 'x' })
  assert.equal(currentTeammateAgentOptions(), undefined)
})

test('untagged spawn runs without a store', () => {
  const seen = withTeammateAgentOptions(undefined, () => currentTeammateAgentOptions())
  assert.equal(seen, undefined)
})

// --- bridge ---------------------------------------------------------------

/** Build a fake host context whose activation seam behaves like a cordis Service behind a traceable proxy. */
function fakeHost() {
  const calls = []
  const disposers = []
  const proto = {
    startActivation(spec) {
      calls.push(spec)
      return Promise.resolve({ childId: 'child' })
    },
  }
  const raw = Object.create(proto)
  const subagents = traceableProxy(raw)
  const ctx = {
    subagents,
    // cordis calls the effect body to obtain its disposer; mirror that here.
    effect: (fn) => { disposers.push(fn()) },
  }
  return { ctx, calls, subagents, raw, proto, dispose: () => disposers.forEach((fn) => fn()) }
}

test('bridge injects the tagged options into the activation request', async () => {
  const host = fakeHost()
  const original = host.subagents.startActivation
  applyBridge(host.ctx)
  assert.notEqual(host.subagents.startActivation, original)

  await withTeammateAgentOptions({ model: 'teammate-model' }, () =>
    host.subagents.startActivation({ provider: 'spawn', request: { prompt: [], parent: {} } }))

  assert.equal(host.calls.length, 1)
  assert.deepEqual(host.calls[0].request.agentOptions, { model: 'teammate-model' })
  assert.deepEqual(host.calls[0].request.prompt, [])
})

test('bridge leaves untagged spawns byte-identical', async () => {
  const host = fakeHost()
  applyBridge(host.ctx)
  const spec = { provider: 'spawn', request: { prompt: [{ type: 'text', text: 'hi' }], parent: {} } }
  await host.subagents.startActivation(spec)
  assert.equal(host.calls[0], spec)
  assert.equal(host.calls[0].request.agentOptions, undefined)
})

test('bridge dispose removes the own property and reveals the prototype method', () => {
  const host = fakeHost()
  applyBridge(host.ctx)
  assert.equal(Object.hasOwn(host.raw, 'startActivation'), true, 'the wrapper is stored on the raw instance')
  host.dispose()
  assert.equal(Object.hasOwn(host.raw, 'startActivation'), false, 'the own property is removed')
  assert.equal(host.raw.startActivation, host.proto.startActivation, 'the prototype method is visible again')
})

test('bridge dispose is idempotent across a reload', () => {
  const host = fakeHost()
  applyBridge(host.ctx)
  applyBridge(host.ctx)
  host.dispose()
  assert.equal(Object.hasOwn(host.raw, 'startActivation'), false, 'one teardown restores the prototype method')
  host.dispose()
  assert.equal(Object.hasOwn(host.raw, 'startActivation'), false, 'a second teardown is a no-op')
  assert.equal(host.raw.startActivation, host.proto.startActivation)
})

test('bridge still injects after a reload', async () => {
  const host = fakeHost()
  applyBridge(host.ctx)
  applyBridge(host.ctx)
  await withTeammateAgentOptions({ model: 'teammate-model' }, () =>
    host.subagents.startActivation({ provider: 'spawn', request: { prompt: [], parent: {} } }))
  assert.equal(host.calls.length, 1, 'stacked wrappers must not call the seam twice')
  assert.deepEqual(host.calls[0].request.agentOptions, { model: 'teammate-model' })
})

test('bridge rejects a missing activation seam', () => {
  assert.throws(() => applyBridge({ subagents: {}, effect: () => {} }), /startActivation is missing/)
})

// --- host package resolution ----------------------------------------------

/**
 * Build a throwaway Electron-style resources tree containing one stub package.
 * Layout mirrors the installed application: `app.asar` holding a `dsh` package
 * directory that carries the Harness `node_modules`.
 */
function fakeAppResources() {
  const root = mkdtempSync(join(tmpdir(), 'agent-team-model-host-'))
  const base = join(root, 'app.asar', 'dsh')
  const directory = join(base, 'node_modules', '@stub', 'pkg')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(base, 'package.json'), '{"name":"dsh"}\n')
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: '@stub/pkg',
    version: '1.0.0',
    type: 'module',
    exports: { '.': { default: './index.js' } },
  }))
  writeFileSync(join(directory, 'index.js'), "export const marker = 'stub-host-package'\n")
  return { root, chain: createHostResolvers(root), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

test('host resolution reaches the application archive', () => {
  const app = fakeAppResources()
  try {
    const resolved = resolveHostPackage('@stub/pkg', app.chain)
    assert.match(resolved, /app\.asar[\\/]dsh[\\/]node_modules[\\/]@stub[\\/]pkg[\\/]index\.js$/)
  } finally {
    app.cleanup()
  }
})

test('host loader imports the resolved file and keeps its named exports', async () => {
  const app = fakeAppResources()
  try {
    const namespace = await loadHostPackage('@stub/pkg', app.chain)
    assert.equal(namespace.marker, 'stub-host-package')
  } finally {
    app.cleanup()
  }
})

test('an unresolvable host package names the package and the requirement', () => {
  assert.throws(
    () => resolveHostPackage('@deepseek-ai/definitely-not-installed', createHostResolvers(undefined)),
    /cannot resolve the host package "@deepseek-ai\/definitely-not-installed"; this bundle must run inside the Harness desktop app/,
  )
})

// --- changing an existing member's route --------------------------------

const MEMBER = { provider: 'my-provider', model: 'lead-model', reasoningEffort: 'medium' }
// Local policy fixture: the suite's shared ROUTES list describes a different
// provider, so these cases keep their own to stay self-contained.
const MODEL_ROUTES = [
  { provider: 'my-provider', model: 'lead-model' },
  { provider: 'my-provider', model: 'teammate-model' },
]
const ENABLED_MODEL = (routes) => ({ current: () => ({ enabled: true, allowedModels: routes }) })

test('a model-only change keeps the member provider and drops the inherited effort', () => {
  const next = planTeammateModelChange(ENABLED_MODEL(MODEL_ROUTES), MEMBER, { model: 'teammate-model' })
  assert.deepEqual(next, { provider: 'my-provider', model: 'teammate-model' })
})

test('an effort-only change keeps the member route', () => {
  const next = planTeammateModelChange(ENABLED_MODEL(MODEL_ROUTES), MEMBER, { reasoning_effort: 'high' })
  assert.deepEqual(next, { provider: 'my-provider', model: 'lead-model', reasoningEffort: 'high' })
})

test('provider plus model sends both', () => {
  const next = planTeammateModelChange(ENABLED_MODEL(MODEL_ROUTES), MEMBER, { provider: 'my-provider', model: 'teammate-model' })
  assert.deepEqual(next, { provider: 'my-provider', model: 'teammate-model' })
})

test('a change with no argument is rejected', () => {
  assert.throws(
    () => planTeammateModelChange(ENABLED_MODEL(MODEL_ROUTES), MEMBER, {}),
    /pass at least one of `model`, `provider` or `reasoning_effort`/,
  )
})

test('a provider without a model is rejected', () => {
  assert.throws(
    () => planTeammateModelChange(ENABLED_MODEL(MODEL_ROUTES), MEMBER, { provider: 'my-provider' }),
    /`provider` requires `model`/,
  )
})

test('a change outside the whitelist is rejected', () => {
  assert.throws(
    () => planTeammateModelChange(ENABLED_MODEL(MODEL_ROUTES), MEMBER, { model: 'other-model' }),
    /"my-provider\/other-model" is not allowed; allowed routes/,
  )
})

test('a disabled selection blocks a member change', () => {
  const settings = { current: () => ({ enabled: false, allowedModels: ROUTES }) }
  assert.throws(() => planTeammateModelChange(settings, MEMBER, { model: 'teammate-model' }), /disabled in Settings/)
})

test('an unresolvable member route is reported, not guessed', () => {
  assert.throws(
    () => planTeammateModelChange(ENABLED(ROUTES), {}, { reasoning_effort: 'high' }),
    /cannot resolve an effective provider and model/,
  )
})

test('a model-only change needs a provider when the member route is unknown', () => {
  // An inactive member with no readable projection has no route to inherit from.
  // Guessing the Lead's provider would silently route the member elsewhere, so
  // the planner refuses instead.
  assert.throws(
    () => planTeammateModelChange(ENABLED(ROUTES), {}, { model: 'teammate-model' }),
    /cannot resolve an effective provider and model/,
  )
  // Supplying both is the supported path.
  const plan = planTeammateModelChange(ENABLED(ROUTES), {}, { provider: 'my-provider', model: 'teammate-model' })
  assert.deepEqual(plan, { provider: 'my-provider', model: 'teammate-model' })
})

test('the pending selection wins over the last used one', () => {
  const projection = { lastUsed: { provider: 'my-provider', model: 'old' }, pending: { provider: 'my-provider', model: 'new' } }
  assert.equal(pickSelectedRoute(projection).model, 'new')
  assert.equal(pickSelectedRoute({ lastUsed: { provider: 'my-provider', model: 'old' }, pending: null }).model, 'old')
  assert.equal(pickSelectedRoute({ lastUsed: null, pending: null }), undefined)
  assert.equal(pickSelectedRoute(undefined), undefined)
})

test('a member model never falls back to another member route', () => {
  assert.equal(pickMemberModel({ lastUsed: null, pending: null }, { model: 'live-model' }), 'live-model')
  assert.equal(pickMemberModel(undefined, undefined), undefined)
  assert.equal(pickMemberModel({ lastUsed: { provider: 'my-provider', model: 'chosen' }, pending: null }, { model: 'stale' }), 'chosen')
})

test('the same route compares provider, model and effort', () => {
  const a = { provider: 'my-provider', model: 'm', reasoningEffort: 'high' }
  assert.equal(sameRoute(a, { provider: 'my-provider', model: 'm', reasoningEffort: 'high' }), true)
  assert.equal(sameRoute(a, { provider: 'my-provider', model: 'm' }), false)
  assert.equal(sameRoute(a, { provider: 'my-provider', model: 'other', reasoningEffort: 'high' }), false)
  assert.equal(sameRoute(undefined, a), false)
})

// --- output contract ------------------------------------------------------

test('the member row schema declares every field the tools emit', () => {
  // `tool/index.js` cannot be imported here (top-level await + Host packages), so
  // this pins the declared fields textually. The schema sets
  // `additionalProperties: false`, which makes an undeclared field a hard output
  // validation failure at runtime — exactly the bug this guards.
  const source = readFileSync(new URL('../tool/index.js', import.meta.url), 'utf8')
  const start = source.indexOf('const MEMBER_VIEW_SCHEMA')
  const end = source.indexOf('/** Expose the member name', start)
  assert.ok(start >= 0 && end > start, 'MEMBER_VIEW_SCHEMA block is present')
  const block = source.slice(start, end)
  for (const field of [
    'target', 'role', 'status', 'description',
    'provider', 'context', 'model', 'reasoningEffort', 'diagnostics',
  ]) {
    assert.match(block, new RegExp(`\\b${field}:`), `MEMBER_VIEW_SCHEMA must declare "${field}"`)
  }
})

// --- report ---------------------------------------------------------------

await Promise.all(pending)
const total = passed + failures.length
if (failures.length > 0) {
  console.error(`\n${failures.length} of ${total} failed:\n`)
  for (const failure of failures) console.error(`  ✗ ${failure}\n`)
  process.exit(1)
}
console.log(`ok - ${total} checks passed`)
