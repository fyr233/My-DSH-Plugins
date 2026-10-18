/**
 * Focused check of the plugin's fold/resume logic against synthetic session
 * logs. Runs the real exported functions from index.js.
 */
import assert from 'node:assert/strict'
import { apply, foldResumeState, isResumable, recoveryResults, carrierMessage, Config } from '../index.js'

const seq = (n) => n // the fold only reads types and payload fields

/** A turn stopped mid tool loop: call 1 answered, call 2 never got a result. */
const interruptedToolLoop = [
  { seq: 0, type: 'turn/start', data: { turn: 1 } },
  { seq: 1, type: 'step/start', data: { turn: 1, step: 1 } },
  { seq: 2, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c1' }] } } },
  { seq: 3, type: 'tool/result', data: { message: { toolCallId: 'c1' } } },
  { seq: 4, type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'c2' }] } } },
  { seq: 5, type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } },
]

/** A turn stopped mid-answer: text, no tool calls, aborted. */
const interruptedAnswer = [
  { seq: 0, type: 'turn/start', data: { turn: 2 } },
  { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'partial' }] } } },
  { seq: 2, type: 'turn/end', data: { reason: { kind: 'aborted' } } },
]

/** A turn that ended normally. */
const completed = [
  { seq: 0, type: 'turn/start', data: { turn: 3 } },
  { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done' }] } } },
  { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } },
]

// Tool loop: the abort closed the turn, so no call is reported dangling.
const loop = foldResumeState(interruptedToolLoop)
assert.equal(loop.pending.length, 0, 'a closed turn owes nothing')
assert.equal(isResumable(loop.lastTurnEnd), true)
assert.equal(isResumable(foldResumeState(interruptedAnswer).lastTurnEnd), true)
assert.equal(isResumable(foldResumeState(completed).lastTurnEnd), false)

// A turn still OPEN when the process died: the call has no result yet.
const openLoop = interruptedToolLoop.slice(0, 5)
const open = foldResumeState(openLoop)
assert.deepEqual(open.pending, ['c2'], 'an open interrupted turn owes its last call')
assert.equal(open.lastTurnEnd, undefined, 'no ending recorded')

// Recovery results are shaped as real tool results for the owed calls.
const results = recoveryResults(open.pending, 2, 1)
assert.equal(results.length, 1)
assert.equal(results[0].callId, 'c2')
assert.equal(results[0].message.role, 'tool')
assert.equal(results[0].message.toolCallId, 'c2')
assert.equal(results[0].message.source.kind, 'tool')
assert.equal(results[0].turn, 2)
assert.equal(results[0].step, 1)

// The carrier is user-authored, single-text, and self-identifying.
const carrier = carrierMessage()
assert.equal(carrier.role, 'user')
assert.equal(carrier.content.length, 1)
assert.equal(carrier.content[0].type, 'text')
assert.ok(typeof carrier.id === 'string' && carrier.id.length > 0)
assert.notEqual(carrierMessage().id, carrier.id, 'each carrier has a fresh identity')

// Only aborted, interrupted, and max-tokens are resumable.
for (const [kind, expected] of [['aborted', true], ['interrupted', true], ['max-tokens', true], ['completed', false], ['error', false], ['blocked', false]]) {
  assert.equal(isResumable({ kind }), expected, `${kind} resumable?`)
}
assert.equal(isResumable(undefined), false)

// --- wiring: the command, the rewrite, and the disarm path -------------------
/** A minimal Cordis-like context that records what apply() registers. */
function fakeContext({ lastTurnEnd = { kind: 'aborted' }, status = 'idle' } = {}) {
  const registered = { commands: [], listeners: [], effects: [] }
  const appended = []
  const followups = []
  const ctx = {
    effect(fn) {
      registered.effects.push(fn)
      return fn()
    },
    on(name, listener) {
      registered.listeners.push({ name, listener })
      return () => {}
    },
    commands: {
      register(definition) {
        registered.commands.push(definition)
        return () => {}
      },
    },
    sessions: {
      get: () => ({
        snapshotEvents: () => [{ type: 'turn/end', data: { reason: lastTurnEnd } }],
        append: (type, data) => appended.push({ type, data }),
      }),
    },
    logger: { warn: () => {} },
  }
  const agent = { id: 'agent-1', status, followup: (message) => followups.push(message) }
  return { ctx, registered, appended, followups, agent }
}

// The config follows the Standard Schema protocol dsh validates rows with.
assert.equal(Config['~standard'].version, 1)
assert.equal(Config['~standard'].validate({ commandDescription: 'go' }).value.commandDescription, 'go')
assert.ok(Config['~standard'].validate({ nope: true }).issues, 'unknown keys are rejected')

// /continue queues a carrier and arms exactly one resume.
{
  const { ctx, registered, followups, agent } = fakeContext()
  apply(ctx, {})
  assert.equal(registered.commands.length, 1)
  assert.equal(registered.commands[0].name, 'continue')
  const result = registered.commands[0].handler({ agent })
  assert.equal(result.kind, 'success')
  assert.equal(followups.length, 1)
  assert.equal(registered.effects.length, 2, 'command and listener are both owned effects')
}

// A running agent and a finished turn are both refused before arming.
{
  const running = fakeContext({ status: 'running' })
  apply(running.ctx, {})
  assert.equal(running.registered.commands[0].handler({ agent: running.agent }).kind, 'error')
  assert.equal(running.followups.length, 0)

  const finished = fakeContext({ lastTurnEnd: { kind: 'completed' } })
  apply(finished.ctx, {})
  assert.equal(finished.registered.commands[0].handler({ agent: finished.agent }).kind, 'error')
}

// An armed resume whose step no longer carries the carrier disarms itself, so a
// later user turn is never rewritten and never gets recovery results appended.
{
  const { ctx, registered, appended, followups, agent } = fakeContext()
  apply(ctx, {})
  registered.commands[0].handler({ agent })
  const rewrite = registered.listeners.find((entry) => entry.name === 'agent/pre-step').listener
  const userMessage = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }
  let nextCalls = 0
  const decision = await rewrite(
    { agent, messages: [userMessage], turn: 1, step: 1, signal: undefined },
    async () => {
      nextCalls += 1
      return { kind: 'enter', messages: [userMessage] }
    },
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(nextCalls, 1, 'the step passes through untouched')
  assert.equal(appended.length, 0, 'no recovery result for a user turn')
  assert.equal(followups.length, 1)
}

console.log('seamless-continue: all checks passed')
