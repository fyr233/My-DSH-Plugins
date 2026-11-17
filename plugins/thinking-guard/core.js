/**
 * Marker-list rules, kept pure so they can be tested without a Harness runtime.
 *
 * A marker is the literal text a model opens its leaked reasoning with. The list
 * is user-editable because the set is open-ended: `<thinking>`, `<thought>`,
 * `<thought >`, `【思考】`, `[THINKING]` are all plausible, and a model can invent
 * the next spelling at any time.
 *
 * The stored value IS the matcher. Nothing is normalised away: whatever the user
 * saves is what the guard looks for, so a marker that is not a tag — `【思考】`,
 * `<<think>>`, `THINKING:` — works exactly the same way. Two consequences:
 *
 *   - entries are compared and deduplicated by their exact text, never by a
 *     derived "tag name", because there may be no tag name to derive;
 *   - the closing marker is inferred only when the entry looks like a tag
 *     (`<x>` → `</x>`); otherwise the block simply ends at `block-end`.
 *
 * Scope note: this plugin handles THINKING only. Checkpoint-shaped output
 * (`<analysis>`/`<summary>`) is deliberately not a default marker — collapsing
 * such a block hides the text but does not stop the model from ending the turn
 * after it, which is the actual damage. That belongs to the system-prompt rule,
 * not to a display fix. A user who wants it anyway can add the marker.
 */

/** Markers shipped by default: the spellings observed for reasoning on this profile. */
export const DEFAULT_MARKERS_TEXT = Object.freeze([
  '<thinking>',
  '<thought>',
])

/**
 * Longest accepted entry.
 *
 * This bound is real: the parser holds incoming text until it can prove the body
 * does not open with a marker, and the longest marker is exactly how much it may
 * hold. At 64 characters the hold is imperceptible; a 10 KB marker would delay
 * the first visible token of every reply.
 */
export const MAX_MARKER_LENGTH = 64

/**
 * Validate one marker entry: any non-empty text, at most MAX_MARKER_LENGTH.
 * @param entry - one raw list entry.
 * @returns the entry as saved (trimmed, otherwise untouched).
 * @throws when the entry cannot be a marker.
 */
export function validateMarker(entry) {
  if (typeof entry !== 'string') throw new Error('marker must be a string')
  const text = entry.trim()
  if (text === '') throw new Error('marker must not be empty')
  if (text.length > MAX_MARKER_LENGTH) throw new Error(`a marker must be at most ${MAX_MARKER_LENGTH} characters`)
  if (text.startsWith('</')) throw new Error('enter the opening marker (e.g. <thinking>), not the closing one')
  return text
}

/**
 * Infer the closing marker for an entry, when it has one.
 *
 * An angle-bracket tag yields its paired closing tag, and ATTRIBUTES ARE FINE:
 * `<thinking type="x">` closes with `</thinking>`, because attributes only ever
 * appear on the opening tag. Only the tag NAME matters.
 *
 * Anything that is not an angle-bracket tag — `【思考】`, `THINKING:`, a bare word —
 * has no inferable end. Such an entry is accepted but INACTIVE unless the user
 * supplies the closing text explicitly (`【思考】 => 【/思考】`), because treating
 * "unknown end" as "runs to block-end" would swallow the whole reply and leave
 * the turn with no visible text at all.
 *
 * @param text - the saved marker text (opening half).
 * @returns the closing text, or `undefined` when it must be given explicitly.
 */
export function closingFor(text) {
  if (text.length < 3 || !text.startsWith('<') || !text.endsWith('>')) return undefined
  const inner = text.slice(1, -1)
  // Tag name, optionally followed by whitespace and attributes.
  const match = /^([A-Za-z][A-Za-z0-9._:-]*)(?:\s[^>]*)?$/.exec(inner)
  if (match === null) return undefined
  return `</${match[1]}>`
}

/**
 * Split one entry into its opening text and its closing text.
 *
 * `open => close` supplies the closing text explicitly, which is the only way to
 * use a marker that is not an angle-bracket tag. Without `=>`, an angle-bracket
 * tag infers its pair and anything else stays without a closing text.
 * @param entry - one raw list entry.
 * @returns the opening text (as saved) and the closing text, if any.
 */
export function splitMarkerEntry(entry) {
  const text = validateMarker(entry)
  const sep = text.indexOf('=>')
  if (sep !== -1) {
    const open = validateMarker(text.slice(0, sep))
    const close = text.slice(sep + 2).trim()
    if (close === '') throw new Error('the closing marker after "=>" must not be empty')
    if (close.length > MAX_MARKER_LENGTH) throw new Error(`a marker must be at most ${MAX_MARKER_LENGTH} characters`)
    return { open, close }
  }
  return { open: text, close: closingFor(text) }
}

/**
 * Compile the saved entries into matchers, dropping exact duplicates.
 * @param entries - the saved list (or the defaults).
 * @returns compiled markers in first-seen order.
 */
export function compileMarkers(entries) {
  const seen = new Set()
  const markers = []
  for (const entry of entries) {
    const { open, close } = splitMarkerEntry(entry)
    if (seen.has(open)) continue
    seen.add(open)
    markers.push({ open, close, name: open })
  }
  return markers
}

/**
 * Validate a stored marker list.
 * @param value - candidate settings value.
 * @returns the list as it will be stored (trimmed, de-duplicated).
 * @throws with a message the Settings panel can show verbatim.
 */
export function validateMarkerList(value) {
  if (!Array.isArray(value)) throw new Error('markers must be a list')
  if (value.length === 0) throw new Error('keep at least one marker, or disable the guard')
  const seen = new Set()
  const out = []
  for (const entry of value) {
    const text = validateMarker(entry)
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * Compile markers, falling back to the defaults instead of throwing.
 * Used on the hot path (every model call), where a broken stored value must not
 * take the stream down: the guard degrades to the shipped list.
 * @param entries - the configured list, possibly invalid.
 * @returns compiled markers.
 */
export function safeCompileMarkers(entries) {
  try {
    const markers = compileMarkers(entries)
    return markers.length > 0 ? markers : compileMarkers(DEFAULT_MARKERS_TEXT)
  } catch {
    return compileMarkers(DEFAULT_MARKERS_TEXT)
  }
}
