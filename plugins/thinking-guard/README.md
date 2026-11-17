# thinking-guard

Keep the model's reasoning out of the message body, at the moment the message is
received — and still show it as a reasoning block.

## The failure this fixes

On a custom OpenAI-compatible relay the harness cannot tell that the route serves
a DeepSeek model, so the server decides per request how to return reasoning:

- sometimes in a structured `reasoning_content` field (correct), and
- sometimes inline in `content`, wrapped in `<thinking>…</thinking>`, or as a
  checkpoint-shaped `<analysis>…</analysis>` followed by `<summary>…</summary>`.

The inline form lands in the durable transcript as a normal text block. Three
things then follow:

1. the body renders reasoning as the answer;
2. the leaked text is replayed to the model on every later request, and the model
   mimics its own format, so the leak becomes self-amplifying;
3. when a reply is *only* reasoning it carries no text and no tool call, so the
   turn ends with `stop` and the task dies with no error.

Measured on this machine: 54 of 5656 assistant messages (0.95%) carried a
literal marker, and the rate inside one long session reached 10–39% after the
first hit.

## What the plugin does

It wraps `llm/stream` — the waterfall around every model call — and rewrites the
chunks **before** the agent loop assembles and appends the assistant message:

- a text block whose body opens with a marker has its deltas re-emitted as
  `reasoning-delta`;
- the assembled block is a reasoning block, not a text block;
- opening and closing tags are dropped;
- if the body continues after the closing tag, the trailing part stays a text
  answer (in its own block);
- consecutive marker blocks collapse into one reasoning run.

Nothing is written to the session by the plugin, and no synthetic follow-up
message is queued. The plugin does **not** resume a stopped turn; it only makes
sure a leaked body never becomes the stored answer.

Only content that **opens** a text block is reclassified: a tag quoted mid-reply
is prose and is left alone.

## Invariants the implementation keeps

1. **The block type is decided before any chunk of that block is emitted.**
   `block-start` is held until the first delta proves whether the body opens with
   a marker. An interrupted stream is therefore assembled by the host from the
   type we actually chose — a cancelled or errored call can never commit
   reasoning as text. (`BlockAssembler.interruptedBlocks()` uses the type of the
   block's first `ensure`, so emitting `block-start: text` first would lose this.)
2. **One parser decides for every chunking.** Opening a marker immediately hands
   the remainder to the same closing-tag logic, and a closing tag returns to
   marker probing — so `<analysis>…</analysis><summary>…</summary>` is one
   reasoning run whether it arrives in one delta or one character at a time.
3. **Nothing held is lost.** `flush()` runs on `block-end`, at end of stream, and
   on a delta-only stream, so a truncated `<thi` or `</thi` still reaches the
   transcript instead of disappearing.
4. **The plugin owns the block numbering.** The host keys its assembler by block
   index and keeps blocks in the order they were first seen. That index is the
   adapter's numbering, not a provider protocol field, so a stream-rewriting
   plugin may number the blocks it emits: every emitted block takes the next
   number from one counter, and the provider index is only an input-side key.
   This is what lets one source block become two output blocks (reasoning, then
   prose) with no collisions and no invented constant, while pass-through blocks
   (provider reasoning, tool calls) are remapped the same way.

5. **Replay metadata is cleared when the mapping shifts.** Dropping an empty block
   and splitting a mixed one can leave the block COUNT unchanged while shifting
   every entry, and the host only compares counts. The plugin tracks whether any
   block was dropped or split and, on that path, forwards `finish` without its
   `replayState` — the adapter then rebuilds that one message provider-neutral
   instead of pairing provider metadata with the wrong content. Measured cost:
   0.27% of 5954 messages degrade, which works out to roughly one percentage
   point of cache-read share in affected sessions.

6. **Every emitted chunk is lossless JSON.** The host walks each chunk and rejects
   `undefined`, `NaN`, `Infinity`, `-0`, sparse arrays, class instances and
   cycles. A property must therefore be REMOVED, never set to `undefined`: the
   latter fails the walk and aborts the turn with "Assistant stream chunk must be
   losslessly JSON-serializable".

7. **Nothing is buffered except a tag decision.** An ordinary answer streams delta
   by delta; the parser holds bytes only while the leading characters could still
   turn out to be a marker.

## Preferences

Two surfaces write the same record: the Settings panel and the `thinking_guard`
tool.

| Field | Default | Meaning |
|---|---|---|
| `markers` | `["<thinking>", "<thought>"]` | Opening text a body must start with. Matched literally, with no tag-name derivation. |
| `enabled` | `true` | Off means the plugin does not touch the stream at all. |
| `keepMarkers` | `false` | Keep the marker text inside the folded block, for checking why it was folded. |
| `note` | the no-self-compaction sentence | The system-prompt line. |

A marker is whatever the user saves. `<thinking>` closes with `</thinking>`;
`<thinking type="x">` also closes with `</thinking>` (attributes only ever appear on
the opening tag); anything that is not an angle-bracket tag — `【思考】` — has no
inferable end and must be saved as `【思考】 => 【/思考】`. A marker with no closing
text is **inert**: it is accepted but never reclassifies, because swallowing an
unclosed body would leave the turn with no visible text at all.

Preferences live in `~/.dsh/thinking-guard/settings.json`, written atomically, and
behind one loopback-only route:

```
GET  /thinking-guard/api/settings
POST /thinking-guard/api/settings   { markers, enabled, keepMarkers }
```

Why not the Host settings namespace: its editable-form projection reads schemastery
internals (`meta.volatile` / `dict`), and a workspace-linked bundle cannot resolve
`@deepseek-ai/schemastery` — importing it fails the load and violates this repo's
"no dsh package imports" rule. `dsh-ui-sound` solved the same problem the same way.

The patch layer still works for a first-run default:

```yaml
- id: thinking-guard
  config:
    enabled: true
    markers: ['<thinking>', '<thought>', '【思考】 => 【/思考】']
    keepMarkers: false
```

A saved preference wins over the patch layer, so a GUI edit is not reverted on the
next restart.

## Tests

```
node test/check.mjs     # runs all three suites
```

| Suite | Checks | Covers |
|---|---|---|
| `check.mjs` | 44 | marker matching, chunking equivalence, mixed bodies, interrupted assembly, block numbering, replay clearing, lossless JSON, marker retention |
| `core.test.mjs` | 15 | literal marker rules, closing derivation, inert markers, list limits |
| `host.test.mjs` | 9 | Standard-Schema validation, file round-trip, loopback trust |
