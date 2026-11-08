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
function assertAllowed(settings, provider, model, tool = 'spawn_teammate') {
  if (settings === undefined) return
  let current
  try {
    current = settings.current()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`${tool}: teammate model selection is misconfigured (${detail})`)
  }
  if (!current.enabled) throw new Error(`${tool}: child model selection is disabled in Settings`)
  if (current.allowedModels.some((route) => route.provider === provider && route.model === model)) return
  const allowed = current.allowedModels.map((route) => `${route.provider}/${route.model}`).join(', ')
  throw new Error(`${tool}: child LLM route "${provider}/${model}" is not allowed; allowed routes: ${allowed}`)
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

/**
 * Decide the route for changing an existing member's model.
 *
 * Unlike a spawn, this is always an explicit operation: at least one of
 * `model` / `provider` / `reasoning_effort` must be given. The result is a
 * complete selection because the session seam installs a whole route, not a
 * partial override.
 *
 * @param settings - the `subagentModelSelection` service, or undefined when absent.
 * @param current - the member's current route `{ provider, model, reasoningEffort }`.
 * @param args - model-facing arguments.
 * @param tool - tool name used in diagnostics.
 * @returns `{ provider, model, reasoningEffort? }`.
 */
export function planTeammateModelChange(settings, current, args, tool = 'set_teammate_model') {
  const wantsModel = args.model !== undefined
  const wantsProvider = args.provider !== undefined
  const wantsEffort = args.reasoning_effort !== undefined
  if (!wantsModel && !wantsProvider && !wantsEffort) {
    throw new Error(`${tool}: pass at least one of \`model\`, \`provider\` or \`reasoning_effort\``)
  }
  if (wantsProvider && !wantsModel) {
    throw new Error(`${tool}: \`provider\` requires \`model\``)
  }

  const provider = args.provider ?? current?.provider
  const model = wantsModel ? args.model : current?.model
  if (provider === undefined || model === undefined) {
    throw new Error(`${tool}: cannot resolve an effective provider and model for "${args.target ?? 'the member'}"; pass \`provider\` together with \`model\``)
  }
  assertAllowed(settings, provider, model, tool)

  // A route change without an explicit effort lets the new model resolve its own
  // default, and an effort-only change keeps the current route. Those are the only
  // two possibilities left: an omitted route change would have returned above, and
  // a provider without a model is rejected above, so effort never falls back to the
  // current value.
  const reasoningEffort = wantsEffort ? args.reasoning_effort : undefined

  return {
    provider,
    model,
    ...reasoningEffort === undefined ? {} : { reasoningEffort },
  }
}

/**
 * The selection a session is heading for: the pending change wins over the last
 * one actually used, matching the panel's `next = pending ?? lastUsed`.
 * @param projection - the `modelSelection` projection state, or undefined.
 * @returns the effective selection, or undefined when the session never chose one.
 */
export function pickSelectedRoute(projection) {
  return projection?.pending ?? projection?.lastUsed ?? undefined
}

/**
 * The model a roster row should display. Never falls back to another member's
 * route: an unresolved model stays unresolved so the caller can omit the field.
 * @param projection - the member's `modelSelection` projection state.
 * @param liveOptions - the live agent's creation options, when it is live.
 * @returns the model id, or undefined.
 */
export function pickMemberModel(projection, liveOptions) {
  return pickSelectedRoute(projection)?.model ?? liveOptions?.model
}

/**
 * Whether two selections describe the same route.
 * @param a - first selection.
 * @param b - second selection.
 * @returns true when provider, model and effort match.
 */
export function sameRoute(a, b) {
  if (a === undefined || b === undefined) return false
  return a.provider === b.provider && a.model === b.model && (a.reasoningEffort ?? undefined) === (b.reasoningEffort ?? undefined)
}

/**
 * The selection a brand-new Session must be pinned to.
 *
 * Installing the Host's selection seam also installs the request override, and
 * `selectionFor()` resolves a Session with no request header at all to the
 * DEPLOYMENT DEFAULT model. For a member that was just spawned with an explicit
 * route that default would replace it, so the selection has to be pinned to the
 * member's own creation route instead — which is what the loop would have used
 * without the seam.
 *
 * Kept pure so the spawn case can be tested even when the roster is full and no
 * member can actually be created.
 *
 * @param options - `{ hasHeader, wanted, own }`: whether the Session already
 *   logged a request header, the route this plugin recorded for it (if any), and
 *   the options the Agent was created with.
 * @returns the route to pin, or undefined to leave the Host's answer alone.
 */
export function pinCreationRoute({ hasHeader, wanted, own }) {
  if (hasHeader || wanted !== undefined) return undefined
  const provider = own?.provider
  const model = own?.model
  if (provider === undefined || model === undefined) return undefined
  return {
    provider,
    model,
    ...own?.reasoningEffort === undefined ? {} : { reasoningEffort: own.reasoningEffort },
  }
}
