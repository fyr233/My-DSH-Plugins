/**
 * Thinking guard: keep the model's reasoning out of the message body.
 *
 * The `jp1` route answers `deepseek-v4.1-flash` on an OpenAI-compatible relay.
 * Its `detectCompat` heuristic treats a custom host as a plain OpenAI endpoint,
 * so the relay's thinking mode is left to the server: sometimes the reasoning
 * arrives in `reasoning_content`, sometimes it arrives inside `content` wrapped
 * in `<thinking>…</thinking>`, or as a checkpoint-shaped `<analysis>` … followed
 * by `<summary>` … Nothing in the wire contract distinguishes the two, and the
 * leaked text is durable: it is replayed to the model on every later request,
 * the model mimics its own format, and a reply that is only reasoning ends the
 * turn with `stop` — the task dies silently.
 *
 * This plugin fixes the message at the point it is RECEIVED, not after a turn
 * has already ended: it wraps `llm/stream`, the waterfall around every model
 * call, and rewrites the chunks before the agent loop assembles and appends the
 * assistant message.
 *
 * Two invariants drive the implementation:
 *
 *  1. **The block type is decided before any chunk for that block is emitted.**
 *     `block-start` is held until the first delta proves whether the body opens
 *     with a marker. A stream interrupted before `block-end` is then assembled
 *     by the host from the type we actually chose, so reasoning can never be
 *     committed as text.
 *
 *  2. **One parser decides, for every chunking of the same body.** Opening a
 *     marker immediately hands the remainder to the same closing-tag logic, and
 *     a closing tag returns to marker probing, so consecutive
 *     `<analysis>…</analysis><summary>…</summary>` bodies collapse into one
 *     reasoning block no matter how the deltas were split.
 *
 * Nothing is written to the session by the plugin, and no synthetic follow-up
 * message is queued.
 */

export const name = 'thinking-guard'

// `systemPrompt` is a hard dependency rather than an optional lookup: a section
// registered against a service that is not ready yet would be silently dropped,
// and nothing would retry it. A hard dependency makes the loader wait.
export const inject = ['llm', 'systemPrompt']

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
 *
 * One sentence in the system prompt is cheaper than any recovery machinery, and
 * it states the ownership rule plainly: compaction is the harness's job.
 */
export const DEFAULT_NOTE = 'Never produce a conversation summary, checkpoint, or <analysis>/<summary> block unless the user '
  + 'explicitly asks for one: context compaction is handled by the harness, and a summary you volunteer replaces the work '
  + 'you were asked to do.'

/**
 * Row config, overridable from the profile's `cordis.patch.yml`. Patch layers
 * replace the whole config object, so every key stays optional.
 *
 * Declared with Standard Schema's `~standard` protocol rather than a bare JSON
 * Schema: a JSON Schema object alone makes dsh look up a validator package this
 * workspace bundle cannot resolve, and the entry fails to activate.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugins-thinking-guard',
    validate(value) {
      const config = {}
      if (value === undefined || value === null) return { value: config }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'config must be an object', path: [] }] }
      }
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'markers') {
          if (!Array.isArray(entry) || entry.length === 0 || entry.some((m) => typeof m !== 'string' || m === '')) {
            return { issues: [{ message: 'markers must be a non-empty array of non-empty strings', path: [key] }] }
          }
          config.markers = entry
          continue
        }
        if (key === 'enabled') {
          if (typeof entry !== 'boolean') {
            return { issues: [{ message: 'enabled must be a boolean', path: [key] }] }
          }
          config.enabled = entry
          continue
        }
        if (key === 'systemPromptNote') {
          if (typeof entry !== 'string') {
            return { issues: [{ message: 'systemPromptNote must be a string (empty disables it)', path: [key] }] }
          }
          config.systemPromptNote = entry
          continue
        }
        return { issues: [{ message: `unknown config key: ${key}`, path: [key] }] }
      }
      return { value: config }
    },
  },
}

/**
 * Opening markers that mean the following text is reasoning, not an answer.
 * Each maps to the tag that closes it; an unclosed marker still reclassifies,
 * because a stream that ends mid-thought must not lose the partial reasoning.
 */
