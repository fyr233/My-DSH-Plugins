/**
 * Checks for the stream guard. The assembler below mirrors the Harness'
 * BlockAssembler, including `interruptedBlocks()`'s rule that an unclosed block
 * keeps the type it was first created with — the exact rule that made a
 * reasoning delta assemble as text before this design.
 */
import assert from 'node:assert/strict'
import {
  createBlockParser,
  guardStream,
  matchMarker,
  isMarkerPrefix,
  splitTaggedBody,
  stripTags,
  DEFAULT_MARKERS,
} from '../index.js'

let checks = 0
async function check(name, fn) {
  await fn()
  checks += 1
  console.log(`ok ${name}`)
}

/** Mirror of the Harness BlockAssembler: first `ensure` fixes the type. */
function assemble(chunks) {
  const partials = new Map()
  const order = []
  const ensure = (index, blockType) => {
    let p = partials.get(index)
    if (!p) {
      p = { blockType, text: '' }
      partials.set(index, p)
      order.push(index)
    }
    return p
  }
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': ensure(chunk.index, chunk.blockType); break
      // The host ignores data for a block it already closed: this rule is what
      // turns an index collision into silent data loss, so the mirror keeps it.
      case 'text-delta': { const p = ensure(chunk.index, 'text'); if (!p.block) p.text += chunk.text; break }
      case 'reasoning-delta': { const p = ensure(chunk.index, 'reasoning'); if (!p.block) p.text += chunk.text; break }
      case 'tool-call-delta': { const p = ensure(chunk.index, 'tool-call'); if (!p.block) p.arguments = (p.arguments ?? '') + chunk.argumentsDelta; break }
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
    if (p.block) return p.block
    if (p.blockType === 'tool-call') return { type: 'tool-call', id: p.id ?? 'call-x', name: p.name ?? 'x', arguments: p.arguments ?? '' }
    return { type: p.blockType, text: p.text }
  })
}

/** The host keeps whatever an unclosed block accumulated, typed as first seen. */
function interrupted(chunks) {
  const partials = new Map()
  const order = []
  const ensure = (index, blockType) => {
    let p = partials.get(index)
    if (!p) {
      p = { blockType, text: '' }
      partials.set(index, p)
      order.push(index)
    }
    return p
  }
  for (const chunk of chunks) {
    switch (chunk.type) {
      case 'block-start': ensure(chunk.index, chunk.blockType); break
      case 'text-delta': ensure(chunk.index, 'text').text += chunk.text; break
      case 'reasoning-delta': ensure(chunk.index, 'reasoning').text += chunk.text; break
      case 'block-end': {
        const p = ensure(chunk.index, chunk.block.type)
        p.block = chunk.block
        break
      }
      default: break
    }
  }
  return order
    .map((index) => {
      const p = partials.get(index)
      return p.block ?? { type: p.blockType, text: p.text }
    })
    .filter((b) => (b.type === 'text' || b.type === 'reasoning') && b.text.trim() !== '')
}

const streamOf = (chunks) => (async function* () { for (const c of chunks) yield c })()
const collect = async (iterable) => {
  const out = []
  for await (const c of iterable) out.push(c)
  return out
}

/** Every chunking of `body` into n-character slices. */
function slices(body, size) {
  const out = []
  for (let i = 0; i < body.length; i += size) out.push(body.slice(i, i + size))
  return out
}

/** Build a provider stream for one text block with the given deltas. */
function blockStream(deltas) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    ...deltas.map((text) => ({ type: 'text-delta', index: 0, text })),
    { type: 'block-end', index: 0, block: { type: 'text', text: deltas.join('') } },
  ]
}

// ---------------------------------------------------------------- markers ---

await check('a plain answer is left alone', () => {
  assert.equal(matchMarker('Here is the fix.'), undefined)
  assert.equal(isMarkerPrefix('Here'), false)
})

await check('every default marker is recognised', () => {
  for (const marker of DEFAULT_MARKERS) assert.equal(matchMarker(`${marker.open}body`), marker)
})

await check('leading BOM and whitespace do not hide a marker', () => {
  assert.deepEqual(splitTaggedBody('\uFEFF\n  <thinking>x</thinking>'), { reasoning: 'x', answer: '' })
})

await check('a tag quoted mid-answer is not a marker', () => {
  assert.equal(matchMarker('The parser strips <thinking> tags.'), undefined)
})

// ------------------------------------------------------- parser semantics ---

await check('opening and closing tags in one delta are both handled', () => {
  const p = createBlockParser()
  assert.deepEqual(p.push('<thinking>x</thinking>A'), [
    { kind: 'reasoning', text: 'x' },
    { kind: 'text', text: 'A' },
  ])
})

