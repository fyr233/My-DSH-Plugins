/**
 * Pure route planning for `spawn_teammate`.
 *
 * Kept free of host imports so it can be unit-tested outside a Harness process.
 * The tool passes the live `subagentModelSelection` service and the Lead's
 * effective route; this module only decides what to send and what to reject.
 *
 * @module @local/dsh-plugin-agent-team-model/route
 */

/** Reject a route the operator did not allow. */
function assertAllowed(settings, provider, model) {
  if (settings === undefined) return
  let current
  try {
    current = settings.current()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`spawn_teammate: teammate model selection is misconfigured (${detail})`)
  }
  if (!current.enabled) throw new Error('spawn_teammate: child model selection is disabled in Settings')
  if (current.allowedModels.some((route) => route.provider === provider && route.model === model)) return
  const allowed = current.allowedModels.map((route) => `${route.provider}/${route.model}`).join(', ')
  throw new Error(`spawn_teammate: child LLM route "${provider}/${model}" is not allowed; allowed routes: ${allowed}`)
}

/**
 * Decide the child route for one spawn.
 * @param settings - the `subagentModelSelection` service, or undefined when absent.
 * @param parent - the Lead's effective `{ provider, model, reasoningEffort }`.
 * @param args - model-facing arguments (`model` / `provider` / `reasoning_effort`).
 * @returns `{ provider, model, reasoningEffort, agentOptions }`, or undefined to inherit.
 */
export function planTeammateRoute(settings, parent, args) {
  const wantsModel = args.model !== undefined
  const wantsEffort = args.reasoning_effort !== undefined
  if (args.provider !== undefined && !wantsModel) {
    throw new Error('spawn_teammate: `provider` requires `model`')
  }
  if (!wantsModel && !wantsEffort) return undefined

  const provider = args.provider ?? parent?.provider
  const model = wantsModel ? args.model : parent?.model
  const reasoningEffort = wantsEffort ? args.reasoning_effort : undefined

  // Any explicit selection validates the *effective* route, not just the
  // overridden half: `dsh-tool-subagent` counts `reasoning_effort` as a
  // selection too, so `enabled: false` and the whitelist must also cover
  // effort-only spawns.
  if (provider === undefined || model === undefined) {
    throw new Error('spawn_teammate: cannot resolve an effective provider and model for this spawn; pass `provider` together with `model`')
  }
  assertAllowed(settings, provider, model)

  return {
    provider,
    model,
    reasoningEffort,
    agentOptions: {
      ...args.provider === undefined ? {} : { provider: args.provider },
      ...wantsModel ? { model: args.model } : {},
      ...wantsEffort ? { reasoningEffort: args.reasoning_effort } : {},
    },
  }
}
