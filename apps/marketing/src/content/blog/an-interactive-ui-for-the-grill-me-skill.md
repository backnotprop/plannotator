---
title: "An interactive UI for the grill-me skill"
description: "Run /plannotator-last on a grill-me round: the questions open in your browser, you strike out assumptions and comment on fragments, and the feedback goes straight back to the agent."
date: 2026-08-15
author: "backnotprop"
tags: ["annotate", "grill-me", "skills", "workflow"]
---

[Matt Pocock](https://www.aihero.dev)'s [`/grill-me`](https://www.aihero.dev/skills-grill-me) skill interviews you about a loose idea until it is sharp enough to commit to. It asks in rounds: a batch of numbered questions, each with a recommended answer, and then it waits. Answering that in a terminal is cramped. You reply serially by number, scroll up to re-read Q7 while typing about Q3, and edit long answers in a prompt box.

Plannotator fixes this with one command. `/plannotator-last` opens the agent's last message in your browser and makes it annotatable. Works in Claude Code, Codex CLI, OpenCode, and Pi. Mark up the round, hit Send Feedback, and the annotations go straight back to the agent as its next input.

![A grill-me round open in Plannotator: question text highlighted, several recommended answers struck through, comments listed in the sidebar](/assets/blog/grilling.jpeg)

```bash
/grill-me            # start the interview
/plannotator-last    # when a round arrives, open it in the browser
                     # mark it up, Send Feedback, agent computes the next round
```

Strikethrough gets the most use. Models in grill sessions assume things constantly, usually inside the recommended answer, and crossing out the clause you reject is faster than typing "on Q4, the second half of the recommendation is wrong because...". Highlight a fragment and comment on exactly that fragment. Correct scope drift in the margin next to the sentence that drifted.

This is why annotation beats a questionnaire for this job. A questionnaire takes one answer per question. Annotation lets you answer part of a question, reject a premise without answering at all, accept a recommendation but narrow it, or just delete an assumption. [Matt's own docs](https://raw.githubusercontent.com/mattpocock/skills/refs/heads/main/skills/productivity/grilling/SKILL.md) name the failure mode: answering "agreed, agreed, agreed" for forty questions and coming out with a plan the agent wrote and you nodded at. Pushing back is the point, and markup is a faster way to push back than prose.

The same flow works for [`/grill-with-docs`](https://aihero.dev/skills-grill-with-docs), and for annotating [`/to-spec`](https://aihero.dev/skills-to-spec) and [`/prototype`](https://aihero.dev/skills-prototype) output when you continue into the build.

Two notes for balance. The Codex team added message annotation to their app after watching how people used Plannotator, and what they shipped is good; if you live in the Codex app, use it. And questionnaire-style input has its place for rounds that really are just structured answers. We are looking at shadcn's new [questionnaire component](https://ui.shadcn.com/docs/components/base/questionnaire) for that. It would sit alongside annotation, not replace it.

We posted a marked-up session here: [@plannotator on X](https://x.com/plannotator/status/2088688374790160503).

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then run a grill session and hit `/plannotator-last` on the first round.
