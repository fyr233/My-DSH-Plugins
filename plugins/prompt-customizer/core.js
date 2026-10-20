export const DEFAULTS = Object.freeze({ identity: null, prefix: null, suffix: null })
export const SECTIONS = Object.freeze([
  ['identity', 'harness:identity', 'HARNESS_IDENTITY'],
  ['prefix', 'deployment:persona-prefix', 'DEPLOYMENT_PERSONA_PREFIX'],
  ['suffix', 'deployment:persona-suffix', 'DEPLOYMENT_PERSONA_SUFFIX'],
])
export function validateOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('overrides must be an object')
  const result = { ...DEFAULTS }
  for (const [key, text] of Object.entries(value)) {
    if (!Object.hasOwn(DEFAULTS, key)) throw new Error(`Unknown override: ${key}`)
    if (text !== null && (typeof text !== 'string' || text.length > 32000)) throw new Error(`${key} must be null or a string of at most 32000 characters`)
    result[key] = text
  }
  return result
}
/** Installation is transactional within each agent, never disposes another plugin's registration. */
export function installOverrides(prompt, overrides) {
  const disposers = []
  try {
    for (const [key, name, order] of SECTIONS) {
      if (overrides[key] === null) continue
      disposers.push(prompt.section({ name, order: prompt.getSectionOrder(order), text: overrides[key], interpolate: false }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => { for (const dispose of disposers.splice(0).reverse()) dispose() }
}