await check('the same body split across deltas gives the same result', () => {
  const bodies = [
    '<thinking>x</thinking>A',
    '<analysis>a</analysis><summary>s</summary>',
    '<thinking>only thoughts, no closing tag',
    'no tags at all',
    '<thinking>a</thinking>tail<x>',
  ]
  /** Collapse emissions into the visible outcome: text and reasoning runs. */
  const merge = (emissions) => {
    const runs = []
    for (const e of emissions) {
      const last = runs.at(-1)
      if (last !== undefined && last.kind === e.kind) last.text += e.text
      else runs.push({ kind: e.kind, text: e.text })
    }
    return runs.map((r) => `${r.kind}:${r.text}`).join('|')
  }
  for (const body of bodies) {
    const parser = createBlockParser()
    const one = [...parser.push(body), ...parser.flush()]
    const chunked = createBlockParser()
    const many = [...[...body].flatMap((ch) => chunked.push(ch)), ...chunked.flush()]
    assert.equal(merge(many), merge(one), `chunking changed the result for ${body}`)
  }
})

await check('consecutive checkpoint blocks collapse into one reasoning run', () => {
  assert.deepEqual(splitTaggedBody('<analysis>x</analysis>\n\n<summary>y</summary>'), {
    reasoning: 'xy',
    answer: '',
  })
})

await check('reasoning followed by a real answer keeps the answer', () => {
  assert.deepEqual(splitTaggedBody('<thinking>steps</thinking>Final answer: 42.'), {
    reasoning: 'steps',
    answer: 'Final answer: 42.',
  })
})

await check('stripTags removes every configured tag', () => {
  assert.equal(stripTags('<thinking>abc</thinking>'), 'abc')
})

// ------------------------------------------------------------- the stream ---

await check('a leaked thinking-only reply assembles as one reasoning block', async () => {
  const chunks = await collect(guardStream(streamOf(blockStream(['<thinking>step one, step two</thinking>']))))
  assert.deepEqual(assemble(chunks), [{ type: 'reasoning', text: 'step one, step two' }])
})

await check('a thinking block followed by an answer keeps both blocks', async () => {
  // The thinking must stay visible, so the source block becomes two: the
  // reasoning run, then the prose. The plugin numbers the blocks it emits.
  const chunks = await collect(guardStream(streamOf(blockStream(['<thinking>steps</thinking>Final answer: 42.']))))
  assert.deepEqual(assemble(chunks), [
    { type: 'reasoning', text: 'steps' },
    { type: 'text', text: 'Final answer: 42.' },
  ])
  assert.deepEqual(
    chunks.filter((c) => c.type === 'block-start').map((c) => `${c.index}:${c.blockType}`),
    ['0:reasoning', '1:text'],
  )
})

for (const size of [1, 3, 7]) {
  await check(`chunk size ${size} produces the same blocks as one chunk`, async () => {
    const body = '<analysis>look</analysis><summary>found it</summary>Done: fixed.'
    const reference = assemble(await collect(guardStream(streamOf(blockStream([body])))))
    const chunked = assemble(await collect(guardStream(streamOf(blockStream(slices(body, size))))))
    assert.deepEqual(chunked, reference)
  })
}

await check('no delta is emitted twice', async () => {
  const chunks = await collect(guardStream(streamOf(blockStream(['<thinking>alpha', ' beta', ' gamma</thinking>']))))
  const streamed = chunks.filter((c) => c.type === 'reasoning-delta').map((c) => c.text).join('')
  assert.equal(streamed, 'alpha beta gamma')
})

await check('an interrupted block assembles as reasoning, never as text', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>private reasoning' },
    // no block-end: the stream is cut here
  ])))
  assert.deepEqual(interrupted(chunks), [{ type: 'reasoning', text: 'private reasoning' }])
  assert.equal(chunks.filter((c) => c.type === 'block-start' && c.blockType === 'text').length, 0)
})

await check('an interrupted plain answer still assembles as text', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'partial answer' },
  ])))
  assert.deepEqual(interrupted(chunks), [{ type: 'text', text: 'partial answer' }])
})

await check('a truncated tag prefix is not lost', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thi' },
  ])))
  const blocks = assemble(chunks)
  assert.equal(blocks[0].text, '<thi')
})

await check('a truncated closing tag inside reasoning is not lost', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>body</thi' },
  ])))
  const blocks = assemble(chunks)
  assert.deepEqual(blocks, [{ type: 'reasoning', text: 'body</thi' }])
})

await check('a normal reply keeps one text block and gains no chunks', async () => {
  const chunks = await collect(guardStream(streamOf(blockStream(['Here is the fix.']))))
  assert.deepEqual(assemble(chunks), [{ type: 'text', text: 'Here is the fix.' }])
  assert.equal(chunks.filter((c) => c.type === 'block-start').length, 1)
  assert.equal(chunks.filter((c) => c.type === 'block-end').length, 1)
})

