/**
 * WORDS PENDING THE OWNER'S APPROVAL.
 *
 * Every word the preference list (inbox-prefs.ts) says about a preference: its short label, its one-line meaning and
 * where the person sets it in the window. An agent reads these (GET /api/inbox/prefs, later `plannotator inbox
 * prefs`), and so does a person. They live here and nowhere else, so the owner reviews and changes them in one pass.
 * Nothing in the window shows them yet.
 *
 * Keys a list makes per agent (`agents.<id>.reach`, `prompts.<host>.rules`) take their words from the functions at the
 * end, with the agent's name filled in.
 */

export interface InboxPrefWords {
  /** The short name, as the Settings row says it where there is one. */
  label: string;
  /** One line: what changes when it changes. */
  meaning: string;
  /** Where the person changes it in the window. */
  where: string;
}

export const INBOX_PREF_WORDS: Readonly<Record<string, InboxPrefWords>> = {
  "appearance.theme": { label: "Theme", meaning: "Light, dark, or match this computer.", where: "Settings → General → Appearance" },
  "appearance.light_palette": { label: "Light colors", meaning: "The palette used while the theme is light.", where: "Settings → General → Colors" },
  "appearance.dark_palette": { label: "Dark colors", meaning: "The palette used while the theme is dark.", where: "Settings → General → Colors" },
  "appearance.text_size": { label: "Text size", meaning: "The size of the window's text, in pixels.", where: "Settings → General → Appearance" },
  "appearance.tab_icon": { label: "Tab icon", meaning: "The icon on the browser tab: glass, yellow, or the Face (totman).", where: "Settings → General → Appearance" },

  "sound.on": { label: "Question sound", meaning: "Play a sound when an agent asks a question.", where: "Settings → General" },
  "sound.volume": { label: "Sound volume", meaning: "How loud the question sound is.", where: "Settings → General" },

  "notifications.on": { label: "Desktop notifications", meaning: "Show a desktop notification when an agent needs you.", where: "Settings → General" },
  "notifications.ask_dismissed": { label: "Notifications ask dismissed", meaning: "The line asking to turn on notifications is hidden.", where: "The line above the list" },

  "list.rows": { label: "Row options", meaning: "How the rows of the thread list look. `plannotator inbox rows` explains each option.", where: "Settings → Rows" },
  "list.mark_read_warning": { label: "Warn before Mark read", meaning: "Ask first when Mark read would set open questions aside.", where: "Settings → General" },

  "sidebar.hidden": { label: "Hidden sidebar items", meaning: "The sidebar items that are not shown.", where: "Right-click the sidebar, or Customize sidebar" },
  "sidebar.top": { label: "Top of the sidebar", meaning: "The items at the top of the sidebar, in order.", where: "Customize sidebar" },
  "sidebar.bottom": { label: "Bottom of the sidebar", meaning: "The items at the bottom of the sidebar, in order.", where: "Customize sidebar" },

  "reactions.saved": { label: "Saved reactions", meaning: "The emoji in the reaction tray, each with an optional name.", where: "The reaction tray on a message" },

  "diff.style": { label: "Diff layout", meaning: "Show changes side by side (split) or in one column (unified).", where: "The Split / Unified switch on a diff" },
  "diff.overflow": { label: "Long lines", meaning: "Scroll long lines, or wrap them.", where: "Diff display" },
  "diff.indicators": { label: "Change marks", meaning: "How added and removed lines are marked.", where: "Diff display" },
  "diff.line_diff": { label: "Changes within a line", meaning: "How changes inside a line are shown.", where: "Diff display" },
  "diff.line_numbers": { label: "Line numbers", meaning: "Show line numbers in diffs.", where: "Diff display" },
  "diff.background": { label: "Line background", meaning: "Color the background of changed lines.", where: "Diff display" },
  "diff.background_intensity": { label: "Background strength", meaning: "How strong the changed-line color is.", where: "Diff display" },
  "diff.tab_size": { label: "Tab size", meaning: "How many spaces a tab takes in diffs.", where: "Diff display" },

  "decisions.post_to": { label: "Post decisions to", meaning: "Where Post decisions puts them on a pull request.", where: "Export decisions → Where" },

  "general.plannotator_localhost": { label: "Open at plannotator.localhost", meaning: "Open Plannotator at plannotator.localhost instead of 127.0.0.1. Applies at the next start.", where: "Settings → General → This browser" },

  "prompts.reminder": { label: "Inbox reminder", meaning: "The reminder every agent gets at session start. Null is the default text.", where: "Settings → Prompts" },
  "prompts.rules": { label: "Rules for your agents", meaning: "Rules added to every agent's reminder. Null is none.", where: "Settings → Prompts" },
  "prompts.guide": { label: "Guided Review instructions", meaning: "Standing instructions for every Guided Review. Null is none.", where: "Settings → Prompts" },

  "launch.on": { label: "Start agents from New message", meaning: "New message can start a new agent session.", where: "Settings → Agents → Launch" },
  "launch.scratch_dir": { label: "Scratch folders", meaning: "The folder where new scratch folders go. Null is the default.", where: "Settings → Agents → Launch" },
  "launch.full_permissions": { label: "Full permissions", meaning: "Start new sessions with every permission prompt off.", where: "Settings → Agents → Launch" },
  "launch.settings_file": { label: "Claude settings file", meaning: "A settings file every launched Claude Code session reads.", where: "Settings → Agents → Launch" },

  "capabilities.board": { label: "Board", meaning: "A page of the work in flight, one card per piece, that your agents keep current.", where: "Settings → Capabilities" },
  "capabilities.checklist": { label: "Checklist", meaning: "Your agents' plan for the work in a thread, as a checklist.", where: "Settings → Capabilities" },
  "capabilities.code_review": { label: "Code review", meaning: "Review your agents' code changes and your pull requests in the Inbox.", where: "Settings → Capabilities" },
  "capabilities.chapter_diagrams": { label: "Chapter diagrams", meaning: "Agents may add a diagram above a chapter's code. Needs Code review.", where: "Settings → Capabilities" },
  "capabilities.system": { label: "System", meaning: "A drawing of each project's system, kept current by an agent. Needs Code review.", where: "Settings → Capabilities" },
  "capabilities.shape": { label: "Shape", meaning: "Boards your agents draw and keep current, opened from a thread.", where: "Settings → Capabilities" },

  "experimental.decision_mode": { label: "Decision mode", meaning: "Answer what agents ask in a thread one decision at a time.", where: "Settings → Capabilities → Experimental" },
  "experimental.bro": { label: "Bro mode", meaning: "Agents write to your Inbox in plain words. Applies to new sessions.", where: "Settings → Capabilities → Experimental" },
  "experimental.float_drafts": { label: "Float reply drafts", meaning: "An unsent reply floats in the corner when you leave its thread.", where: "Settings → Capabilities → Experimental" },

  "updates.check": { label: "Check for updates", meaning: "Ask GitHub for new releases.", where: "Settings → About" },
  "updates.auto_install": { label: "Install updates automatically", meaning: "Install a new release by itself.", where: "Settings → About" },

  "reviews.risk_rules": { label: "Risk rules", meaning: "The rules an agent uses to rank pull requests by risk. Needs Code review.", where: "Reviews → Risk rules" },
  "reviews.risk_agent": { label: "Risk agent", meaning: "The agent that ranks pull requests by risk. Null is none.", where: "Reviews → Risk rules" },
  "reviews.risk_model": { label: "Risk model", meaning: "The model that agent uses. Null is its default.", where: "Reviews → Risk rules" },

  "voice.on": { label: "Voice", meaning: "Dictate replies with your voice.", where: "Settings → Voice" },
  "voice.phones_only": { label: "Voice on phones only", meaning: "Offer voice only on phones.", where: "Settings → Voice" },
  "voice.engine": { label: "Voice engine", meaning: "Transcribe with your Codex login, or with an OpenAI API key.", where: "Settings → Voice" },
  "voice.api_key": { label: "OpenAI API key", meaning: "The key voice uses with the API key engine. Never shown: reads say set or not set. Null removes it.", where: "Settings → Voice" },

  "access.tailnet_window": { label: "Window over your tailnet", meaning: "Keep the window open to your tailnet at every start.", where: "Settings → Devices" },
  "access.tailnet_allow": { label: "Your Tailscale logins", meaning: "On a tagged machine, which Tailscale names no owner for: the logins that count as you over your tailnet. A login taken off is shut out at once.", where: "config.json" },
  "access.this_wifi": { label: "This Wi-Fi", meaning: "Phones on this computer's network can reach the Inbox.", where: "Settings → Devices" },
  "access.tailnet_door": { label: "Phones over your tailnet", meaning: "Phones on your tailnet can reach the Inbox.", where: "Settings → Devices" },
};

