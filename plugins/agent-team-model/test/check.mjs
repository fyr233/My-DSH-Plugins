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

test('a model-only spawn does not forward the Lead effort', () => {
  // Omitting `reasoningEffort` from agentOptions is deliberate: the Host's
  // resolveChildAgentOptions drops the inherited effort whenever the route
  // changes, so the new model resolves its own default. Sending the Lead's
  // effort would silently pin the teammate to a level the new model may not
  // support. planTeammateModelChange has the mirror-image case; this is the
  // spawn-time half, which only deepEqual covered implicitly before.
  const plan = planTeammateRoute(ENABLED(ROUTES), { ...LEAD, reasoningEffort: 'medium' }, { model: 'teammate-model' })
  assert.equal('reasoningEffort' in plan.agentOptions, false)
  assert.equal(plan.reasoningEffort, undefined)
  // ...while an explicit effort is still forwarded verbatim.
  const withEffort = planTeammateRoute(ENABLED(ROUTES), LEAD, { model: 'teammate-model', reasoning_effort: 'high' })
  assert.equal(withEffort.agentOptions.reasoningEffort, 'high')
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

test('interleaved async spawns never see each other tag', async () => {
  // The real spawn chain awaits between tagging and startActivation, so two
  // spawns can interleave. Each must keep its own route; a shared store would
  // hand one member the other member's model with no error anywhere.
  const trace = []
  const hop = () => new Promise((resolve) => setTimeout(resolve, 1))

  const spawn = (label, options) => withTeammateAgentOptions(options, async () => {
    trace.push([label, 'before-1', currentTeammateAgentOptions()?.model])
    await hop()
    trace.push([label, 'after-1', currentTeammateAgentOptions()?.model])
    await hop()
    trace.push([label, 'after-2', currentTeammateAgentOptions()?.model])
  })

  await Promise.all([
    spawn('a', { model: 'model-a' }),
    spawn('b', { model: 'model-b' }),
    spawn('c', undefined),
  ])

  for (const [label, phase, seen] of trace) {
    const expected = label === 'a' ? 'model-a' : label === 'b' ? 'model-b' : undefined
    assert.equal(seen, expected, `${label}/${phase} saw ${String(seen)}`)
  }
  // The tag must not leak into the caller's context after all spawns settle.
  assert.equal(currentTeammateAgentOptions(), undefined)
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

test('tearing down a reloaded bridge disposer by disposer restores the prototype', () => {
  // Real cordis runs each effect's disposer separately, in reverse load order.
  // `host.dispose()` above fires them all at once, so it never proves that the
  // inner wrapper refuses to delete an outer wrapper's property.
  const host = fakeHost()
  const disposers = []
  const ctx = { ...host.ctx, effect: (fn) => { disposers.push(fn()) } }
  applyBridge(ctx)
  applyBridge(ctx)
  assert.equal(disposers.length, 2, 'each load registers its own effect')

  disposers[0]()
  assert.equal(Object.hasOwn(host.raw, 'startActivation'), true,
    'the first teardown must not remove the wrapper the second load installed')
  assert.notEqual(host.raw.startActivation, host.proto.startActivation)

  disposers[1]()
  assert.equal(Object.hasOwn(host.raw, 'startActivation'), false)
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

test('the team policy section is registered once, in plugin scope', () => {
  // systemPrompt.section() attaches its effect to the *calling* ctx. Registering
  // it on agent.ctx makes the section outlive the plugin, so a reinstall fails
  // with `prompt section "team:policy" is already registered in this scope` —
  // and that failure rolls back the whole patch layer, taking the disable of the
  // built-in tool with it. Observed on a real reinstall.
  const source = readFileSync(new URL('../tool/index.js', import.meta.url), 'utf8')
  const installStart = source.indexOf('function install(agent, ctx, config')
  const installEnd = source.indexOf('function apply(ctx, config = {})')
  assert.ok(installStart >= 0 && installEnd > installStart, 'install() and apply() are both present')

  const installBody = source.slice(installStart, installEnd)
  // Match a real call, not the prose in the comment that explains this rule.
  assert.equal(
    /scoped\.systemPrompt\.section\s*\(/.test(installBody), false,
    'install() must not register the policy section on agent scope',
  )

  const applyBody = source.slice(installEnd)
  const registrations = applyBody.match(/systemPrompt\.section\(/g) ?? []
  assert.equal(registrations.length, 1, 'apply() registers the policy section exactly once')
})

test('a stopped teammate gets a deferred route instead of an error', () => {
  // Requiring the member to be running was a design mistake: a stopped member has
  // no attached Session, so the call failed and the only workaround was to wake it
  // first - which then ran on the OLD route. The route is now recorded and applied
  // when the agent is created again.
  //
  // `tool/index.js` cannot be imported here, so this pins the arrangement
  // textually: no "has no Session to change" throw, a defer branch for the
  // non-live case, and the deferred route applied on agent creation.
  const source = readFileSync(new URL('../tool/index.js', import.meta.url), 'utf8')
  assert.equal(
    source.includes('has no Session to change'), false,
    'set_teammate_model must not refuse a stopped member any more',
  )
  assert.match(source, /if \(live === void 0\) seam\.defer\(/, 'the non-live branch records the route')
  // The route is written ONCE, by set_teammate_model or by the creation hook when
  // it differs. Afterwards the Session's own request header carries it, so nothing
  // needs to re-write it per step.
  assert.match(
    source,
    /if \(wanted === void 0 \|\| sameRoute\(selection\.current, wanted\)\) return/,
    'the route is only written when it actually differs from what the Session resolves to',
  )
  assert.match(source, /seam\.apply\(agent, wanted\)/, 'otherwise it is written once')
  assert.equal(
    source.includes('seam.take('),
    false,
    'the recorded route must not be consumed after one use',
  )
  assert.equal(
    source.includes('scoped.on("agent/pre-step"'),
    false,
    'there must be no per-step rewrite: assemble runs before pre-step, so it would be both late and repetitive',
  )
  // The piece that actually makes a route stick: selectionFor() installs the
  // agent/request override. Skipping it whenever the projection already looked
  // right is what made a change lapse on the next Agent instance, so it must be
  // unconditional.
  assert.match(source, /selectionFor\(live\)/, 'the Host selection seam must be installed')
  assert.match(
    source,
    /selection = seam\.ensure\(agent\);/,
    'and installed unconditionally, before any route comparison',
  )
  const ensureCall = source.indexOf('selection = seam.ensure(agent);')
  const compare = source.indexOf('sameRoute(selection.current, wanted)')
  assert.ok(ensureCall > 0 && compare > ensureCall, 'the seam is installed before the route is compared')
  // That call runs inside the agent/created listener, so it must not throw.
  assert.match(
    source,
    /try \{\s*seam\.apply\(agent, wanted\);\s*\} catch/,
    'a failing apply must be swallowed, not break member creation',
  )
  assert.match(
    source,
    /try \{\s*selection = seam\.ensure\(agent\);\s*\} catch/,
    'a failing seam install must be swallowed too',
  )
  // A stopped member has no attached Session, so its provider can only be inherited
  // from a route this plugin observed earlier. Without that memory, the documented
  // "omitted provider keeps the member's own" promise fails for exactly the case the
  // tool exists for (changing a member that is not running).
  assert.match(source, /seam\.recall\(row\.id\)/, 'a stopped member inherits its last observed route')
  // The durable answer for a stopped member is its persisted Session log: the folded
  // request/header is what a resumed Agent seeds from. The in-memory record is only
  // the fallback, because it cannot see a member that never ran in this process.
  assert.match(source, /await seam\.persistedRoute\(row\.id\)/, 'a stopped member reads its persisted route')
  assert.match(source, /controller\.inspect\(sessionId\)/, 'the persisted read uses the documented cold inspect')
  assert.match(source, /event\?\.type !== "request\/header"/, 'and folds request headers only')
  assert.match(source, /seam\.remember\(agent\.id, selection\.current\)/, 'observed routes are remembered')
  assert.match(source, /seam\.remember\(row\.id, selection\)/, 'a applied change is remembered too')
  // Structural guarantee: the Lead is never routed by this plugin. Its model
  // belongs to its own Session and the user's picker, and an earlier diagnostic
  // fallback re-routed a live Lead Session by mistake.
  assert.match(
    source,
    /const membership = ctx\.agentTeams\.tryMembership\(agent\);\s*\n\s*if \(membership\?\.role !== "teammate"\) return;/,
    'only a teammate may reach the selection work',
  )
  const roleGate = source.indexOf('membership?.role !== "teammate"')
  const ensureCall2 = source.indexOf('selection = seam.ensure(agent);')
  assert.ok(roleGate > 0 && ensureCall2 > roleGate, 'the role gate runs before any selection work')
  // Prompt assembly must not be able to throw: membership() raises when the Team is
  // gone, which would fail the whole step.
  assert.equal(
    /ctx\.agentTeams\.membership\(/.test(source),
    false,
    'prompt assembly must use tryMembership() instead of membership()',
  )
})

test('a failing install degrades instead of breaking member creation', () => {
  // install() throws when a registration fails - a duplicate tool name does it,
  // which is what happens if the built-in tool-agent-team is somehow active
  // alongside this plugin. maybeInstall runs inside the agent/created listener, so
  // an escaping throw would fail the member's creation; the member should instead
  // be created without this plugin's tools, plus a warning.
  const source = readFileSync(new URL('../tool/index.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /try \{\s*dispose = install\(agent, ctx, resolved, seam\)\s*\} catch/,
    'install() must be wrapped so a registration failure cannot escape the listener',
  )
  assert.match(
    source,
    /could not install the Team tools for/,
    'and the failure must be reported through a warning',
  )
})

test('teardown swallows disposer failures and still forgets the agent', () => {
  // The undo functions are Host-provided effect disposers and may throw. Escaping
  // from the agent/disposed listener would reach the Host's disposal path, and
  // skipping the delete would leave a stale entry to be disposed again.
  const source = readFileSync(new URL('../tool/index.js', import.meta.url), 'utf8')
  assert.match(
    source,
    /try \{\s*installed\.get\(agent\)\?\.\(\);\s*\} catch/,
    'the agent/disposed listener must guard its disposer call',
  )
  assert.match(
    source,
    /finally \{\s*installed\.delete\(agent\);\s*\}/,
    'and must delete the entry even when the disposer throws',
  )
  assert.match(
    source,
    /could not release the Team tools for/,
    'teardown failures are reported as warnings',
  )
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
