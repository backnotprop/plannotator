/** The session's title as the engine last told a hook; "" says it has none. */
export type SessionTitle = string

declare module 'claude-code' {
  interface PluginState {
    plannotator: { sessionTitle: StateFamily<SessionTitle> }
  }
}