/** `cloud_agents.<id>.wake`: a cloud agent's wake address and key. */
export const inboxPrefCloudWakeWords = (name: string): InboxPrefWords => ({ label: `${name}'s wake address and key`, meaning: `Where a reply wakes ${name}: { url, key }. Never shown: reads say set or not set. Null removes it.`, where: "Settings → Cloud agents" });

/** `agents.<id>.reach`. */
export const inboxPrefReachWords = (agent: string): InboxPrefWords => ({ label: `${agent} reaches the Inbox`, meaning: `${agent} can read and send Inbox messages. Writes ${agent}'s own config on this computer.`, where: "Settings → Agents" });
/** `agents.<host>.tool`. */
export const inboxPrefToolWords = (agent: string): InboxPrefWords => ({ label: `${agent}'s Inbox tool`, meaning: `${agent} gets the plannotator_inbox tool from Plannotator's plugin.`, where: "Settings → Agents" });
/** `agents.<host>.reminder`. */
export const inboxPrefReminderWords = (agent: string): InboxPrefWords => ({ label: `${agent}'s reminder`, meaning: `One line about the Inbox when a ${agent} session starts.`, where: "Settings → Agents" });
/** `agents.<id>.note`. */
export const inboxPrefNoteWords = (agent: string): InboxPrefWords => ({ label: `Note in ${agent}'s instructions`, meaning: `A note about the Inbox in ${agent}'s instructions file on this computer.`, where: "Settings → Agents" });
/** `prompts.<host>.reminder`. */
export const inboxPrefHostReminderWords = (agent: string): InboxPrefWords => ({ label: `Inbox reminder for ${agent}`, meaning: `${agent}'s own reminder text, in place of the one for every agent. Null is that one.`, where: "Settings → Prompts" });
/** `prompts.<host>.rules`. */
export const inboxPrefHostRulesWords = (agent: string): InboxPrefWords => ({ label: `Rules for ${agent}`, meaning: `Rules for ${agent} only, added to its reminder. Null is none.`, where: "Settings → Prompts" });

/** A key the list does not know. */
export const inboxPrefUnknownWords = (key: string): string => `${key}: not a preference. GET /api/inbox/prefs lists them.`;
