# 3. The list

On screen, top to bottom: the computer's name with its state dot; the pencil; the large title "Inbox"; the filter pills; then the sections in the Inbox's order with the Inbox's names: Stopped on you, Holding up work, Waiting on you, New since you looked, Sent, Quiet. The Priority group comes first when it has rows. Starred threads sit above the sections as a row of pills (the window's "Keep starred above the list"; the window's default is the sidebar's Starred section, and the phone has no sidebar). The Snoozed band folds under Quiet, closed at first, as in the window. Empty sections are not drawn.

A row is the window's phone row: the agent's picture, the thread's name (bold while unread), the time, the lead line (the project and the agents), the latest message in grey (the person's own as "You: …"), the first tag (with "+N" for the others), and at the end the star, the pull requests mark, a snooze's return and the count.

What the person can do:

- **Tap** a row: the thread.
- **Swipe right**: Mark read (a full swipe does it); on a read row, Mark unread. **Swipe left**: Archive. These are the window's directions.
- **Press and hold**: the row menu, the window's items in the window's order, in the system's own menu: Select, Star thread, Add to Priority, Copy link, Copy thread ID, Snooze, Mark read or Mark unread, Move back, Archive. Copy thread and Hide pull request are not offered yet.
- **Pull down**: read again.
- **Filter**: the window's list filter: projects, when the thread last changed, agents, pull request states, Not seen, tags and routines.
- After Mark read, Archive or Snooze, an Undo toast stays 7 seconds. Delete is in Settings, not on a row. Mark read that sets questions aside warns first, with the window's words.

The list holds still, as the window's does: while the person reads the list, an agent's news does not move rows under the thumb. A pill says "3 new" and a tap applies them. Coming back from a thread settles the person's own reads and actions; an agent's news still waits behind "N new".

Differs from the window: no sidebar; the count on the app icon is the window's tab count: threads with agent messages the person has not looked at; Starred order is changed with press, hold and drag.

## Checks

- [list-01] The Priority group comes first, then the sections in the Inbox's order with the Inbox's names (Stopped on you, Holding up work, Waiting on you, New since you looked, Sent, Quiet), then the Snoozed band under Quiet. Empty sections are not drawn. (packages/core/inbox-types.ts:1804; packages/inbox/held.ts:13; packages/inbox/components/InboxList.tsx:1279)
- [list-02] Starred threads sit above the sections as pills, the window's "Keep starred above the list". The Snoozed band folds under Quiet, closed at first. phone differs: the pills are always on, because the window's default (the sidebar's Starred section) needs a sidebar (packages/inbox/starredPills.ts:2; packages/inbox/components/InboxList.tsx:1168)
- [list-03] A row is the window's phone row: the agent's picture, the thread's name (bold while unread), the time, the lead line (project and agents), the latest message (the person's own as "You: …"), the first tag with "+N" for the others, then the star, the pull requests mark, a snooze's return and the count. (packages/inbox/components/InboxList.tsx:1022; packages/inbox/components/InboxList.tsx:1051; packages/core/inbox-row-preview.ts:63; packages/inbox/parts/RowTint.tsx:48)
- [list-04] While the list is on screen, an agent's news does not move rows. "N new" and its Show apply them. (packages/inbox/held.ts:2; packages/inbox/components/HeldNoticeLine.tsx:25)
- [list-05] Coming back from a thread settles the person's own reads and actions; an agent's news still waits behind "N new". (packages/inbox/held.ts:4; packages/inbox/settle.ts:5)
- [list-06] A tap on a row opens the thread. (packages/inbox/components/InboxList.tsx:1055)
- [list-07] Swipe right marks read (a long swipe or a flick does it at once); on a read row it marks unread. Swipe left archives. (packages/inbox/rowSwipe.ts:2; packages/inbox/rowSwipe.ts:9)
- [list-08] Press and hold opens the row menu, in the window's order: Select, Star thread, Add to Priority, Copy link, Copy thread ID, Snooze, Mark read or Mark unread, Move back, Archive. phone differs: the system's own menu over the row, where the window draws a sheet from the bottom edge; and the window's Copy thread, Add tag, Mention in reply and Hide pull request are not offered yet (Copy thread is built in the browser from the message text, and the phone's door has no route for tags or for hiding pull requests) (packages/inbox/rowMenu.ts:50; packages/inbox/components/RowMenu.tsx:105; packages/inbox/components/RowMenu.tsx:70)
- [list-09] Pull down reads the list again. (packages/inbox/pullRefresh.ts:2; packages/inbox/pullRefresh.ts:70)
- [list-10] The list's filter is the window's: projects, when the thread last changed (Today, the last 3, 7 or 30 days, a range), agents, pull request states, Not seen, tags and routines. (packages/inbox/listFilter.ts:2; packages/inbox/listFilter.ts:14)
- [list-11] After Mark read, Archive or Snooze, an Undo toast stays for 7 seconds. (packages/inbox/markRead.ts:16; packages/inbox/App.tsx:2647; packages/inbox/App.tsx:3100; packages/inbox/snoozeWrites.ts:58)
- [list-12] If Mark read sets questions aside, the app warns first, with the window's words ("Set aside …?"), while the window's Mark read warning is on. (packages/inbox/markRead.ts:169; packages/inbox/data/actions/settings.ts:53)
- [list-13] The app icon's count is the window's tab count: threads with agent messages the person has not looked at, never the waiting-on-you count; an archived thread counts only when it came back. (packages/inbox/tabCount.ts:7; packages/inbox/tabCount.ts:19)