await check('provider reasoning blocks pass through untouched', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'real reasoning' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'real reasoning' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
  ])))
  assert.deepEqual(assemble(chunks), [
    { type: 'reasoning', text: 'real reasoning' },
    { type: 'text', text: 'answer' },
  ])
})

await check('tool calls, usage and finish keep their order', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>x</thinking>' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>x</thinking>' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ])))
  assert.deepEqual(assemble(chunks).map((b) => b.type), ['reasoning', 'tool-call'])
  assert.equal(chunks.filter((c) => c.type === 'usage').length, 1)
  assert.equal(chunks.at(-1).type, 'finish')
})

await check('a delta-only stream with no block-start is still classified', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'text-delta', index: 0, text: '<thinking>delta only' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])))
  assert.deepEqual(assemble(chunks), [{ type: 'reasoning', text: 'delta only' }])
})

await check('every emitted index is a non-negative safe integer', async () => {
  // The host rejects the whole turn on an invalid index, so this is a hard
  // invariant, not a cosmetic one: it is exactly what broke turn 10.
  const cases = [
    blockStream(['<thinking>x</thinking>answer']),
    blockStream(['<analysis>a</analysis><summary>s</summary>Done.']),
    blockStream(['plain']),
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>cut' },
    ],
  ]
  for (const chunks of cases) {
    for (const chunk of await collect(guardStream(streamOf(chunks)))) {
      if ('index' in chunk) {
        assert.ok(Number.isSafeInteger(chunk.index), `index ${chunk.index} is not a safe integer`)
        assert.ok(chunk.index >= 0, `index ${chunk.index} is negative`)
      }
    }
  }
})

await check('the mixed case keeps the reasoning block and the answer', async () => {
  const chunks = await collect(guardStream(streamOf(blockStream(['<thinking>why</thinking>because']))))
  assert.deepEqual(assemble(chunks), [
    { type: 'reasoning', text: 'why' },
    { type: 'text', text: 'because' },
  ])
})

await check('block indexes are unique, increasing and non-negative', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>a</thinking>b' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>a</thinking>b' } },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call-1', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' } },
  ])))
  const indexes = chunks.filter((c) => 'index' in c).map((c) => c.index)
  assert.ok(indexes.every((i) => Number.isSafeInteger(i) && i >= 0), `bad index in ${indexes}`)
  const starts = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
  assert.deepEqual(starts, [0, 1, 2])
  // A remapped tool call keeps its id and lands after the two text blocks.
  assert.deepEqual(assemble(chunks).map((b) => b.type), ['reasoning', 'text', 'tool-call'])
})

await check('an ordinary answer still streams without buffering', async () => {
  const seen = []
  const chunks = [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'first, ' },
    { type: 'text-delta', index: 0, text: 'second' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'first, second' } },
  ]
  for await (const chunk of guardStream(streamOf(chunks))) seen.push(chunk)
  // Each delta is emitted as it arrives, not held to the end.
  assert.deepEqual(
    seen.map((c) => c.type === 'text-delta' ? `d:${c.text}` : c.type),
    ['block-start', 'd:first, ', 'd:second', 'block-end'],
  )
})


// ------------------------------------------- regressions from the index review

await check('an empty text block does not steal the next block index', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'ANSWER' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'ANSWER' } },
  ])))
  assert.deepEqual(assemble(chunks), [{ type: 'text', text: 'ANSWER' }])
})

await check('an empty thinking block emits nothing at all', async () => {
  const chunks = await collect(guardStream(streamOf(blockStream(['<thinking></thinking>']))))
  assert.deepEqual(assemble(chunks), [])
  assert.equal(chunks.length, 0)
})

await check('a delta-only tool call never collides with a split answer', async () => {
  // Tool call first, answer second: the order that used to lose data.
  const chunks = await collect(guardStream(streamOf([
    { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'read', argumentsDelta: '{}' },
    { type: 'text-delta', index: 1, text: '<thinking>x</thinking>ANSWER' },
  ])))
  const blocks = assemble(chunks)
  assert.deepEqual(blocks.map((b) => b.type), ['tool-call', 'reasoning', 'text'])
  assert.equal(blocks.at(-1).text, 'ANSWER')
  const starts = chunks.filter((c) => c.type === 'block-start').map((c) => c.index)
  assert.deepEqual(starts, [1, 2], 'no two blocks share an index')
})

