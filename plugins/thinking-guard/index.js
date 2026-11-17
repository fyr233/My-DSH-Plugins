/**
 * Host half of thinking-guard.
 *
 * Why the preferences live in this plugin's own file instead of the Host
 * settings namespace: an externally installed bundle cannot rely on
 * `ctx.settings` internals. The editable-form projection reads schemastery
 * `meta.volatile` / `dict`, and a workspace-linked plugin cannot resolve
 * `@deepseek-ai/schemastery` — importing it fails at load, and importing dsh
 * packages is against this repo's rules anyway. `dsh-ui-sound` hit the same wall
 * and solved it the same way: one loopback-only JSON route, one owned file.
 *
 * Surface:
 *   GET  /thinking-guard/api/settings   the saved preferences
 *   POST /thinking-guard/api/settings   { markers, keepMarkers, enabled } merged
 *
 * The stream guard reads the in-memory copy, so a saved edit applies to the very
 * next model call with no reload.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  DEFAULT_MARKERS_TEXT,
  safeCompileMarkers,
  validateMarkerList,
} from './core.js'
import { DEFAULT_MARKERS, guardStream, setGuardLogger } from './guard.js'

export { createBlockParser, isMarkerPrefix, matchMarker, partialTagSuffix, splitTaggedBody, stripTags } from './guard.js'

export const name = 'thinking-guard'

/**
 * `webServer` carries the settings route; `systemPrompt` is a hard dependency
 * because a section registered against a service that is not ready yet would be
 * silently dropped, and nothing would retry it. `llm` is the stream we rewrite;
 * `tools` mirrors the same read/write path for scripted checks.
 */
export const inject = ['llm', 'systemPrompt', 'webServer', 'tools']

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/thinking-guard/api'

/** Directory name this plugin owns under the DSH home. */
const STATE_DIR_NAME = 'thinking-guard'

/** File holding the durable preferences. */
const CONFIG_FILE_NAME = 'settings.json'

/**
 * What the model is told about summarising.
 *
 * Sessions that spend their time discussing compaction make the model mistake
 * "write a conversation summary" for the current task: it answers with a
 * checkpoint-shaped `<analysis>` + `<summary>` and stops, because a finished
 * summary has no next action. Measured in this profile: 6 such endings in the
 * session that kept asking about compaction, 1 in the session whose brief asked
 * for a summary, and 0 in 1030 messages of ordinary research work — so the
 * trigger is the topic, not the token count.
 */
export const DEFAULT_NOTE = 'Never produce a conversation summary, checkpoint, or <analysis>/<summary> block unless the user '
  + 'explicitly asks for one: context compaction is handled by the harness, and a summary you volunteer replaces the work '
  + 'you were asked to do.'

/** Every preference this plugin owns, with its shipped default. */
export const DEFAULTS = Object.freeze({
  markers: DEFAULT_MARKERS_TEXT,
  enabled: true,
  keepMarkers: false,
  note: DEFAULT_NOTE,
})

/**
 * Row config, overridable from the profile's `cordis.patch.yml`.
 *
 * Standard Schema (`~standard`) as `docs/experiences/03` requires: a bare JSON
 * Schema would make dsh look for a validator package this workspace cannot
 * resolve, and a schemastery schema cannot even be imported here.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugins-thinking-guard',
    validate(value) {
      const config = { ...DEFAULTS }
      if (value === undefined || value === null) return { value: config }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, entry] of Object.entries(value)) {
        if (!Object.hasOwn(DEFAULTS, key)) {
          return { issues: [{ message: `unknown config key: ${key}`, path: [key] }] }
        }
        if (key === 'markers') {
          try {
            config.markers = validateMarkerList(entry)
          } catch (error) {
            return { issues: [{ message: error.message, path: [key] }] }
          }
          continue
        }
        if (key === 'enabled' || key === 'keepMarkers') {
          if (typeof entry !== 'boolean') {
            return { issues: [{ message: `${key} must be a boolean`, path: [key] }] }
          }
          config[key] = entry
          continue
        }
        if (typeof entry !== 'string') {
          return { issues: [{ message: 'note must be a string', path: [key] }] }
        }
        config[key] = entry
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

/**
 * Coerce a stored or posted value into the exact shape this plugin owns.
 * A malformed stored file degrades to defaults instead of failing activation.
 * @param raw - parsed JSON, or `undefined`.
 * @returns the normalised preferences.
 */
export function normalizePreferences(raw) {
  const value = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  let markers = [...DEFAULT_MARKERS_TEXT]
  try {
    markers = validateMarkerList(value.markers ?? DEFAULT_MARKERS_TEXT)
  } catch {
    markers = [...DEFAULT_MARKERS_TEXT]
  }
  return {
    markers,
    enabled: value.enabled !== false,
    keepMarkers: value.keepMarkers === true,
    note: typeof value.note === 'string' ? value.note : DEFAULT_NOTE,
  }
}

