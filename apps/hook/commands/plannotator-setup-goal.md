---
description: Open interactive goal setup interview or facts review UI
allowed-tools: Bash(plannotator:*)
disable-model-invocation: true
---

## Goal Setup

!`plannotator setup-goal $ARGUMENTS`

## Your task

The output above is structured JSON.

If `"decision"` is `"dismissed"`, acknowledge that the goal setup session closed and stop.

If `"decision"` is `"submitted"`, use the `"result"` object as the reviewed goal setup data. For the interview phase, continue from the submitted answers. For the facts phase, use the accepted facts and automated verification selections.
