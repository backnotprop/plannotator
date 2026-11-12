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
