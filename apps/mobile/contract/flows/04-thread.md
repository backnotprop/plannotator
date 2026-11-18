# 4. A thread

On screen: Back; the thread's name over "agent · project"; the More menu. Then the messages, oldest first. Read messages are folded to one line and a long run hides behind "Show 6 earlier messages", by the Inbox's own folding rule. The view lands where the window lands: at "New since you looked" (or "Back from snooze") with the last read line just above it, else at the top. Below the last message, the run line when an agent the Inbox started is at work ("Claude Code is working · 6 min", Stop). At the bottom, the composer.

Every message is plain text on the page, never a bubble, separated from the next by a hairline: headings, lists, tables that scroll sideways, code with highlighting and a copy button, pictures (tap for full screen with pinch), link cards, diagrams and math. A live HTML block draws in a sandboxed frame set into the message, as in the window; a diagram draws in a small sandboxed web view (the window draws it into the page). The person's own messages are drawn the same way, in the same column, with the delivery line under the latest one ("Delivered to Claude Code", "Queued · Send now", "Will send when Work Mac is back").

Things in a thread:

- **Files**: a strip of tiles under the message that carries them. Tap one: section 7.
- **Questions**: cards in place. Section 5.
- **Action items**: a row with Done and Can't do it; the mark waits in the reply draft and goes with the next Send, as in the window.
- **A permission prompt** from a started agent: a card with the runtime and its status (with Stop), the action, the exact request, then its answers: Allow once, Deny, and the "Allow and switch to …" answers where the host takes them.
- **A command to run, a secret to give**: section 10.
- **Steps**: the agent's checklist as a fold at the top of the thread ("3 of 7 done"), when the Checklist is on at the computer.
- **Select words** in any message: Comment, and the message's ↩ quotes the selected words. A comment waits and rides the next Send to the session that wrote that message.
- **React**: 👍 Looks good under an agent's message is one tap; holding it (or holding Reply) opens the reaction tray. The message's ⋯ has Copy message, Copy link to message and Copy thread, plus Share on the phone.
- **More menu**: the window's ⋯: on a started agent's thread first Copy attach command, Stop and Delete session; then Mark read (or Move back, Mark unread), Snooze, Star thread, Add to Priority, Add tag, Copy thread, Copy link, Copy thread ID, Request guided review where offered, and Archive thread.

Differs from the window: the thread panel beside the thread (files, artifacts, pull requests) becomes entries in the More menu and the header line. Hover cards open on tap as a sheet.

## Checks

- [thread-01] The header shows Back, the thread's title (a named thread's name with its heading after it, muted; a cut title opens whole on a tap), and the More menu. (packages/inbox/thread/ThreadBarTitle.tsx:8; packages/inbox/components/Thread.tsx:4767)
- [thread-02] Messages are oldest first. Read messages fold to one line, and a long run hides behind "Show N earlier", by the Inbox's folding rule. (packages/core/inbox-folding.ts:2; packages/inbox/components/Thread.tsx:796)
- [thread-03] The thread lands where the window lands: at "New since you looked" (or "Back from snooze") with the last read line just above it, else at the top. (packages/inbox/components/Thread.tsx:1921; packages/core/inbox-folding.ts:18)
- [thread-04] While an agent the Inbox started is at work, the run line shows under the latest message, with Stop. (packages/core/inbox-run-line.ts:2; packages/inbox/components/RunLine.tsx:30; packages/inbox/components/RunLine.tsx:125)
- [thread-05] Every message is plain text on the page, never a bubble, separated from the next by a hairline. (packages/inbox/inbox.css:1486; packages/inbox/components/Thread.tsx:5083)
- [thread-06] A live HTML block draws in a sandboxed frame set into the message. phone differs: a diagram draws in a sandboxed web view, because the app has no diagram renderer of its own; the window draws it into the page (packages/ui/components/html-embed/HtmlEmbedBlock.tsx:149; packages/ui/components/diagramLanguages.ts:7)
- [thread-07] The person's own messages are drawn like the agent's, in the same column, with the delivery line under the latest one in the window's words. (packages/inbox/components/Thread.tsx:3605; packages/core/inbox-delivery-line.ts:281; packages/core/inbox-delivery-line.ts:350)
- [thread-08] Files show as a strip of tiles under the message that carries them. (packages/inbox/components/AttachmentTiles.tsx:270)
- [thread-09] An action item offers Done and Can't do it. The mark waits in the reply draft and goes with the next Send. (packages/inbox/components/ActionChecklist.tsx:11; packages/inbox/components/ActionChecklist.tsx:33; packages/inbox/components/Thread.tsx:318)
- [thread-10] A permission prompt shows the runtime with its status and Stop, the action, the exact request, then the answers: Allow once, Deny, and "Allow and switch to Auto mode" or "Allow and switch to Full permissions" where the host takes them. (packages/inbox/components/PermissionCard.tsx:2; packages/core/inbox-permission.ts:19; packages/core/inbox-permission.ts:20; packages/core/inbox-permission.ts:392)
- [thread-11] Selected words in a message take a comment, and the message's ↩ quotes them. A comment waits and rides the next Send to the session that wrote that message. (packages/inbox/replyQuote.ts:2; packages/inbox/sendTargets.ts:24)
- [thread-12] 👍 Looks good under an agent's message is one tap; holding it, or holding Reply, opens the reaction tray (👍, the saved emoji, +, …). The message's ⋯ offers Copy message, Copy link to message and Copy thread. phone differs: the ⋯ also offers Share, because the share sheet is how a phone moves things between apps (packages/inbox/components/ReactionTray.tsx:4; packages/inbox/components/ReactionTray.tsx:11; packages/inbox/components/CopyMenus.tsx:30; packages/core/inbox-types.ts:1027)
- [thread-13] The More menu is the window's ⋯: on a started agent's thread first Copy attach command, Stop and Delete session; then Mark read (or Move back, Mark unread), Snooze, Star thread, Add to Priority, Add tag, Copy thread, Copy link, Copy thread ID, Request guided review where offered, and Archive thread. (packages/inbox/components/CopyMenus.tsx:244; packages/inbox/components/CopyMenus.tsx:258; packages/inbox/components/CopyMenus.tsx:268)
