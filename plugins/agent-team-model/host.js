/**
 * Reach the Host's own package instances from a directory-linked bundle.
 *
 * `install_bundle` links this bundle into the profile, and a linked package has
 * no `node_modules` of its own. Node resolves bare specifiers by walking up from
 * the importing file, so a static `import '@deepseek-ai/dsh-tools'` here fails
 * with MODULE_NOT_FOUND: the Host's copies live inside the application bundle.
 *
 * Layout of `resources/app.asar` in the installed Desktop app (measured):
 *
 *   /dsh/node_modules/@deepseek-ai/…   ← the Harness packages this plugin needs
 *   /node_modules/@deepseek-ai/…       ← Electron-level copies of schemastery, cordis
 *
 * Every Host package this plugin imports exists under `dsh/node_modules`.
 * `schemastery` and `cordis` also exist under the archive root, but those are
 * independent copies of the same version, not the same files.
 *
 * Instance sharing is exact for the three Harness packages and deliberately not
 * exact for schemastery:
 *
 *   - `dsh-tools`, `dsh-subagent`, `dsh-experimental-agent-team` publish only a
 *     `default` export condition, so resolving then importing by URL lands on the
 *     same file the Host loaded. One tools registry, one `TeamTaskId` brand.
 *   - `@deepseek-ai/schemastery` publishes separate `import` and `require`
 *     conditions, so `require`-resolution reaches `lib/index.cjs` while the Host
 *     loads `lib/index.mjs`. That is accepted: it only builds the `Config`
 *     validator, and cordis validates through the structural `~standard`
 *     protocol rather than an identity check.
 *
 * Resolution is explicit — `createRequire` rooted at a package inside the
 * bundle — and the result is imported by file URL. The archive is searched
 * before the plugin's own tree: a packed copy that happens to carry its own
 * `node_modules` must not shadow the Host's instances.
 *
 * Precedent in this repository: `plugins/prompt-customizer` and
 * `plugins/thinking-guard` reach `@deepseek-ai/schemastery` the same way for the
 * same reason.
 *
 * @module @local/dsh-plugin-agent-team-model/host
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Harness package directory inside the application archive: `app.asar/dsh`.
 * Measured from the installed app; see `createHostResolvers` for the layout.
 */
const HARNESS_ROOT = 'dsh'

/**
 * Build the resolver chain for one application resource directory.
 *
 * The archive roots come first so the Host's instances always win; the plugin's
 * own tree is only a last resort for a development checkout that has neither a
 * packaged app nor an unpacked one. Both `app.asar` and an unpacked `app`
 * directory are probed.
 *
 * @param resourcesPath - `process.resourcesPath`, or any directory laid out the
 *   same way. Exported so the chain is testable outside Electron, where
 *   `process.resourcesPath` does not exist.
 * @returns the resolvers, already ordered.
 */
export function createHostResolvers(resourcesPath) {
  const resolvers = []
  if (typeof resourcesPath === 'string' && resourcesPath !== '') {
    for (const archive of ['app.asar', 'app']) {
      // The target file need not exist: createRequire only needs a base whose
      // directory seeds the `node_modules` walk-up.
      resolvers.push(createRequire(join(resourcesPath, archive, HARNESS_ROOT, 'package.json')))
    }
  }
  resolvers.push(createRequire(import.meta.url))
  return resolvers
}

/** Resolver chain for the running application. */
const resolvers = createHostResolvers(process.resourcesPath)

/**
 * Resolve one Host package to the file the Host itself loads.
 * @param id - bare package specifier.
 * @param chain - resolver chain, defaulting to the running application's.
 * @returns the absolute path inside the application bundle.
 * @throws when no resolver in the chain can find the package.
 */
export function resolveHostPackage(id, chain = resolvers) {
  const failures = []
  for (const resolver of chain) {
    try {
      return resolver.resolve(id)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new Error(
    `agent-team-model: cannot resolve the host package "${id}"; this bundle must run inside the Harness desktop app (resources/app.asar/${HARNESS_ROOT}).\n  ${failures.join('\n  ')}`,
  )
}

/**
 * Load one Host package.
 * @param id - bare package specifier.
 * @param chain - resolver chain, defaulting to the running application's.
 * @returns the module namespace.
 */
export function loadHostPackage(id, chain = resolvers) {
  return import(pathToFileURL(resolveHostPackage(id, chain)).href)
}
