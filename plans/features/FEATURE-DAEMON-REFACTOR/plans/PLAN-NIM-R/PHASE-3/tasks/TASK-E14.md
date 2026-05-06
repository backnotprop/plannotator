---
id: TASK-E14
trackerStatus:
  type: task
title: OpenCode shim (plugin contract tests)
description: 'Tests the plugin''s observable behavior against a stubbed OpenCode runtime.
  Goal: verify plugin code path, not its embedding.  | # | Test | Pass condition |
  |---|------|----------------| | 14.1 | `submit_plan` tool invocation with valid
  args | shells out to `plannotator submit --json`; blocks; receives JSON verdict;
  returns documented success or feedback string | | 14.2 | `submit_plan` agent-switch
  case | on approve-with-agent-switch, calls `session.prompt({ noReply: true, ...
  })` with target agent name | | 14.3 | `plannotator_review` tool | non-blocking;
  backgrounded shell-out; UI feedback later triggers `session.prompt` | | 14.4 | `plannotator_annotate`
  | same async pattern as review | | 14.5 | System prompt injection: regular agent
  | injected text contains `submit_plan` instructions | | 14.6 | System prompt injection:
  title-generation request | NO injection | | 14.7 | System prompt injection: `build`
  agent | NO injection | | 14.8 | System prompt injection: subagent (`mode==="subagent"`)
  | NO injection | | 14.9 | Primary-only registration | `experimental.primary_tools`
  contains all three tool names after plugin startup |  Stub OpenCode using a small
  fixture that mimics the surface the plugin relies on: `app.agents()`, `session.prompt()`,
  experimental config.'
successCriteria:
- 'Plugin-contract coverage proves `submit_plan`, review, and annotate shell-out behavior against a realistic OpenCode fixture surface.'
- Agent-switch behavior and tool feedback integration are asserted through the session API the plugin actually uses.
- System-prompt injection and primary-tool registration behavior are locked down for the supported OpenCode modes.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: unstarted
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-6]]'
- '[[TASK-S-8]]'
- '[[TASK-D1]]'
- '[[TASK-E00]]'
---


## Activity Log

- 2026-05-02T04:05:48.860Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
