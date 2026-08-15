---
title: "An interactive UI for the grill-me skill"
description: "Run /plannotator-last on a grill-me round: the questions open in your browser, you strike out assumptions and comment on fragments, and the feedback goes straight back to the agent."
date: 2026-08-15
author: "backnotprop"
tags: ["annotate", "grill-me", "skills", "workflow"]
---

[Matt Pocock](https://www.aihero.dev)'s [`/grill-me`](https://www.aihero.dev/skills-grill-me) skill interviews you about a loose idea until it is sharp enough to commit to. It asks in rounds: a batch of numbered questions, each with a recommended answer, and then it waits. Answering that in a terminal is cramped. You reply serially by number, scroll up to re-read Q7 while typing about Q3, and edit long answers in a prompt box.

[Plannotator](https://github.com/backnotprop/plannotator) fixes this with one command. `/plannotator-last` opens the agent's last message in your browser and makes it annotatable. Works in Claude Code, Codex CLI, OpenCode, and Pi. Mark up the round, hit Send Feedback, and the annotations go straight back to the agent as its next input.

![Plannotator, an interactive UI for the grill-me skill: a round of questions annotated in the browser with highlights, strikethroughs, and comments](/assets/blog/grilling.jpeg)

```bash
/grill-me            # start the interview
/plannotator-last    # when a round arrives, open it in the browser
                     # mark it up, Send Feedback, agent computes the next round
```

That is the whole workflow. Review the questions, annotate or strike through parts of a question or an answer, send feedback, and iterate through each round of the session.

We are exploring more questionnaire-style input too, starting from shadcn's new [questionnaire component](https://ui.shadcn.com/docs/components/base/questionnaire). But what we keep finding is that the ability to annotate each part of a question or answer, rather than just selecting answers, is where the power is.

Codex ships annotation in its native app now too, and it is good. It has been fun iterating on these ideas with their team in the open on X, down to some of the naming, and if you live in the Codex app their version is worth using.

What do I mean by iterating through rounds? Each round arrives as a new agent message, and it usually carries answers and clarifications to the feedback you sent on the previous one. Annotate those too. This ergonomic fits right into the agent session, because these are just agent messages.

![Round two of a grill-me session in the Plannotator UI: the agent's answers and clarifications from the previous round, annotated again](/assets/blog/iterate.jpeg)

One last benefit: compounding. Every annotation you make is stored locally, and it is your data. If you later want to build skills out of how you answer certain things, design taste, system decisions, whatever, the raw material is already on your disk. Plannotator is a local open source tool. No data is collected, not even telemetry.

We posted a marked-up session here: [@plannotator on X](https://x.com/plannotator/status/2088688374790160503).

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then run a grill session and hit `/plannotator-last` on the first round.