export const DEFAULT_MARKERS = [
  { open: '<thinking>', close: '</thinking>' },
  { open: '<analysis>', close: '</analysis>' },
  { open: '<summary>', close: '</summary>' },
  { open: '<compacted-summary>', close: '</compacted-summary>' },
]

/** Strip a byte-order mark and leading whitespace. */
function lead(text) {
  return text.replace(/^\uFEFF/, '').trimStart()
}

/** Logger used by the fail-safe paths; set by `apply`, absent in tests. */
let ctxLogger

/**
 * The trailing part of `text` that could still become `tag` once more arrives.
 * Holds back only the shortest such suffix, so a closing tag split across deltas
 * is still recognised while ordinary text is emitted immediately.
 * @param text - text accumulated so far.
 * @param tag - the tag being awaited.
 * @returns the suffix to keep, or `''` when none could match.
 */
export function partialTagSuffix(text, tag) {
  const limit = Math.min(tag.length - 1, text.length)
  for (let size = limit; size > 0; size -= 1) {
    if (text.endsWith(tag.slice(0, size))) return text.slice(text.length - size)
  }
  return ''
}

/**
 * Match an opening marker on already-leading text.
 * @param text - text with leading whitespace stripped.
 * @param markers - configured markers.
 * @returns the matched marker, or `undefined`.
 */
export function matchMarker(text, markers = DEFAULT_MARKERS) {
  return markers.find((marker) => text.startsWith(marker.open))
}

/**
 * Whether `text` could still become an opening marker.
 * @param text - text with leading whitespace stripped.
 * @param markers - configured markers.
 * @returns `true` while no decision is possible yet.
 */
export function isMarkerPrefix(text, markers = DEFAULT_MARKERS) {
  if (text === '') return true
  return markers.some((marker) => marker.open.startsWith(text) || text.startsWith(marker.open))
}

/**
 * The one parser over a text block's body.
 *
 * It is a pure state machine fed with deltas in any chunking; `push` returns the
 * emissions are now known, and `flush` releases whatever is still held so a
 * truncated stream loses nothing. Emissions carry the type they belong to, and
 * a change of type means "start a new block".
 *
 *   const p = createBlockParser()
 *   p.push('<thinking>x</thinking>A')
 *   // -> [{ kind: 'reasoning', text: 'x' }, { kind: 'text', text: 'A' }]
 */
export function createBlockParser(markers = DEFAULT_MARKERS) {
  let mode = 'probe' // probe | reasoning | text
  let buf = ''
  let closing = ''
  let openedWithMarker = false

  function drain(text = '') {
    const out = []
    let rest = text
    for (;;) {
      if (mode === 'text') {
        // `buf` may still hold text buffered while the mode was undecided.
        const body = buf + rest
        buf = ''
        if (body !== '') out.push({ kind: 'text', text: body })
        return { out, rest: '' }
      }
      if (mode === 'probe') {
        buf += rest
        rest = ''
        const trimmed = lead(buf)
        if (trimmed === '') return { out, rest: '' }
        const marker = matchMarker(trimmed, markers)
        if (marker !== undefined) {
          // Everything before the marker is whitespace and is dropped with it.
          buf = trimmed.slice(marker.open.length)
          mode = 'reasoning'
          closing = marker.close
          openedWithMarker = true
          continue
        }
        if (isMarkerPrefix(trimmed, markers)) return { out, rest: '' }
        mode = 'text'
        continue
      }
      // reasoning
      buf += rest
      rest = ''
      const at = buf.indexOf(closing)
      if (at === -1) {
        const tail = partialTagSuffix(buf, closing)
        const body = buf.slice(0, buf.length - tail.length)
        buf = tail
        if (body !== '') out.push({ kind: 'reasoning', text: body })
        return { out, rest: '' }
      }
      if (at > 0) out.push({ kind: 'reasoning', text: buf.slice(0, at) })
      buf = buf.slice(at + closing.length)
      // Back to probing: a second marker continues the same reasoning run,
      // while ordinary text is released as the visible answer.
      mode = 'probe'
    }
  }

  return {
    /**
     * Feed one delta.
     * @param text - the delta text.
     * @returns the emissions now decided, in order.
     */
    push(text) {
      return drain(text).out
    },
    /**
     * Release everything held when the body ends.
     * @returns the remaining emissions; empty when nothing was held.
     */
    flush() {
      const out = []
      if (buf !== '') {
        if (mode === 'reasoning') out.push({ kind: 'reasoning', text: buf })
        else out.push({ kind: 'text', text: lead(buf) })
        buf = ''
      }
      return out
    },

    /**
     * Whether this body opened with a marker — i.e. whether it is a leaked
     * thinking block rather than an ordinary answer. Once true it stays true,
     * even after the closing tag returns the parser to probing.
     */
    get openedWithMarker() {
      return openedWithMarker
    },
  }
}

