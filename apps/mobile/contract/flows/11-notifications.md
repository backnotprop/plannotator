# 11. Notifications and their actions

What sends one (the same three events that notify in the window, plus one): an agent's new thread; a new question or guided review; a started agent's failed turn; and an agent stopped on a permission prompt. Snoozed threads send none. The text is sealed on the computer and opened on the phone; the relay and Apple see no words.

What the person sees: the thread's name as the title, "agent · project", and the question. Notifications group by thread; a newer one for the same thread replaces the older.

Actions (press and hold, or swipe on the lock screen):

| The message holds | Actions |
|---|---|
| One single-choice question, up to three choices | Each choice (Recommended marked), then "Reply in your own words" |
| A free-text question | "Reply" with a text field |
| Several questions, or pictures | "Answer" (opens the answer sheet) and "Reply" |
| A permission prompt | Allow, Deny, Open |
| A guided review, a new thread | Open, Mark read |
| A failed turn | Try again, Open |

An answer from the lock screen does not open the app. On a locked phone iOS asks for the phone's own unlock (Face ID or the passcode) before it runs the action; the app adds nothing to that. If the question was replaced or the thread moved on, the notification changes to say so and the answer is not sent.

Focus: a question that holds up work is marked time sensitive, so it can pass a Focus the person allows it through. Everything else is ordinary.

The app icon's count is the rows that wait on the person.

Differs from the window: everything. The window notifies only while a page is open; the phone is told with the app closed and the answer takes one press.

## Checks

- [notify-01] A notification is sent for an agent's new thread, a new question or guided review, a started agent's failed turn, and an agent stopped on a permission prompt. Snoozed threads send none.
- [notify-02] The text is sealed on the computer and opened on the phone. The relay and Apple see no words.
- [notify-03] The notification shows the thread's name as its title, then "agent · project", then the question.
- [notify-04] Notifications group by thread. A newer one for a thread replaces the older one.
- [notify-05] One single-choice question with up to three choices: each choice (Recommended marked), then "Reply in your own words".
- [notify-06] A free-text question: "Reply" with a text field.
- [notify-07] Several questions, or pictures: "Answer" (it opens the answer sheet) and "Reply".
- [notify-08] A permission prompt: Allow, Deny and Open.
- [notify-09] A guided review or a new thread: Open and Mark read.
- [notify-10] A failed turn: Try again and Open.
- [notify-11] An answer from the lock screen does not open the app. The app adds nothing to the phone's own unlock.
- [notify-12] If the question was replaced or the thread moved on, the notification says so and the answer is not sent.
- [notify-13] A question that holds up work is time sensitive. Everything else is ordinary.
