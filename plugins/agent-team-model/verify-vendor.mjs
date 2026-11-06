/**
 * Guard the vendored tool against silent drift.
 *
 * `tool/index.js` is a copy of `@deepseek-ai/dsh-experimental-tool-agent-team`'s
 * built `lib/index.js` with a small, deliberate patch. When the host ships a new
 * version this script tells you exactly what changed upstream, so the patch can
 * be rebased instead of quietly rotting.
 *
 * Usage:
 *   node verify-vendor.mjs [--baseline <path-to-upstream-lib-index.js>] [--report]
 *
 * Without `--baseline` it falls back to `.scratch/vendor-baseline`. When neither
 * exists it prints SKIP and exits 0: the baseline is a build artifact of the
 * installed app and is not committed.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const VENDORED = join(HERE, 'tool', 'index.js')
const DEFAULT_BASELINE = join(HERE, '..', '..', '.scratch', 'vendor-baseline', '@deepseek-ai', 'dsh-experimental-tool-agent-team', 'lib', 'index.js')

/** Markers that must exist in the patched copy. */
const REQUIRED = [
  ['route planner import', 'import { pickSelectedRoute, planTeammateModelChange, planTeammateRoute, pickMemberModel, sameRoute } from "../route.js";'],
  // Every identifier imported from route.js must actually be used, and every
  // route.js helper the tool calls must be imported. A missing one is a runtime
  // ReferenceError that unit tests never see, because they only load route.js.
  ['route seam used', 'pickSelectedRoute(projection)'],
  ['tag transport import', 'import { withTeammateAgentOptions } from "../als.js";'],
  ['host loader import', 'import { loadHostPackage } from "../host.js";'],
  ['host route resolver', 'const { parentAgentOptionsForDelegation } = await loadHostPackage("@deepseek-ai/dsh-subagent");'],
  ['model parameter', '\t\t\t\tmodel: {'],
  ['provider parameter', '\t\t\t\tprovider: {'],
  ['effort parameter', '\t\t\t\treasoning_effort: {'],
  ['tagged spawn', 'withTeammateAgentOptions(agentOptions, () => ctx.agentTeams.spawnTeammate(agent, {'],
  // The vendored copy is re-patched on every Host upgrade; without these markers
  // a rebase could silently drop the route-change feature and still be green.
  ['route change tool', 'name: "set_teammate_model"'],
  ['route change seam', 'selectForNextRequest'],
]

/** Markers that must be gone: the unpatched shapes, and static Host imports. */
const FORBIDDEN = [
  ['unpatched spawn call', 'return { member: modelMember((await ctx.agentTeams.spawnTeammate(agent, {'],
  // A linked bundle cannot resolve the Host's packages; every Host import must
  // go through host.js so it lands on the instance the Host already loaded.
  ['static dsh-tools import', 'from "@deepseek-ai/dsh-tools";'],
  ['static dsh-subagent import', 'from "@deepseek-ai/dsh-subagent";'],
  ['static agent-team import', 'from "@deepseek-ai/dsh-experimental-agent-team";'],
  ['static schemastery import', 'from "@deepseek-ai/schemastery";'],
]

/**
 * The exact upstream build this copy was derived from. A mismatch means the host
 * shipped a different `tool-agent-team`; rebase the patch, then update this
 * constant and the baseline line in README.md together.
 */
const BASELINE_SHA256 = 'cac22fe5f83a179056469cf329def58393c7620eae23b018c66f42c37d849f63'

const args = process.argv.slice(2)
const report = args.includes('--report')
const baselineArg = args.indexOf('--baseline')
const baselinePath = baselineArg === -1 ? DEFAULT_BASELINE : resolve(args[baselineArg + 1])

const vendored = await readFile(VENDORED, 'utf8')
const failures = []

for (const [label, marker] of REQUIRED) {
  if (!vendored.includes(marker)) failures.push(`missing ${label}: ${JSON.stringify(marker)}`)
}
for (const [label, marker] of FORBIDDEN) {
  if (vendored.includes(marker)) failures.push(`still present ${label}: ${JSON.stringify(marker)}`)
}

/**
 * Every helper the vendored tool calls must be imported from ./route.js.
 *
 * This is the check that would have caught `pickSelectedRoute is not defined`:
 * the unit suite only loads route.js, so a missing import in tool/index.js is
 * invisible to it and fails for the first time at a live tool call.
 */
const routeSource = await readFile(join(HERE, 'route.js'), 'utf8')
const exportedHelpers = [...routeSource.matchAll(/^export function (\w+)/gmu)].map((m) => m[1])
const importLine = vendored.match(/^import \{([^}]+)\} from "\.\.\/route\.js";$/mu)
if (importLine === null) {
  failures.push('missing route.js import line in the vendored tool')
} else {
  const imported = new Set(importLine[1].split(',').map((s) => s.trim()).filter(Boolean))
  const body = vendored.slice(vendored.indexOf(importLine[0]) + importLine[0].length)
  for (const helper of exportedHelpers) {
    const used = new RegExp(`\\b${helper}\\s*\\(`, 'u').test(body)
    if (used && !imported.has(helper)) {
      failures.push(`route helper used but not imported: ${helper}() — a live call would throw ReferenceError`)
    }
    if (!used && imported.has(helper)) {
      failures.push(`route helper imported but never used: ${helper}() — drop it or wire it up`)
    }
  }
}

let baseline
try {
  baseline = await readFile(baselinePath, 'utf8')
} catch {
  console.log(`SKIP upstream comparison: no baseline at ${baselinePath}`)
  baseline = undefined
}

if (baseline !== undefined) {
  const digest = createHash('sha256').update(baseline).digest('hex')
  console.log(`baseline sha256 ${digest}`)
  if (digest !== BASELINE_SHA256) {
    failures.push(`upstream baseline drifted: expected ${BASELINE_SHA256}, got ${digest}. Rebase the patch, then update BASELINE_SHA256 here and the baseline line in README.md.`)
  }
  const before = baseline.split('\n')
  const after = vendored.split('\n')
  const count = (lines) => lines.reduce((map, line) => map.set(line, (map.get(line) ?? 0) + 1), new Map())
  const beforeCount = count(before)
  const afterCount = count(after)
  const removed = [...beforeCount].filter(([line, n]) => (afterCount.get(line) ?? 0) < n)
  const added = [...afterCount].filter(([line, n]) => (beforeCount.get(line) ?? 0) < n)
  console.log(`baseline ${before.length} lines, vendored ${after.length} lines`)
  console.log(`removed ${removed.reduce((n, [, c]) => n + c, 0)} line(s), added ${added.reduce((n, [, c]) => n + c, 0)} line(s)`)
  if (report) {
    for (const [line, n] of removed) console.log(`  - ${n}x ${line.trim().slice(0, 140)}`)
    for (const [line, n] of added) console.log(`  + ${n}x ${line.trim().slice(0, 140)}`)
  }
  // The patch replaces one execute body and inserts a helper block plus two
  // imports. Anything far outside that envelope means the baseline moved.
  if (before.length > after.length) {
    failures.push(`vendored is shorter than the baseline (${after.length} < ${before.length})`)
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log('ok - vendored tool matches the expected patch shape')