/** Read the preferences file, falling back to defaults. */
export function readPreferences(path) {
  try {
    if (!existsSync(path)) return { ...DEFAULTS }
    return normalizePreferences(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return { ...DEFAULTS }
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

/** Loopback + same-origin trust decision, the same rule `dsh-ui-sound` uses. */
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

/** Write one JSON response without depending on any Host helper. */
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

/** Read one JSON request body with a hard size bound. */
function readJson(req, limit = 64 * 1024) {
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
 * Register the stream guard, its preferences route, and the tool.
 * @param ctx - plugin context.
 * @param config - row config (see {@link Config}).
 */
export function apply(ctx, config = {}) {
  setGuardLogger(ctx.logger)

  const configPath = resolveConfigPath()
  let preferences = readPreferences(configPath)
  // The patch layer is the shipped default; a saved preference wins over it so a
  // GUI edit is not silently reverted on the next restart.

  /** Current settings, with the shipped defaults standing in for a bad value. */
  function current() {
    return {
      enabled: preferences.enabled,
      markers: safeCompileMarkers(preferences.markers),
      note: preferences.note,
      keepMarkers: preferences.keepMarkers,
    }
  }

  // One line in the system prompt, before any tool section: the model must not
  // take compaction into its own hands. Re-registered when the text changes,
  // since a section is immutable once installed.
  let disposeNote
  let installedNote
  function syncNote() {
    const settings = current()
    if (!settings.enabled) return
    if (settings.note === installedNote) return
    disposeNote?.()
    disposeNote = undefined
    installedNote = undefined
    if (settings.note.trim() === '') return
    disposeNote = ctx.systemPrompt.section({
      name: 'thinking-guard:no-self-compaction',
      order: 400,
      text: settings.note,
    })
    installedNote = settings.note
  }
  ctx.effect(() => () => {
    disposeNote?.()
    disposeNote = undefined
  })
  syncNote()

  // The marker list needs no re-registration: the stream listener reads it live.
  ctx.on('llm/stream', (_options, next) => {
    const settings = current()
    if (!settings.enabled) return next()
    return guardStream(next(), settings.markers, { keepMarkers: settings.keepMarkers })
  })

  // One loopback-only route: GET reads, POST merges and persists.
  const settingsHandler = async (req, res) => {
    if (!isTrustedRequest(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'the settings route is loopback-only' } })
      return
    }
    if (req.method === 'GET') {
      writeJson(res, 200, { ok: true, value: { ...preferences } })
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
    const merged = { ...preferences }
    if (body.markers !== undefined) {
      try {
        merged.markers = validateMarkerList(body.markers)
      } catch (error) {
        writeJson(res, 400, { ok: false, error: { code: 'markers', message: error.message } })
        return
      }
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== 'boolean') {
        writeJson(res, 400, { ok: false, error: { code: 'enabled', message: 'enabled must be a boolean' } })
        return
      }
      merged.enabled = body.enabled
    }
    if (body.keepMarkers !== undefined) {
      if (typeof body.keepMarkers !== 'boolean') {
        writeJson(res, 400, { ok: false, error: { code: 'keepMarkers', message: 'keepMarkers must be a boolean' } })
        return
      }
      merged.keepMarkers = body.keepMarkers
    }
    try {
      preferences = writePreferences(configPath, normalizePreferences(merged))
    } catch (error) {
      writeJson(res, 500, { ok: false, error: { code: 'persist', message: String(error.message ?? error) } })
      return
    }
    syncNote()
    writeJson(res, 200, { ok: true, value: { ...preferences } })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/settings`, handler: settingsHandler }), 'thinking-guard: settings route')

  // The same read/write path the panel uses, reachable from a tool so the
  // behaviour can be checked without clicking through the GUI.
  ctx.tools.register({
    name: 'thinking_guard',
    description: 'Read or change the thinking-marker list used to reclassify leaked reasoning: '
      + 'get shows the saved preferences and the compiled markers, set replaces the list, add appends one marker, '
      + 'reset restores the shipped defaults. Changes apply to the next model call without a reload.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'add', 'reset'] },
        markers: {
          type: 'array',
          items: { type: 'string' },
          description: 'For set: the complete list, matched literally, e.g. "<thinking>" or "【思考】 => 【/思考】".',
        },
        marker: { type: 'string', description: 'For add: one marker to append.' },
        enabled: { type: 'boolean', description: 'Optional: turn the stream guard on or off.' },
        keepMarkers: { type: 'boolean', description: 'Optional: keep the marker text inside the folded block (default false).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      if (args.action === 'get') return describe()
      const next = { ...preferences }
      if (args.action === 'reset') next.markers = [...DEFAULT_MARKERS_TEXT]
      else if (args.action === 'add') next.markers = validateMarkerList([...preferences.markers, args.marker])
      else next.markers = validateMarkerList(args.markers)
      if (typeof args.enabled === 'boolean') next.enabled = args.enabled
      if (typeof args.keepMarkers === 'boolean') next.keepMarkers = args.keepMarkers
      preferences = writePreferences(configPath, normalizePreferences(next))
      syncNote()
      return describe()
    },
  })

  function describe() {
    const settings = current()
    return {
      configPath,
      enabled: settings.enabled,
      keepMarkers: settings.keepMarkers,
      markers: settings.markers.map((marker) => marker.open),
      note: settings.note,
    }
  }
}
