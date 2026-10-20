/**
 * Reproduce the three claims from the review against the CURRENT code, using a
 * faithful mirror of the host BlockAssembler (closed index ignores later data).
 */
import { guardStream } from '../index.js'

/** Host assembler mirror, including the "closed block ignores later data" rule. */
function assemble(chunks) {
  const partials = new Map()
  const order = []
  const ensure = (index, blockType) => {
    let p = partials.get(index)
    if (!p) {
      p = { blockType, text: '', block: undefined }
      partials.set(index, p)
      order.push(index)
    }
    return p
  }
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': ensure(chunk.index, chunk.blockType); break
      case 'text-delta': {
        const p = ensure(chunk.index, 'text')
        if (!p.block) p.text += chunk.text
        break
      }
      case 'reasoning-delta': {
        const p = ensure(chunk.index, 'reasoning')
        if (!p.block) p.text += chunk.text
        break
      }
      case 'tool-call-delta': {
        const p = ensure(chunk.index, 'tool-call')
        if (!p.block) p.arguments = (p.arguments ?? '') + chunk.argumentsDelta
        break
      }
      case 'block-end': {
        const p = ensure(chunk.index, chunk.block.type)
        if (!p.block) p.block = chunk.block
        break
      }
      default: break
    }
  }
  return order.map((index) => {
    const p = partials.get(index)
    return p.block ?? { type: p.blockType, text: p.text }
  })
}

async function* streamOf(chunks) {
  for (const c of chunks) yield c
}

async function collect(it) {
  const out = []
  for await (const c of it) out.push(c)
  return out
}

// --- claim 1: an empty text block, then a real one
const case1 = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
  { type: 'block-start', index: 1, blockType: 'text' },
  { type: 'text-delta', index: 1, text: 'ANSWER' },
  { type: 'block-end', index: 1, block: { type: 'text', text: 'ANSWER' } },
]
const out1 = await collect(guardStream(streamOf(case1)))
console.log('claim 1 chunks:', JSON.stringify(out1.map((c) => `${c.type}@${c.index}`)))
console.log('claim 1 blocks:', JSON.stringify(assemble(out1)))

// --- claim 1b: <thinking></thinking> with no emission
const case1b = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '<thinking></thinking>' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking></thinking>' } },
]
const out1b = await collect(guardStream(streamOf(case1b)))
console.log('\nclaim 1b blocks:', JSON.stringify(assemble(out1b)))

// --- claim 2: delta-only tool call colliding with the split answer
const case2 = [
  { type: 'text-delta', index: 0, text: '<thinking>x</thinking>ANSWER' },
  { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' },
]
const out2 = await collect(guardStream(streamOf(case2)))
console.log('\nclaim 2 chunks:', JSON.stringify(out2.map((c) => `${c.type}@${c.index}`)))
console.log('claim 2 blocks:', JSON.stringify(assemble(out2)))

// --- claim 3: source throws mid-stream
async function* throwing() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '<thi' }
  throw new Error('network failure')
}
const seen = []
try {
  for await (const c of guardStream(throwing())) seen.push(c)
  console.log('\nclaim 3: no error surfaced')
} catch (error) {
  console.log('\nclaim 3: threw', JSON.stringify(error.message), 'chunks emitted before:', JSON.stringify(seen.map((c) => `${c.type}@${c.index}`)))
}

// --- finish ordering
const case4 = [
  { type: 'text-delta', index: 0, text: 'plain answer' },
  { type: 'finish', reason: { kind: 'stop' } },
]
const out4 = await collect(guardStream(streamOf(case4)))
console.log('\nfinish ordering:', JSON.stringify(out4.map((c) => c.type)))