/**
 * Split a complete body into its reasoning and its visible answer using the same
 * parser the stream uses, so both agree for every chunking.
 * @param text - the assembled block text.
 * @param markers - configured markers.
 * @returns the reasoning half and the answer half (either may be empty).
 */
export function splitTaggedBody(text, markers = DEFAULT_MARKERS) {
  const parser = createBlockParser(markers)
  const emissions = [...parser.push(text), ...parser.flush()]
  let reasoning = ''
  let answer = ''
  for (const emission of emissions) {
    if (emission.kind === 'reasoning') reasoning += emission.text
    else answer += emission.text
  }
  return { reasoning: reasoning.trim(), answer: answer.trim() }
}

/** Remove the opening/closing markers from a body, for diagnostics. */
export function stripTags(text, markers = DEFAULT_MARKERS) {
  let out = text
  for (const marker of markers) {
    out = out.split(marker.open).join('').split(marker.close).join('')
  }
  return out.replace(/^\uFEFF/, '').trim()
}

/**
 * Rewrite the chunk stream so the content type matches the content.
 *
 * ## Who owns the block index
 *
 * The host keys its assembler by block index and keeps blocks in the order they
 * were first seen. The index is the *adapter's* numbering, not a protocol field
 * the provider dictates: a middleware that rewrites the stream may therefore
 * number the blocks it emits, and it must — one source block may legitimately
 * become two output blocks (a reasoning run, then the prose that follows it).
 *
 * So every block this stream emits draws a number from one counter, and the
 * provider's index is only an input-side key. That includes blocks passed
 * through untouched (provider reasoning, tool calls) and blocks that turn out
 * empty: a chunk is never re-emitted with a provider index, because the host's
 * assembler would then merge it into whatever block already owns that number.
 *
 * ## What gets rewritten
 *
 * A text block is probed as its first bytes arrive:
 *
 *   - no marker  -> a text block, streamed through unchanged;
 *   - a marker   -> a reasoning block, streamed as `reasoning-delta`;
 *   - a marker followed by prose after its closing tag -> the reasoning block is
 *     closed and the prose continues in a new text block, so the thinking stays
 *     visible instead of being discarded;
 *   - nothing at all (an empty body, or `<thinking></thinking>` with no content)
 *     -> no block is emitted; the provider's empty chunk is dropped.
 *
 * The decision is made before any chunk of that block is emitted, so a stream
 * that ends without `block-end` assembles from the type this code chose — never
 * from the provider's original `text`.
 *
 * ## Termination
 *
 * Held text is released when the source ends, when it throws, and when a
 * `finish` arrives; a `finish` flush also keeps the terminal chunk last.
 *
 * A consumer that stops reading early (`break`, `return()`) cannot be served by
 * this generator: the host stops pulling, so whatever the `finally` block would
 * emit has nowhere to go. That is generator semantics, not a bug to paper over —
 * the interrupted path in the host rebuilds the message from the blocks it did
 * receive (`BlockAssembler.interruptedBlocks()`), which is why a block's type is
 * decided before its first chunk is emitted.
 *
 * @param source - the adapter's chunk stream.
 * @param markers - configured markers.
 * @returns a stream whose text blocks carry the type their body deserves.
 */