await check('a source failure still releases the held prefix', async () => {
  async function* failing() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: '<thi' }
    throw new Error('network failure')
  }
  const seen = []
  await assert.rejects(async () => {
    for await (const c of guardStream(failing())) seen.push(c)
  }, /network failure/)
  // The error still propagates, and the buffered text was not dropped.
  assert.deepEqual(assemble(seen), [{ type: 'text', text: '<thi' }])
})

await check('finish is always the last chunk', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'text-delta', index: 0, text: 'plain answer' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(assemble(chunks), [{ type: 'text', text: 'plain answer' }])
})

await check('a thinking block that ends on finish is closed before finish', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'text-delta', index: 0, text: '<thinking>partial' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])))
  assert.equal(chunks.at(-1).type, 'finish')
  assert.deepEqual(assemble(chunks), [{ type: 'reasoning', text: 'partial' }])
})


// ------------------------------------- regressions from the replay/block review

await check('a drop plus a split clears the replay state', async () => {
  // Block count stays 3 (one dropped, one split), so the host's length check
  // would happily accept metadata that now names the wrong blocks.
  const replay = { response: { ok: true }, blocks: [{ source: 'empty' }, { source: 'mixed' }, { source: 'B' }] }
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '<thinking>R</thinking>A' },
    { type: 'block-end', index: 1, block: { type: 'text', text: '<thinking>R</thinking>A' } },
    { type: 'block-start', index: 2, blockType: 'text' },
    { type: 'text-delta', index: 2, text: 'B' },
    { type: 'block-end', index: 2, block: { type: 'text', text: 'B' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: replay },
  ])))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal(finish.replayState, undefined, 'stale replay metadata must not survive a remap')
  assert.deepEqual(assemble(chunks), [
    { type: 'reasoning', text: 'R' },
    { type: 'text', text: 'A' },
    { type: 'text', text: 'B' },
  ])
})

await check('an untouched stream keeps its replay state', async () => {
  const replay = { response: { ok: true }, blocks: [{ source: 'A' }] }
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'plain' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'plain' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: replay },
  ])))
  assert.deepEqual(chunks.at(-1).replayState, replay)
})

await check('a whole text block arriving only as block-end is still parsed', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>R</thinking>' } },
  ])))
  assert.deepEqual(assemble(chunks), [{ type: 'reasoning', text: 'R' }])
})

await check('a whole answer arriving only as block-end stays a text block', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'just an answer' } },
  ])))
  assert.deepEqual(assemble(chunks), [{ type: 'text', text: 'just an answer' }])
})


// Mirror of @deepseek-ai/dsh-util-values walkJsonValue: undefined, NaN,
// Infinity, -0, sparse arrays, class instances and cycles are all rejected.
function isLosslessJson(value, ancestors = new Set()) {
  if (value === null) return true
  const type = typeof value
  if (type === 'boolean' || type === 'string') return true
  if (type === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (type !== 'object') return false
  if (ancestors.has(value)) return false
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1) return false
    ancestors.add(value)
    for (let i = 0; i < value.length; i += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, i)) return false
      if (!isLosslessJson(value[i], ancestors)) return false
    }
    ancestors.delete(value)
    return true
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null && proto !== Object.prototype) return false
  ancestors.add(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) return false
    if (!isLosslessJson(value[key], ancestors)) return false
  }
  ancestors.delete(value)
  return true
}

await check('every emitted chunk survives the host JSON validator', async () => {
  // The exact failure this guards against: "Assistant stream chunk must be
  // losslessly JSON-serializable" — a present-but-undefined property fails it.
  const cases = [
    blockStream(['<thinking>R</thinking>A']),
    blockStream(['plain answer']),
    blockStream(['<thinking></thinking>']),
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '<thinking>x' },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { blocks: [{ a: 1 }] } },
    ],
    [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: '' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '<thinking>R</thinking>A' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '<thinking>R</thinking>A' } },
      { type: 'finish', reason: { kind: 'stop' }, replayState: { blocks: [{ a: 1 }, { b: 2 }] } },
    ],
  ]
  for (const chunks of cases) {
    for (const chunk of await collect(guardStream(streamOf(chunks)))) {
      assert.ok(isLosslessJson(chunk), 'chunk is not lossless JSON: ' + JSON.stringify(chunk))
    }
  }
})

await check('a cleared replay state removes the key entirely', async () => {
  const chunks = await collect(guardStream(streamOf([
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: '<thinking>R</thinking>A' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '<thinking>R</thinking>A' } },
    { type: 'finish', reason: { kind: 'stop' }, replayState: { blocks: [{ a: 1 }] } },
  ])))
  const finish = chunks.at(-1)
  assert.equal(finish.type, 'finish')
  assert.equal('replayState' in finish, false, 'the key must be absent, not undefined')
})

console.log(`\n${checks} checks passed`)
