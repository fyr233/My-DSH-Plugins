/**
 * Host half of prompt-customizer.
 *
 * Preferences live in this plugin's own file, behind one loopback-only route,
 * instead of the Host settings namespace: the editable-form projection reads
 * schemastery internals (`meta.volatile` / `dict`), and a workspace-linked bundle
 * cannot resolve `@deepseek-ai/schemastery` — importing it fails the load and
 * violates this repo's "no dsh package imports" rule. `dsh-ui-sound` solved the
 * same problem the same way; `thinking-guard` follows it too.
 *
 * Surface:
 *   GET  /prompt-customizer/api/settings   the saved overrides
 *   POST /prompt-customizer/api/settings   { overrides } merged and persisted
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULTS, SECTIONS, validateOverrides, installOverrides } from './core.js'

export const name = 'prompt-customizer'

/** `agents` + `systemPrompt` do the work; `webServer` carries the settings route. */
export const inject = ['agents', 'systemPrompt', 'webServer', 'tools']

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/prompt-customizer/api'

const STATE_DIR_NAME = 'prompt-customizer'
const CONFIG_FILE_NAME = 'settings.json'

/**
 * Row config: shipped overrides, overridable from the profile patch layer.
 * Standard Schema (`~standard`) as `docs/experiences/03` requires.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugins-prompt-customizer',
    validate(value) {
      const config = { overrides: { ...DEFAULTS } }
      if (value === undefined || value === null) return { value: config }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, entry] of Object.entries(value)) {
        if (key !== 'overrides') {
          return { issues: [{ message: `unknown config key: ${key}`, path: [key] }] }
        }
        try {
          config.overrides = validateOverrides(entry)
        } catch (error) {
          return { issues: [{ message: error.message, path: [key] }] }
        }
      }
      return { value: config }
    },
  },
}

/** Where the preferences file lives. */
export function resolveConfigPath(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, STATE_DIR_NAME, CONFIG_FILE_NAME)
}

/** Coerce stored or posted overrides into the exact owned shape. */
export function normalizePreferences(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  try {
    return { overrides: validateOverrides(value.overrides ?? DEFAULTS) }
  } catch {
    return { overrides: { ...DEFAULTS } }
  }
}

/** Read the preferences file, falling back to defaults. */
export function readPreferences(path) {
  try {
    if (!existsSync(path)) return { overrides: { ...DEFAULTS } }
    return normalizePreferences(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { overrides: { ...DEFAULTS } }
  }
}

/** Write the preferences file atomically. */
export function writePreferences(path, preferences) {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(preferences, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return preferences
}

/** Loopback + same-origin trust decision. */
export function isTrustedRequest(request) {
  const address = request.socket?.remoteAddress
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!loopback) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Apply the plugin.
 * @param ctx - plugin context.
 * @param config - row config (see {@link Config}).
 */
export function apply(ctx, config = {}) {
  const configPath = resolveConfigPath()
  // The patch layer seeds the file the first time; afterwards the file wins.
  let preferences = existsSync(configPath)
    ? readPreferences(configPath)
    : normalizePreferences({ overrides: config?.overrides ?? DEFAULTS })

  const states = new Map()
  let closed = false
  let queue = Promise.resolve()

  async function syncAgent(agent) {
    if (closed || !ctx.agents.roots().includes(agent)) return
    const overrides = preferences.overrides
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
  void synchronize()

  /** Persist and re-apply. */
  async function save(overrides) {
    preferences = writePreferences(configPath, normalizePreferences({ overrides }))
    await synchronize()
    return preferences.overrides
  }

  const settingsHandler = async (req, res) => {
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'the settings route is loopback-only' } })
      return
    }
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true, value: { overrides: preferences.overrides } })
      return
    }
    if (req.method !== 'POST') {
      writeJson(res, 405, { ok: false, error: { code: 'method', message: 'use GET or POST' } })
      return
    }
    let body
    try {
      body = await readJson(req)
    } catch (error) {
      writeJson(res, 400, { ok: false, error: { code: 'body', message: String(error.message ?? error) } })
      return
    }
    try {
      const overrides = await save(validateOverrides(body.overrides))
      writeJson(res, 200, { ok: true, value: { overrides } })
    } catch (error) {
      writeJson(res, 400, { ok: false, error: { code: 'overrides', message: String(error.message ?? error) } })
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/settings`, handler: settingsHandler }), 'prompt-customizer: settings route')

  ctx.tools.register({
    name: 'prompt_customizer',
    description: 'Read, save, or reset persistent identity/prefix/suffix overrides for top-level Agents in this profile. Changes apply on the next assembled model step; child Agents and single-section/complete prompts are excluded. Inspect reports application conflicts.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'reset', 'inspect'] },
        overrides: {
          type: 'object',
          properties: Object.fromEntries(['identity', 'prefix', 'suffix'].map(key => [key, {
            oneOf: [{ type: 'string' }, { type: 'null' }],
            description: 'null inherits defaults; an empty string hides this section.',
          }])),
          additionalProperties: false,
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: (_, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
    async execute(args, exec) {
      if (args.action === 'set' || args.action === 'reset') {
        const overrides = args.action === 'reset' ? { ...DEFAULTS } : validateOverrides(args.overrides)
        await save(overrides)
      }
      await queue
      const result = {
        configPath,
        overrides: preferences.overrides,
        scope: 'profile-top-level-agents',
        applications: [...states].map(([agent, state]) => ({ agentId: agent.id, status: state.status, ...(state.error ? { error: state.error } : {}) })),
      }
      if (args.action === 'inspect' && exec.agent) {
        const assembly = await exec.agent.ctx.systemPrompt.assemble({ scope: exec.agent })
        result.sections = assembly.sections.filter(section => SECTIONS.some(([, name]) => name === section.name))
        result.sectionCount = assembly.sections.length
      }
      return result
    },
  })
}
