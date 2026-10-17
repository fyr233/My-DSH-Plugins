/**
 * Seamless continue: resume an interrupted turn the way the model would have
 * carried on, not by asking it again.
 *
 * The problem this solves. A stopped turn leaves the interruption inside the
 * conversation: `turn/end: aborted`, an assistant message cut mid-sentence,
 * and often a tool call with no result. Sending "继续" asks the model to pick
 * up a conversation that visibly stopped, so it restarts (often from scratch)
 * instead of continuing.
 *
 * This plugin fixes the MODEL's view only. `/continue` queues a neutral
 * carrier; on the step that admits it, the `agent/pre-step` waterfall replaces
 * the step's messages so that:
 *
 *   - the carrier itself never reaches the model,
 *   - tool calls left without a result by the interruption are closed with a
 *     recovery result, and
 *   - the last thing the model sees is its own interrupted output or those
 *     recovered tool results, i.e. the point where it was stopped.
 *
 * The model therefore continues from the break with nothing saying "continue",
 * and the tool loop it was in the middle of resumes as if uninterrupted.
 *
 * The durable log is untouched: every user message, `turn/end`, and aborted
 * assistant message stays recorded, so the GUI transcript, fork, and replay
 * behave exactly as before.
 */
import { randomUUID } from 'node:crypto'

export const name = 'seamless-continue'

export const inject = ['commands', 'sessions']

/**
 * Turn endings the user can resume. `aborted` is a stop or an interrupt,
 * `interrupted` is a turn closed by restart recovery, and `max-tokens` is a
 * reply cut off by the output limit.
 */
const RESUMABLE_ENDS = new Set(['aborted', 'interrupted', 'max-tokens'])

/** Marker carried on the resume carrier so no user text ever triggers it. */
const CARRIER_SOURCE = { kind: 'user' }

/** Invisible carrier text: identity only, never sent to the model. */
const CARRIER_MARK = '\u2063'

/** Recovery text for a tool call the interruption left without a result. */
const RECOVERY_TEXT = 'The user interrupted this tool call before a result was recorded, so its outcome is unknown. '
  + 'Do not report it as successful or failed. Re-run it if it is read-only or idempotent, '
  + 'otherwise continue from the evidence already present in the conversation.'

/**
 * Fold a session log into the facts one resume needs.
 * @param events - the session events in seq order.
 * @returns the last turn's ending and the tool calls it still owes results for.
 */
export function foldResumeState(events) {
  let lastTurnEnd
  let pending = []
  for (const event of events) {
    switch (event.type) {
      case 'turn/start':
        pending = []
        break
      case 'tool/call':
        pending.push(event.data.callId)
        break
      case 'assistant/message':
        // The tool calls the model requested live in the message content.
        for (const block of event.data.message.content) {
          if (block.type === 'tool-call') pending.push(block.id)
        }
        break
      case 'tool/result':
        pending = pending.filter((callId) => callId !== event.data.message.toolCallId)
        break
      case 'turn/end':
        lastTurnEnd = event.data.reason
        // A closed turn owes nothing: its results are already durable.
        pending = []
        break
      default:
        break
    }
  }
  return { lastTurnEnd, pending }
}

/**
 * Whether the session's most recent turn can be resumed from its ending.
 * @param reason - the last recorded `turn/end` reason, if any.
 * @returns whether `/continue` accepts this session.
 */
export function isResumable(reason) {
  return reason !== undefined && RESUMABLE_ENDS.has(reason.kind)
}

/**
 * Build the synthetic tool results that close the calls the interruption left
 * dangling, keeping the resumed request a well-formed transcript.
 * @param callIds - tool call ids still missing a result.
 * @param turn - turn that owns the closers.
 * @param step - step that owns the closers.
 * @returns `tool/result` event payloads.
 */
export function recoveryResults(callIds, turn, step) {
  return callIds.map((callId) => ({
    turn,
    step,
    callId,
    message: {
      role: 'tool',
      content: [{ type: 'text', text: RECOVERY_TEXT }],
      source: { kind: 'tool', callId },
      toolCallId: callId,
      isError: false,
    },
  }))
}

/**
 * The carrier message queued for a resume. Its text is only an identity marker:
 * `pre-step` strips it before the step is built, so the model never reads it.
 * It is deliberately content-free, because whatever it says would be a prompt.
 * @returns a user message for `agent.followup`.
 */
export function carrierMessage() {
  // Same shape as the Harness' own createUserMessage: a stable fresh identity
  // plus role-tagged content. Built locally because a workspace bundle cannot
  // resolve the bundled @deepseek-ai packages.
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: CARRIER_MARK }],
    source: CARRIER_SOURCE,
  }
}

/**
 * Recognise this plugin's own carrier among a step's claimed messages.
 * @param message - one claimed message.
 * @returns whether it is a resume carrier.
 */
function isCarrier(message) {
  return message.source?.kind === 'user'
    && message.content.length === 1
    && message.content[0]?.type === 'text'
    && message.content[0].text === CARRIER_MARK
}

/**
 * Register `/continue` and the step rewrite that removes it.
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  /** Session ids with an open resume request; consumed by the admitting step. */
  const resuming = new Set()

  ctx.effect(() => {
    const dispose = ctx.commands.register({
      name: 'continue',
      description: 'Resume the interrupted turn from the break, as if it had not stopped',
      handler: ({ agent }) => {
        const session = ctx.sessions.get(agent.id)
        if (session === undefined) return { kind: 'error', text: '会话未连接。' }
        if (agent.status === 'running') return { kind: 'error', text: '仍在生成中：先停止，再执行 /continue。' }
        const { lastTurnEnd } = foldResumeState(session.snapshotEvents())
        if (!isResumable(lastTurnEnd)) {
          return { kind: 'error', text: '最近一轮已正常结束，没有可接续的中断。' }
        }
        resuming.add(agent.id)
        agent.followup(carrierMessage())
        return { kind: 'success', text: '已从断点继续。' }
      },
    })
    return () => {
      dispose()
      resuming.clear()
    }
  })

  ctx.on('agent/pre-step', async (payload, next) => {
    // Successive steps of the same turn claim no new message, so the carrier is
    // only present on the first admitting step. Detect it from the messages
    // themselves: an entry left behind by a stopped turn must never arm a later,
    // user-initiated step.
    const claimsCarrier = (messages) => messages.some((message) => isCarrier(message))

    if (!resuming.has(payload.agent.id) || !claimsCarrier(payload.messages)) return next()
    const decision = await next()
    if (decision.kind !== 'enter') return decision

    const claim = new Set(payload.messages)
    const remaining = decision.messages.filter((message) => !claim.has(message) || !isCarrier(message))
    if (remaining.length === decision.messages.length) return next() // not ours after all
    if (remaining.length > 0) return { ...decision, messages: remaining }

    // Nothing the user wrote remains. Closing the run with an empty list would
    // end the turn without calling the model, so the carrier is the one message
    // delivered — by the user source it can never be. The step therefore carries
    // a single item the user's own interruption left there (a queued message, or
    // a tool result): the model receives no instruction and continues from it.
    const session = ctx.sessions.get(payload.agent.id)
    if (session !== undefined) {
      const { pending } = foldResumeState(session.snapshotEvents())
      for (const result of recoveryResults(pending, payload.turn, payload.step)) {
        try {
          session.append('tool/result', result)
        } catch (error) {
          ctx.logger?.warn?.('seamless-continue: could not close an interrupted tool call: %s', String(error))
        }
      }
    }
    resuming.delete(payload.agent.id)
    return decision
  })
}
