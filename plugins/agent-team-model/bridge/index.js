/**
 * Bridge a Team spawn's per-member model onto the subagent activation seam.
 *
 * `spawn_teammate` reaches `ctx.subagents.startActivation` through Agent Teams
 * internals that forward only `{ prompt, parent }`. The tool tags its call with
 * AsyncLocalStorage; this wrapper merges that tag into the activation request,
 * which `resolveChildAgentOptions` already honours for every provider that
 * advertises `capabilities.agentOptions` (both `spawn` and `fork` do).
 *
 * The Agent Teams service itself is left untouched, so installing or reloading
 * this plugin never disposes a running Team.
 *
 * @module @local/dsh-plugin-agent-team-model/bridge
 */
import { currentTeammateAgentOptions } from '../als.js'

/** Cordis plugin name. */
export const name = 'agent-team-model-bridge'

/** Services required by the bridge. */
export const inject = ['subagents']

/**
 * Wrap `startActivation` so tagged spawns carry their model through.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const subagents = ctx.subagents
  const original = subagents.startActivation
  if (typeof original !== 'function') {
    throw new Error('agent-team-model-bridge: ctx.subagents.startActivation is missing')
  }

  const wrapped = function startActivation(spec) {
    const agentOptions = currentTeammateAgentOptions()
    if (agentOptions === undefined || spec === null || typeof spec !== 'object') {
      return original.call(subagents, spec)
    }
    const request = spec.request
    if (request === null || typeof request !== 'object') return original.call(subagents, spec)
    return original.call(subagents, { ...spec, request: { ...request, agentOptions } })
  }

  subagents.startActivation = wrapped
  ctx.effect(() => () => {
    // Reading the method back never returns `wrapped` itself: cordis wraps every
    // function it hands out in a fresh shadow-method proxy, so an identity check
    // against the read value is always false and the teardown would silently do
    // nothing. Test the own descriptor instead (the proxy forwards it to the raw
    // service instance), then delete the own property so the prototype method is
    // visible again. Assigning the captured proxy back would leave a traceable
    // proxy stored as an own value.
    const descriptor = Reflect.getOwnPropertyDescriptor(subagents, 'startActivation')
    if (descriptor?.value === wrapped) delete subagents.startActivation
  }, 'agent-team-model-bridge.startActivation()')
}