export async function* guardStream(source, markers = DEFAULT_MARKERS) {
  /** provider index -> the text block being built from it. */
  const textBlocks = new Map()
  /** provider index -> emitted index, for every non-text block. */
  const mapped = new Map()
  /** The single source of truth for block numbering. */
  let nextIndex = 0
  /** Whether the open text blocks have already been closed. */
  let settled = false
  /**
   * Whether the emitted blocks no longer correspond one-to-one, in order, to the
   * provider's blocks — because one was dropped (empty body) or split (reasoning
   * then prose). The host only compares block COUNTS before trusting replay
   * metadata, and a drop plus a split keeps the count equal while shifting every
   * entry, so a translator mismatch must clear the state itself.
   */
  let degraded = false

  function allocate() {
    return nextIndex++
  }

  /** The emitted index for a provider block that is passed through. */
  function mapIndex(providerIndex) {
    let index = mapped.get(providerIndex)
    if (index === undefined) {
      index = allocate()
      mapped.set(providerIndex, index)
    }
    return index
  }

  /** The output block a text source is currently filling. */
  function openOutput(state, kind) {
    const index = allocate()
    state.output = { index, kind, text: '' }
    return { type: 'block-start', index, blockType: kind }
  }

  /** Close the current output block, if any. */
  function closeOutput(state) {
    if (state.output === null) return undefined
    const block = { type: state.output.kind, text: state.output.text }
    const chunk = { type: 'block-end', index: state.output.index, block }
    state.output = null
    return chunk
  }

  /** Turn one parser emission into the chunks it should produce. */
  function absorb(out, state, emissions) {
    for (const emission of emissions) {
      if (state.output === null) {
        out.push(openOutput(state, emission.kind))
      } else if (state.output.kind !== emission.kind) {
        // The reasoning run ended and real prose follows: close it and open a
        // text block, so both halves survive as separate visible blocks.
        const closed = closeOutput(state)
        if (closed !== undefined) out.push(closed)
        out.push(openOutput(state, emission.kind))
        // One provider block became two: replay entries can no longer align.
        degraded = true
      }
      state.output.text += emission.text
      out.push(
        emission.kind === 'reasoning'
          ? { type: 'reasoning-delta', index: state.output.index, text: emission.text }
          : { type: 'text-delta', index: state.output.index, text: emission.text },
      )
    }
  }

  /** Handle one chunk into `out`, without yielding mid-way. */
  function handle(chunk, out) {
    switch (chunk.type) {
      case 'block-start': {
        if (chunk.blockType !== 'text') {
          out.push({ ...chunk, index: mapIndex(chunk.index) })
          return
        }
        textBlocks.set(chunk.index, {
          output: null,
          closed: false,
          passthrough: false,
          parser: createBlockParser(markers),
          /** Whether any delta arrived for this source block. */
          sawDelta: false,
        })
        return
      }
      case 'text-delta': {
        let state = textBlocks.get(chunk.index)
        if (state === undefined) {
          // Delta-only protocol: no block-start ever arrived.
          state = {
            output: null,
            closed: false,
            passthrough: false,
            parser: createBlockParser(markers),
            sawDelta: false,
          }
          textBlocks.set(chunk.index, state)
        }
        state.sawDelta = true
        if (state.passthrough) {
          out.push(chunk)
          return
        }
        absorb(out, state, state.parser.push(chunk.text))
        return
      }
      case 'block-end': {
        const state = textBlocks.get(chunk.index)
        if (state === undefined) {
          // No `block-start` and no deltas: a complete block arriving as one
          // event. A text body still needs parsing — dropping it here is how a
          // `<thinking>` wrapper used to survive into the transcript.
          if (chunk.block.type === 'text') {
            const fresh = {
              output: null,
              closed: false,
              passthrough: false,
              parser: createBlockParser(markers),
              sawDelta: true,
            }
            textBlocks.set(chunk.index, fresh)
            absorb(out, fresh, fresh.parser.push(chunk.block.text))
            absorb(out, fresh, fresh.parser.flush())
            const closed = closeOutput(fresh)
            if (closed !== undefined) out.push(closed)
            else degraded = true
            fresh.closed = true
            return
          }
          // A passed-through block: its index must be the one we emitted.
          out.push({ ...chunk, index: mapIndex(chunk.index) })
          return
        }
        if (state.passthrough) {
          out.push(chunk)
          return
        }
        if (!state.sawDelta) {
          // No deltas: the block's own body is all there is.
          absorb(out, state, state.parser.push(chunk.block.text))
        }
        absorb(out, state, state.parser.flush())
        const closed = closeOutput(state)
        // An empty body emits nothing at all. Forwarding the provider's chunk
        // here would reintroduce its index (possibly one we already handed out)
        // and, for a bare `<thinking></thinking>`, the tags we exist to remove.
        if (closed !== undefined) out.push(closed)
        else degraded = true
        state.closed = true
        return
      }
      default: {
        // Deltas of a passed-through block keep the index we assigned it.
        if (typeof chunk.index === 'number' && !textBlocks.has(chunk.index)) {
          out.push({ ...chunk, index: mapIndex(chunk.index) })
          return
        }
        out.push(chunk)
        return
      }
    }
  }

  /** Close every open text block, once. */
  function* settle() {
    if (settled) return
    settled = true
    for (const state of textBlocks.values()) {
      if (state.closed || state.passthrough) continue
      const out = []
      try {
        absorb(out, state, state.parser.flush())
        const closed = closeOutput(state)
        if (closed !== undefined) out.push(closed)
        state.closed = true
      } catch (error) {
        ctxLogger?.warn?.('thinking-guard: flush failure: %s', String(error))
      }
      for (const produced of out) yield produced
    }
  }

  try {
    for await (const chunk of source) {
      // `finish` is terminal for the host, so nothing may follow it: release the
      // held blocks first, then forward it.
      if (chunk.type === 'finish') yield* settle()
      const out = []
      try {
        handle(chunk, out)
      } catch (error) {
        // A guard failure must never fail the user's turn: pass the chunk
        // through untouched and report once.
        out.length = 0
        out.push(chunk)
        ctxLogger?.warn?.('thinking-guard: helper failure, passing the chunk through: %s', String(error))
      }
      // Once the block mapping has shifted, per-block provider metadata names
      // the wrong content. Clear it rather than let the host's count check pass
      // it through: the adapter then rebuilds this one message provider-neutral.
      // The key must be REMOVED, not set to `undefined`: the host validates every
      // chunk as lossless JSON, and a present-but-undefined property fails that
      // walk ("Assistant stream chunk must be losslessly JSON-serializable").
      for (let i = 0; i < out.length; i += 1) {
        const produced = out[i]
        if (degraded && produced.type === 'finish' && produced.replayState !== undefined) {
          const { replayState: _dropped, ...rest } = produced
          out[i] = rest
        }
      }
      for (const produced of out) yield produced
    }
  } finally {
    // Normal end, source failure, or an early consumer stop: release what is
    // held so a truncated stream never silently loses text.
    yield* settle()
  }
}

/**
 * Register the stream guard.
 * @param ctx - plugin context.
 * @param config - resolved row config (see {@link Config}).
 */
export function apply(ctx, config = {}) {
  if (config?.enabled === false) return
  ctxLogger = ctx.logger
  const markers = config?.markers === undefined
    ? DEFAULT_MARKERS
    : config.markers.map((open) => {
      const known = DEFAULT_MARKERS.find((marker) => marker.open === open)
      return known ?? { open, close: `</${open.slice(1)}` }
    })

  // One line in the system prompt, before any tool section: the model must not
  // take compaction into its own hands. `systemPromptNote: ''` removes it.
  const note = config?.systemPromptNote === undefined ? DEFAULT_NOTE : config.systemPromptNote
  if (note.trim() !== '') {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt !== undefined) {
      ctx.effect(() => systemPrompt.section({
        name: 'thinking-guard:no-self-compaction',
        order: 400,
        text: note,
      }))
    } else {
      ctxLogger?.warn?.('thinking-guard: systemPrompt service unavailable; the note was not installed')
    }
  }

  ctx.on('llm/stream', (_options, next) => guardStream(next(), markers))
}
