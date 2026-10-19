/**
 * Client half of the alert sounds (probe stage: observes, does not play yet).
 *
 * The cue belongs on the side where the user is: with the Host and the browser
 * on different machines, a sound played by the Host is heard by nobody, while
 * one played in the page reaches the person who can answer it.
 *
 * This stage answers one question with evidence instead of a guess: which
 * Client signal fires when a question card or an approval panel appears? It
 * registers an invisible entry in `conversation.composer.dock`, inspects the
 * standard session props it receives, and writes what it sees to the console.
 *
 * Read it in DevTools (Ctrl+Shift+I) on the conversation page: `[approval-sound]`
 * lines appear while a question or an approval is on screen.
 */
;(() => {
  window.__ModuleLoader__.load({
    id: '@local/dsh-plugin-approval-sound',
    factory: () => (require) => {
      const module = { exports: {} }
      const React = require('react')
      const { useEffect, useRef } = React
      const h = React.createElement

      const PREFIX = '[approval-sound]'

      /** Describe a value's shape for the console without flooding it. */
      function shapeOf(value, depth = 1) {
        if (value === null) return 'null'
        if (Array.isArray(value)) return `Array(${value.length})`
        if (typeof value !== 'object') return typeof value
        if (depth <= 0) return 'object'
        return `{${Object.keys(value).slice(0, 24).join(',')}}`
      }

      /** Invisible anchor: one instance per open conversation. */
      function Anchor(props) {
        const reported = useRef(false)

        useEffect(() => {
          if (reported.current) return
          reported.current = true
          try {
            console.info(PREFIX, 'props:', Object.keys(props).join(' '))
            for (const key of ['useConversation', 'useSession', 'useChat', 'useTrajectory']) {
              const hook = props[key]
              if (typeof hook !== 'function') continue
              try {
                console.info(PREFIX, `${key}()`, shapeOf(hook(), 2))
              } catch (error) {
                console.info(PREFIX, `${key}() threw`, String(error))
              }
            }
          } catch (error) {
            console.info(PREFIX, 'probe failed', String(error))
          }
        }, [props])

        return null
      }

      function apply(ctx) {
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'approval-sound',
          order: 999,
        }, Anchor)), 'approval-sound: probe anchor')
      }

      void h
      module.exports = { name: 'approval-sound-client', inject: ['slots'], apply }
      return module.exports
    },
  })
})()
