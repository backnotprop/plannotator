/**
 * The shortcut extras (approval "inbox-keyboard-shortcuts", approved later the
 * same day, reply msg_01M5YYWHKK0MG4DTGQ7P8NTK4Z): each one is a single switch here, read
 * once when the scopes are built. Off, the binding is not in the registry at
 * all (not in the map, not matched, not hinted), and its handler is never
 * reached. Turning one on is a one-word change, and the tests run every
 * combination (shortcuts.test.ts), so adding or dropping one moves nothing
 * else.
 *
 * - `slashSearch`: `/` opens search, beside ⌘K / Ctrl+K.
 * - `goTo`: `G` then `I` / `B` / `S` go to the Inbox, the Board, Settings.
 * - `readFromList`: the message keys (Shift+J / Shift+K since the J/K swap
 *   addendum, and n) also work with focus on the list beside an open thread,
 *   moving focus into the thread.
 */
export interface InboxShortcutExtras {
  slashSearch: boolean;
  goTo: boolean;
  readFromList: boolean;
}

export const INBOX_SHORTCUT_EXTRAS: Readonly<InboxShortcutExtras> = Object.freeze({
  slashSearch: true,
  goTo: true,
  readFromList: true,
});
