# 11. Notifications and their actions

What sends one is what the Inbox pushes: an agent's message that asks a question (a permission prompt and an action item included), carries a guided review, or replaces earlier questions. The window's open page also notifies a new thread and a failed turn; the push does not. The text is sealed on the computer and opened on the phone; the relay and Apple see no words.

What the person sees: the thread's name as the title, "agent · project", and the question. Notifications group by thread; a newer one for the same thread replaces the older.

Actions (press and hold, or swipe on the lock screen):

| The message holds | Actions |
|---|---|
| One open single-choice question with one to four choices (Apple shows at most four actions) | Each choice, Recommended marked |
| A free-text question | "Reply" with a text field |
| Several questions, or pictures | "Answer" (opens the answer sheet) and "Reply" |
| A permission prompt | Its answers (Allow once, Deny, …), as for a single-choice question |
| A guided review, a new thread | Open, Mark read |

An answer from the lock screen does not open the app. On a locked phone iOS asks for the phone's own unlock (Face ID or the passcode) before it runs the action; the app adds nothing to that. A lock-screen answer carries the question's revision: if the question changed, the Inbox refuses it ("changed since you read it") and the answer is not sent; the notification then says so.

Focus: a question that holds up work should be time sensitive, so it can pass a Focus the person allows it through. The push does not say yet whether a question holds up work, so until it does every push is ordinary.

The app icon's count is the window's tab count: threads with agent messages the person has not looked at.

Differs from the window: everything. The window notifies only while a page is open; the phone is told with the app closed and the answer takes one press.

## Checks

- [notify-01] A push is sent for an agent's message that asks a question (a permission prompt and an action item included), carries a guided review, or replaces earlier questions. Plain news sends none. phone differs: the window's open page also notifies a new thread and a failed turn; the push does not, because the Inbox pushes only what asks the person (packages/server/inbox-relay.ts:681; packages/server/inbox-relay.ts:692; packages/inbox/notify.ts:6)
- [notify-02] The text is sealed on the computer and opened on the phone. The relay and Apple see no words, and the collapse id hides the thread. (packages/server/inbox-relay.ts:723; packages/server/inbox-relay.ts:725)
- [notify-03] The notification shows the thread's subject as its title, then the agent and the project, then the question's prompt, all from the push's sealed summary. (packages/server/inbox-relay.ts:197; packages/server/inbox-relay.ts:701)
- [notify-04] Notifications group by thread. A newer one for a thread replaces the older one (one collapse id per thread). (packages/server/inbox-relay.ts:725)
- [notify-05] One open single-choice question with one to four choices: each choice is an action, Recommended marked. Apple shows at most four actions. (packages/server/inbox-relay.ts:704; packages/server/inbox-relay.ts:706)
- [notify-06] A free-text question: "Reply" with a text field. phone differs: a lock-screen action, which the window has no twin for (phone only)
- [notify-07] Several questions, or pictures: "Answer" (it opens the answer sheet) and "Reply". phone differs: lock-screen actions, which the window has no twin for (phone only)
- [notify-08] A permission prompt pushes like a single-choice question: its answers (Allow once, Deny, …) are the actions. (packages/server/inbox-relay.ts:706; packages/core/inbox-permission.ts:19; packages/core/inbox-permission.ts:20)
- [notify-09] A guided review: Open and Mark read. phone differs: these lock-screen actions are the app's own; the push carries the review's message (packages/server/inbox-relay.ts:692)
- [notify-10] A failed turn sends no push: the Inbox pushes only messages that ask. The window's open page notifies it; the app shows it on the thread's run line with Try again. (packages/server/inbox-relay.ts:681; packages/inbox/notify.ts:84; packages/inbox/components/RunLine.tsx:217)
- [notify-11] An answer from the lock screen does not open the app. The app adds nothing to the phone's own unlock. phone differs: a lock-screen answer, which the window has no twin for (phone only)
- [notify-12] A lock-screen answer carries the question's revision; if the question changed (replaced, or answered elsewhere), the Inbox refuses it ("Question … changed since you read it") and the answer is not sent. (packages/shared/inbox/store.ts:4865; packages/shared/inbox/store.ts:550; packages/server/inbox.ts:817)
- [notify-13] A question that holds up work should be time sensitive, everything else ordinary. phone differs: the window has no such level, and the push summary does not carry holds-up yet, so every push is ordinary until it does (packages/server/inbox-relay.ts:197)
