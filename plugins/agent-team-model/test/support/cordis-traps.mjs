/**
 * Minimal but faithful replica of cordis's `createTraceable` proxy
 * (`@deepseek-ai/cordis` lib/index.js:92-158).
 *
 * Why this file exists: the naive fixture (`Object.create(proto)`) makes
 * `proxy.method === wrapped` true, which hides the real trap. In cordis every
 * function read is wrapped in a *fresh* shadow-method proxy, so identity checks
 * against the read value are always false. Only an own-descriptor query (or a
 * delete) reaches the raw instance.
 *
 * Reproduced behaviour:
 *   - `get` returns a new function proxy each time (never the stored function)
 *   - `set` writes the own property on the raw target
 *   - `delete` and `getOwnPropertyDescriptor` forward to the raw target
 *
 * Verified against `@deepseek-ai/cordis@4.0.5` (installed): `createShadowMethod`
 * (`lib/index.js:117-122`) and `createTraceable` (`:123-158`).
 *
 * Deliberately simplified, so do not read more into this fixture than it gives:
 *   - the real `apply` swaps `thisArg` when it equals the *receiver* of the
 *     property read (`if (thisArg === outer) thisArg = shadow`); this replica
 *     compares against the top-level `proxy`. Both are the same object in the
 *     single-level shape the bridge tests use, which is why the fixture is
 *     adequate here — it is not adequate for nested/chained services.
 *   - no `has`, `ownKeys`, `defineProperty`, or symbol-key
 *     (`symbols.original` / `symbols.tracker`) handling.
 */

/**
 * Wrap `raw` in a cordis-shaped traceable proxy.
 * @param {object} raw - the real service instance.
 * @returns {object} the proxy callers see as `ctx.<service>`.
 */
export function traceableProxy(raw) {
  const shadow = Object.create(null)
  const proxy = new Proxy(raw, {
    get(target, prop) {
      const value = Reflect.get(target, prop, shadow)
      if (typeof value !== 'function') return value
      return new Proxy(value, {
        apply: (fn, thisArg, args) => Reflect.apply(fn, thisArg === proxy ? shadow : thisArg, args),
      })
    },
    set(target, prop, value) {
      // cordis routes the write through a shadow overlay that ends up defining
      // the own property on the raw instance (verified against cordis:145-152).
      target[prop] = value
      return true
    },
  })
  return proxy
}

/**
 * Build a service whose activation seam lives on its prototype, like a cordis
 * Service, and return both the raw instance and the traceable proxy.
 * @returns {{ raw: object, proxy: object, proto: object }}
 */
export function activationService() {
  const proto = {
    startActivation() {
      throw new Error('fixture startActivation must be replaced by the recorder')
    },
  }
  const raw = Object.create(proto)
  return { raw, proto, proxy: traceableProxy(raw) }
}
