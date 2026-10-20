/** Reproduce the three claims of this review against the current build. */
import { guardStream } from '../index.js'

async function* streamOf(chunks) { for (const c of chunks) yield c }
async function collect(it) { const out = []; for await (const c of it) out.push(c); return out }

/** Host mirror: replay is kept when the count matches, whatever the mapping. */
function hostAssembled(chunks) {
  const partials = new Map(); const order = []
  const ensure = (i, t) => { let p = partials.get(i); if (!p) { p = { blockType: t, text: '', block: undefined }; partials.set(i, p); order.push(i) } return p }
  let replay
  for (const c of chunks) {
    switch (c.type) {
      case 'block-start': ensure(c.index, c.blockType); break
      case 'text-delta': { const p = ensure(c.index, 'text'); if (!p.block) p.text += c.text; break }
      case 'reasoning-delta': { const p = ensure(c.index, 'reasoning'); if (!p.block) p.text += c.text; break }
      case 'block-end': { const p = ensure(c.index, c.block.type); if (!p.block) p.block = c.block; break }
      case 'finish': replay = c.replayState; break
      default: break
    }
  }
  const blocks = order.map((i) => { const p = partials.get(i); return p.block ?? { type: p.blockType, text: p.text } })
  const kept = replay?.blocks !== undefined && replay.blocks.length === blocks.length ? replay : undefined
  return { blocks, replay: kept }
}

// claim 1: drop one empty block and split a mixed one -> count still matches
const replay = { response: { ok: true }, blocks: [{ source: 'empty' }, { source: 'mixed' }, { source: 'B' }] }
const case1 = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: '<thinking>R</thinking>A' },
  { type: 'block-end', index: 1, block: { type: 'text', text: '<thinking>R</thinking>A' } },
  { type: 'block-start', index: 2, blockType: 'text' },
  { type: 'text-delta', index: 2, text: 'B' },
  { type: 'block-end', index: 2, block: { type: 'text', text: 'B' } },
  { type: 'finish', reason: { kind: 'stop' }, replayState: replay },
]
const out1 = await collect(guardStream(streamOf(case1)))
const host1 = hostAssembled(out1)
console.log('claim 1 blocks:', JSON.stringify(host1.blocks))
console.log('claim 1 replay kept:', JSON.stringify(host1.replay?.blocks ?? null))

// claim 2: a block-end carrying text but no block-start/delta
const case2 = [
  { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>R</thinking>' } },
]
const out2 = await collect(guardStream(streamOf(case2)))
console.log('\nclaim 2 blocks:', JSON.stringify(hostAssembled(out2).blocks))

// claim 3: consumer stops early
async function* endless() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '<thinking>held' }
  yield { type: 'text-delta', index: 0, text: ' more' }
  yield { type: 'finish', reason: { kind: 'stop' } }
}
const it = guardStream(endless())
const seen = []
for await (const c of it) { seen.push(c); if (seen.length === 2) break }
console.log('\nclaim 3 seen before break:', JSON.stringify(seen.map((c) => c.type)))
console.log('claim 3 iterator after break: state=', it.constructor.name)
