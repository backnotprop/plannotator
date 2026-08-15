---
title: "The Best Interface for /grill-me"
description: "Matt Pocock's /grill-me skill interviews you in rounds. A round is a document, not a chat message, so annotate it instead of typing answers back into a terminal."
date: 2026-08-15
author: "backnotprop"
tags: ["annotate", "grill-me", "skills", "workflow"]
---

**Plannotator is an open-source review UI for AI coding agents.** If you use [Matt Pocock](https://www.aihero.dev)'s [`/grill-me`](https://www.aihero.dev/skills-grill-me) skill, run the round through Plannotator instead of answering it in the terminal. You get to strike out the agent's assumptions, highlight the half of a question you actually object to, and comment in the margin, which is what a grill session is asking you to do anyway.

## A round is a document

`/grill-me` hands a terminal agent a loose idea and interviews you until the idea is sharp enough to commit to. The [skill source](https://raw.githubusercontent.com/mattpocock/skills/refs/heads/main/skills/productivity/grilling/SKILL.md) tells the agent to map your idea as a design tree, then work it in rounds. The frontier is every decision whose prerequisites are already settled, and the agent asks the whole frontier at once, numbered, each question carrying its recommended answer:

```
❓ **Q1** - **<question title>**: <question body>

➡️ <recommended answer>
```

Then it waits. A round is six or twelve questions with proposed answers attached, and you are meant to argue with them. Matt's page is blunt about the failure mode: answering "agreed, agreed, agreed" for forty questions and coming out with a plan the agent wrote and you nodded at. The skill is stateless, writes no files, and leaves the scope to you. You are supposed to push back, cut questions below your detail level, and say "I don't know" when that is the true answer.

Doing that in a terminal is cramped. You answer serially by number, you scroll up to re-read Q7 while typing about Q3, and editing a long answer in a prompt box is miserable.

## Mark it up instead

Send the round to Plannotator and it opens in the browser as a document you can annotate.

![A grill-me round open in Plannotator: question text highlighted, several recommended answers struck through, comments listed in the sidebar](/assets/blog/grilling.jpeg)

Strikethrough gets the most use. Models in grill sessions assume things constantly, usually inside the recommended answer, and crossing out the clause you reject is faster than writing a paragraph explaining which part of Q4 you meant. Highlight a fragment and comment on exactly that fragment. Correct the scope in the margin next to the sentence that drifted. It ends up closer to commenting on a Google Doc than to typing serial replies into a prompt.

Annotation gives you more room than a questionnaire does. A questionnaire takes one answer per question. Annotation lets you answer part of a question, reject the premise without answering it at all, accept the recommendation but narrow it, or write nothing and just delete the assumption. Half of what you want to say in a grill session is not an answer to the question as asked.

## The flow

For terminal agents (Claude Code, Codex CLI, OpenCode, Pi):

```bash
# 1. start the interview
/grill-me

# 2. when a round of questions arrives, annotate the agent's last message
/plannotator-last

# 3. mark it up in the browser, then Send Feedback
# 4. the agent reads your annotations and computes the next round
```

Every round after that is one document, marked up and sent back. The same thing works for [`/grill-with-docs`](https://aihero.dev/skills-grill-with-docs), and when the frontier empties and you continue into [`/to-spec`](https://aihero.dev/skills-to-spec) or [`/prototype`](https://aihero.dev/skills-prototype) you can annotate those outputs too. Matt's [AI coding dictionary](https://www.aihero.dev/ai-coding-dictionary/session) is worth reading for how he defines a session, which is the unit all of these skills are built around.

## Questionnaires are a complement

The Codex team added message annotation to their app after watching how people used Plannotator, and what they shipped is good; if you live in Codex, use it. We are also looking at questionnaire-style input, and shadcn's new [questionnaire component](https://ui.shadcn.com/docs/components/base/questionnaire) is a reasonable starting point for a round that really is just structured answers. It would sit alongside annotation rather than replace it, because a form still assumes every question deserves an answer.

We posted a marked-up session here: [@plannotator on X](https://x.com/plannotator/status/2088688374790160503).

## Try it

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then run a grill session and hit `/plannotator-last` on the first round. Docs at [plannotator.ai/docs](/docs/getting-started/installation/).
