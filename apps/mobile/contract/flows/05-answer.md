# 5. Answering a question

A question card is the window's: an eyebrow ("Question N of M") with its status tag ("Can't be undone" among them), the prompt, its context, then the choices (label, description, Recommended, and when present a picture), an always present "Other…", or a text box for a free-text question; the options' Pros and Cons sit in a Trade-offs table, closed until opened; the footer has Add note, Skip and Accept recommended.

Two ways to answer, both ending in the same two writes the window makes (the picks are saved, then one reply sends them):

- **In place.** Tap a choice. It is saved to the computer at once and the card says "Picked <time> · in your draft". The composer's Send posts every saved pick in the thread, with whatever words are in the box. This is the window's flow.
- **The answer sheet.** When a message has more than one open question, or a question has pictures, the card's "Answer" button (and the notification) opens a sheet that takes the questions one at a time, full width: big pictures, a note field, camera, microphone, "Skip this one". The last page lists the answers and has one Send. This is the phone's own flow; the writes are the same.

Kinds and how each is given:

| Kind | On the phone |
|---|---|
| Single | Tap a row. A second tap on another row moves the pick |
| Multi | Tap any rows; "Other…" adds your own |
| With pictures | Tiles two across; tap a tile to pick, press and hold to see it full screen |
| Free text | A text box; the microphone dictates into it; the camera adds a photo to the reply |
| Voice | The microphone in any text box. Speech becomes text on the phone; the text is what is sent |
| Pros and cons, stakes, "Can't be undone" | Shown on the card; "Can't be undone" is repeated on the Send page of the sheet |
| Prototypes (a running app per choice) | The choice is shown and can be picked; its running app opens on the computer (later: on the phone) |

Refusals read as the window's: a question the agent replaced says "Replaced" and shows the new one; a pick whose question was replaced while the thread was open stops the Send once and says so; a question set aside says "Closed unanswered when you marked it read · <time>".

Skipping is explicit: a Send skips only the questions the person skipped (the card's Skip, or "Skip them" on Send). Unanswered questions stay open.

Differs from the window: the answer sheet. Reason: on a phone a card with pictures and four choices is taller than the screen, and two of them in one message means scrolling between a pick and Send. One question per page with one Send at the end is the shape the notification action also leads into.

## Checks

- [answer-01] A question card shows its eyebrow ("Question N of M") and status tag, the prompt, its context, then the choices with an always present "Other…", or a text box for a free-text question; the footer has Add note, Skip and Accept recommended. (packages/ui/components/blocks/QuestionBlock.tsx:31)
- [answer-02] A choice shows its label, its description after a dash and Recommended, and a picture when it has one; the options' Pros and Cons are in a Trade-offs table, closed until opened. (packages/ui/components/blocks/QuestionBlock.tsx:1092; packages/ui/components/blocks/QuestionBlock.tsx:1095; packages/ui/components/blocks/QuestionBlock.tsx:467)
- [answer-03] "Other…" takes the person's own words. (packages/ui/components/blocks/QuestionBlock.tsx:34; packages/ui/components/blocks/QuestionBlock.tsx:634)
- [answer-04] Single choice: a tap on another row moves the pick. (packages/ui/components/blocks/QuestionBlock.tsx:606)
- [answer-05] Multiple choice: any rows can be picked, and words under "Other…" stay in the answer beside the ticks. (packages/ui/components/blocks/QuestionBlock.tsx:325)
- [answer-06] Both ways of answering end in the window's two writes: the picks are saved, then one reply sends them. (packages/inbox/api.ts:1432; packages/inbox/api.ts:1464)
- [answer-07] A pick is saved to the computer before Send. The card reads "Picked <time> · in your draft". (packages/inbox/components/Thread.tsx:2658)
- [answer-08] Send sends every saved pick in the thread, one reply per agent session, with the words in the box riding the last one. (packages/inbox/sendTargets.ts:72; packages/inbox/sendTargets.ts:86; packages/inbox/components/Thread.tsx:2665)
- [answer-09] A message with more than one open question, or a question with pictures, offers "Answer". It opens the answer sheet: one question per page, and one Send on the last page. phone differs: the answer sheet is the phone's own, because a card with pictures and four choices is taller than the screen (phone only)
- [answer-10] "Can't be undone" is shown on the card, which adds no confirm step. phone differs: it is repeated on the answer sheet's Send page, because that page is where the person sends (packages/ui/components/blocks/QuestionBlock.tsx:66; packages/ui/components/blocks/QuestionBlock.tsx:916)
- [answer-11] A Send skips only questions the person skipped (the card's Skip, or "Skip them" on Send). Unanswered questions stay open. (packages/inbox/sendTargets.ts:76; packages/ui/components/blocks/QuestionBlock.tsx:664; packages/inbox/components/Thread.tsx:2653)
- [answer-12] A question the agent replaced is tagged "Replaced" (or "No longer applies"), loses its controls, names what replaced it and marks the person's pick there "Not sent"; the newer card says what it replaces. (packages/inbox/components/ReplacedQuestion.tsx:4; packages/inbox/components/ReplacedQuestion.tsx:210)
- [answer-13] If a question the person picked is replaced while the thread is open, Send stops once and says so before anything is sent. (packages/inbox/components/Thread.tsx:556)
- [answer-14] A question that was set aside says "Closed unanswered when you marked it read · <time>". (packages/inbox/components/Thread.tsx:2657)
