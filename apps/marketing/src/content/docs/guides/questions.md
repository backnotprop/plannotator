---
title: "Questions in Plans and Documents"
description: "How an agent asks you questions inside a plan or document, how you answer them in Plannotator, and what the agent gets back."
sidebar:
  order: 30
section: "Guides"
---

An agent can put a question in a plan or a document when it needs you to make a decision. Plannotator shows each question as a card with choices. You answer in place, and the answers go back to the agent with the rest of your feedback.

Questions work in plan review, `plannotator annotate` on a markdown file or folder, and `plannotator last`. They do not work on HTML pages, live apps, diagram files, or in code review.

## What the agent writes

A question is a `:::question` block. Blank lines between the parts are recommended, so the block also reads well on GitHub.

```markdown
:::question
Where should losing conflict versions be kept?

Last-write-wins silently drops the loser unless we keep it somewhere.

- [ ] Local only, purged after 30 days — cheap, no server change
- [ ] Server-side per user — survives reinstall, needs a retention policy
- [ ] Nowhere — accept silent loss for v1

Recommended: Local only, purged after 30 days
:::
```

- `:::question` asks for one choice. `:::question-multi` accepts any number of choices. `:::question-text` asks for free text.
- The first line is the question. Other lines before the choices are context.
- `Recommended:` names the agent's recommendation. If it does not match a choice, Plannotator shows it as a suggested answer.
- `- [x]` marks a choice as already settled. Agents use it when they resubmit a plan with a question you already answered.

## How you answer

Each card shows "Question N of M" and a status: Open, Answered, Skipped, or Settled.

- Pick a choice, or type your own answer in **Other…**. "Other…" is always available.
- **Add note** adds a comment to your answer.
- **Skip** tells the agent you chose not to answer.
- **Accept recommended** fills in the agent's recommendation. It shows only while the question is open and has a recommendation.

You can still select and comment on the question text like any other text.

The header shows how many questions are answered, for example "2/4 answered". Click it to go to the next open question. The annotations panel lists every question in a **Questions** section above your comments. Answers are saved in your draft, so they survive a reload, and `Mod+Z` undoes them like other annotations.

## What the agent gets back

Answers come first in the feedback, under "Answers to your questions":

```markdown
## Answers to your questions

2 of 3 questions answered.

### Q1. Where should losing conflict versions be kept? (line 22)
Answer: Local only, purged after 30 days (your recommendation)
Note: keep the log reachable from the debug menu.

### Q2. Which sync indicators ship in v1? (line 45)
Answer:
- Per-document synced / pending / failed dot
- Global offline banner

### Unanswered
- Q3. Describe the manual test you'd run before calling offline sync shippable. (line 58)
```

"(your recommendation)" tells the agent you accepted its recommendation. Questions you did not answer are listed under "Unanswered".

## Plan review: Send answers

When your only feedback on a plan is answers, the main button reads **Send answers**. The agent then gets a message that says you answered its questions and asks it to put the answers into a revised plan and resubmit. It does not get the "your plan was not approved" message. When you also leave comments or edit the plan, the button reads **Send feedback** and the agent gets the normal feedback message with the answers at the top.

On resubmit, the agent either removes an answered question and writes the decision into the plan, or keeps it with the chosen choice marked `- [x]`. A settled choice shows as selected with a "Settled" tag, and you can still change it.

You can change the message the agent receives with the `answered` key in `prompts.plan`. See [Custom Feedback Messages](/docs/guides/custom-feedback/).

> [!WARNING]
> In Claude Code, **Approve** does not send answers or notes to the agent. If you approve with answers, Plannotator warns you first. To send answers, use **Send answers**.

## Teaching your agent to ask

- The `plannotator` skill has a section, "Asking the reviewer questions", with the syntax and the rules for when to ask.
- The optional Plannotator Flavored Markdown reminder (`{ "pfmReminder": true }` in `~/.plannotator/config.json`) includes a short paragraph and an example.

A good round has a few questions about decisions the agent cannot make alone, about 8 at most.

## Limits

- Share links carry an answer as a comment on the question, not as a filled-in card.
- A browser agent using [WebMCP tools](/docs/reference/webmcp-tools/) can read questions and answers but cannot answer.
- If the agent rewords a question, your earlier answer is no longer attached to it. The answer shows in the Questions section as unanchored and is still sent.
