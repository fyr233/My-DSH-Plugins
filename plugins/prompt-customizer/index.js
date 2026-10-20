import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DEFAULTS, SECTIONS, validateOverrides, installOverrides } from './core.js'

// Directory-linked bundles do not receive their own dependency installation.
// Desktop ships this schema library; resolve from the running application's root.
const require = createRequire(import.meta.url)
const schemaLibrary = (() => {
  try { return require('@deepseek-ai/schemastery') } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND' || !process.resourcesPath) throw error
    return createRequire(join(process.resourcesPath, 'app.asar', 'dsh', 'package.json'))('@deepseek-ai/schemastery')
  }
})()
const z = schemaLibrary.default ?? schemaLibrary

export const name = 'prompt-customizer'
export const inject = ['agents', 'systemPrompt', 'settings', 'tools']
const text = () => z.union([z.string().max(32000), z.const(null)]).default(null)
export const Config = z.object({ overrides: z.object({ identity: text(), prefix: text(), suffix: text() }).default({ ...DEFAULTS }).volatile() })
export function apply(ctx, config) {
  const states = new Map()
  let closed = false
  let queue = Promise.resolve()
  const namespace = () => ctx.settings.describe().find(row => row.ns === 'prompt-customizer' || row.ns === 'include:prompt-customizer' || row.ns.endsWith(':prompt-customizer'))
  async function syncAgent(agent) {
    if (closed || !ctx.agents.roots().includes(agent)) return
    const overrides = validateOverrides(config.overrides.get())
    const previous = states.get(agent)
    previous?.dispose?.()
    states.delete(agent)
    if (Object.values(overrides).every(value => value === null)) return
    try {
      const assembly = await agent.ctx.systemPrompt.assemble({ scope: agent })
      if (closed || ctx.agents.get(agent.id) !== agent) return
      // Complete sections are deliberately not exposed by the public assembly API.
      // A single-section assembly is conservatively excluded rather than overriding it.
      if (assembly.sections.length <= 1) {
        states.set(agent, { status: 'skipped-single-section', dispose: () => {} })
        return
      }
      const dispose = installOverrides(agent.ctx.systemPrompt, overrides)
      states.set(agent, { status: 'applied', dispose })
    } catch (error) {
      states.set(agent, { status: 'conflict', error: String(error.message ?? error), dispose: () => {} })
    }
  }
  function synchronize() {
    queue = queue.then(async () => { for (const agent of ctx.agents.roots()) await syncAgent(agent) })
    return queue
  }
  ctx.effect(() => () => {
    closed = true
    for (const state of states.values()) state.dispose()
    states.clear()
  })
  ctx.on('agent/created', ({ agent }) => {
    queue = queue.then(() => syncAgent(agent))
    return queue
  })
  ctx.on('agent/disposed', ({ agent }) => { states.get(agent)?.dispose(); states.delete(agent) })
  ctx.on('settings/document-updated', ns => {
    if (ns === 'prompt-customizer' || ns === 'include:prompt-customizer' || ns.endsWith(':prompt-customizer')) void synchronize()
  })
  ctx.settings.configure({ auto: false })
  void synchronize()
  // Both GUI and tool use the same settings.update persistence + revision checks.
  ctx.tools.register({
    name: 'prompt_customizer',
    description: 'Read, save, or reset persistent identity/prefix/suffix overrides for top-level Agents in this profile. Changes apply on the next assembled model step; child Agents and single-section/complete prompts are excluded. Inspect reports application conflicts.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['get', 'set', 'reset', 'inspect'] },
      overrides: { type: 'object', properties: Object.fromEntries(['identity','prefix','suffix'].map(key => [key, { oneOf: [{ type: 'string' }, { type: 'null' }], description: 'null inherits defaults; an empty string hides this section.' }])), additionalProperties: false },
      expectedRevision: { type: 'integer', description: 'Revision from get; required for set/reset to prevent overwriting concurrent edits.' }
    }, required: ['action'], additionalProperties: false },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      const row = namespace()
      if (!row) throw new Error('Prompt customizer settings unavailable')
      if (args.action === 'set' || args.action === 'reset') {
        if (!Number.isInteger(args.expectedRevision)) throw new Error('Read settings first and supply expectedRevision')
        const overrides = args.action === 'reset' ? { ...DEFAULTS } : validateOverrides(args.overrides)
        await ctx.settings.update(row.ns, { overrides }, args.expectedRevision)
        await synchronize()
      }
      const latest = namespace()
      await queue
      const result = { revision: latest.revision, overrides: validateOverrides(config.overrides.get()), scope: 'profile-top-level-agents', applications: [...states].map(([agent, state]) => ({ agentId: agent.id, status: state.status, ...(state.error ? { error: state.error } : {}) })) }
      if (args.action === 'inspect' && exec.agent) {
        const assembly = await exec.agent.ctx.systemPrompt.assemble({ scope: exec.agent })
        result.sections = assembly.sections.filter(section => SECTIONS.some(([, name]) => name === section.name))
        result.sectionCount = assembly.sections.length
      }
      return result
    }
  })
}
