import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Carries one spawn's resolved child AgentOptions from the tool call to the
 * activation seam.
 *
 * Agent Teams forwards only `{ prompt, parent }` into
 * `ctx.subagents.startActivation`, so the model cannot travel through the
 * public `spawnTeammate` request. The tool tags its own call instead, and the
 * bridge plugin in this package merges the tag back into the activation
 * request. `lifecycle.track` is synchronous and `journal.transact` is an
 * ordinary await, so the store survives the whole spawn chain.
 */
const storage = new AsyncLocalStorage()

/**
 * Run `operation` with `agentOptions` visible to the bridge.
 * @param agentOptions - Child options to tag, or undefined to run untagged.
 * @param operation - The spawn call to run.
 * @returns whatever `operation` returns.
 */
export function withTeammateAgentOptions(agentOptions, operation) {
  if (agentOptions === undefined) return operation()
  return storage.run({ agentOptions }, operation)
}

/**
 * Read the AgentOptions tagged by the innermost spawning tool call.
 * @returns the tagged options, or undefined outside a tagged spawn.
 */
export function currentTeammateAgentOptions() {
  return storage.getStore()?.agentOptions
}
