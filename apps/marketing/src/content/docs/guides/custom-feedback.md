---
title: Custom Feedback Messages
description: "How to customize the messages Plannotator sends to your agent when you approve, deny, or annotate plans and documents."
sidebar:
  order: 29
section: "Guides"
---

Every time you approve a plan, deny it with feedback, annotate a file, or finish a code review, Plannotator sends a message to the agent. These messages are what the agent actually sees and acts on. By default they work well, but you can change any of them to match how you want your agent to behave.

All customization happens in `~/.plannotator/config.json` under the `prompts` key. No restart needed. Changes take effect the next time a feedback message is generated. You can set overrides that apply globally, or target a specific agent runtime (Claude Code, OpenCode, Pi, etc.) with [runtime-specific overrides](#runtime-specific-overrides).

## Quick example

Say you want a shorter, more direct plan denial message. Add a `prompts.plan.denied` override to your config file (`~/.plannotator/config.json`):

```json
{
  "prompts": {
    "plan": {
      "denied": "PLAN REJECTED.\n\nFix these issues and resubmit via {{toolName}}:\n\n{{feedback}}"
    }
  }
}
```

Next time you deny a plan, the agent will see your custom message instead of the default. The `{{toolName}}` and `{{feedback}}` placeholders get filled in automatically.

## What you can customize

There are three sections: `plan`, `annotate`, and `review`. Each has its own set of message types.

### Plan feedback

These are sent when you approve or deny a plan in the review UI.

| Key | When it's used | Available variables |
|-----|---------------|-------------------|
| `denied` | You deny a plan (with or without annotations) | `{{toolName}}`, `{{feedback}}`, `{{planFileRule}}` |
| `approved` | You approve a plan without notes | `{{planFilePath}}`, `{{doneMsg}}` |
| `approvedWithNotes` | You approve but include annotation notes | `{{planFilePath}}`, `{{doneMsg}}`, `{{feedback}}` |
| `autoApproved` | Plan is auto-approved in non-interactive mode | none |

### Annotation feedback

These are sent when you annotate a file (`/plannotator-annotate`) or the last assistant message (`/plannotator-last`).

| Key | When it's used | Available variables |
|-----|---------------|-------------------|
| `fileFeedback` | You annotate a file or folder | `{{fileHeader}}`, `{{filePath}}`, `{{feedback}}` |
| `messageFeedback` | You annotate the last assistant message | `{{feedback}}` |

### Review feedback

These are sent during code review (`/plannotator-review`).

| Key | When it's used | Available variables |
|-----|---------------|-------------------|
| `approved` | You approve a code review with no feedback | none |
| `denied` | Appended after your review feedback | none |

## Template variables

Templates use `{{variable}}` placeholders. Here's what each one contains:

| Variable | Description |
|----------|-------------|
| `{{feedback}}` | Your annotations, exported as structured text. This is the main content. |
| `{{toolName}}` | The tool the agent needs to call to resubmit (`ExitPlanMode`, `submit_plan`, etc.). Varies by runtime. |
| `{{planFileRule}}` | A conditional line telling the agent where the plan file is saved and how to edit it. Empty string when there's no file path. |
| `{{planFilePath}}` | Path to the plan file being reviewed. |
| `{{doneMsg}}` | Optional checklist instruction or save-path info, depending on the runtime. |
| `{{fileHeader}}` | Either `"File"` or `"Folder"`, depending on what was annotated. |
| `{{filePath}}` | Path to the annotated file or folder. |

If you use a `{{variable}}` that doesn't exist for that message type, it stays in the output as-is. This means you can include literal `{{text}}` in your templates without worrying about it being stripped.

## Runtime-specific overrides

Different agent runtimes (Claude Code, OpenCode, Pi, Gemini CLI, etc.) sometimes need different messages. For example, OpenCode's plan approval is shorter because the agent already knows it has tool access.

You can override a message for a specific runtime using the `runtimes` key:

```json
{
  "prompts": {
    "plan": {
      "denied": "PLAN REJECTED.\n\n{{feedback}}",
      "runtimes": {
        "claude-code": {
          "denied": "Your plan was not approved. Address ALL feedback below, then call {{toolName}} again.\n\n{{feedback}}"
        },
        "opencode": {
          "denied": "Plan rejected. Fix the following and call {{toolName}}:\n\n{{feedback}}"
        }
      }
    }
  }
}
```

The resolution order is:

1. Runtime-specific config override (e.g., `prompts.plan.runtimes.opencode.denied`)
2. Generic config override (e.g., `prompts.plan.denied`)
3. Built-in default (some prompts have runtime-specific built-in defaults, like OpenCode's shorter plan approval)

Blank or whitespace-only values are treated as "not set" and fall through to the next level. This means you can clear a runtime override by setting it to `""` without affecting others.

Valid runtime keys: `claude-code`, `opencode`, `copilot-cli`, `pi`, `codex`, `gemini-cli`.

## Full config example

Here's a config that customizes several messages at once:

```json
{
  "prompts": {
    "plan": {
      "denied": "PLAN NOT APPROVED.\n\nRevise your plan based on this feedback, then resubmit via {{toolName}}.\n\n{{feedback}}",
      "approved": "Plan approved. Begin implementation.",
      "approvedWithNotes": "Plan approved with the following notes:\n\n{{feedback}}\n\nKeep these in mind as you implement."
    },
    "annotate": {
      "fileFeedback": "# Annotations for {{filePath}}\n\n{{feedback}}\n\nPlease address these.",
      "messageFeedback": "{{feedback}}\n\nRevise your response based on these notes."
    },
    "review": {
      "approved": "Code review passed. No changes needed."
    }
  }
}
```

## Defaults

If you don't set any `prompts` config, everything works the same as it always has. The built-in defaults are the exact messages Plannotator has always sent. Here are the key ones for reference:

**Plan denied (default):**
```
YOUR PLAN WAS NOT APPROVED.

You MUST revise the plan to address ALL of the feedback below
before calling {{toolName}} again.

Rules:
{{planFileRule}}- Do not resubmit the same plan unchanged.
- Do NOT change the plan title (first # heading) unless the
  user explicitly asks you to.

{{feedback}}
```

**Plan approved (default, Pi runtime):**
```
Plan approved. You now have full tool access (read, bash, edit,
write). Execute the plan in {{planFilePath}}. {{doneMsg}}
```

**Annotate file feedback (default):**
```
# Markdown Annotations

{{fileHeader}}: {{filePath}}

{{feedback}}

Please address the annotation feedback above.
```

## Example: context anchoring with a Decisions Log

When you deny a plan multiple times, the agent only sees the current round's feedback. It can re-propose the same rejected approach without realizing it was already rejected. Martin Fowler's [context anchoring](https://martinfowler.com/articles/reduce-friction-ai/context-anchoring.html) pattern solves this by having the agent maintain a running log of rejected decisions directly in the plan document.

You can implement this entirely through feedback customization. Add a `## Context Anchoring` section to your denial template that instructs the agent to keep a `## Decisions Log` in the plan itself:

```json
{
  "prompts": {
    "plan": {
      "denied": "YOUR PLAN WAS NOT APPROVED.\n\nYou MUST revise the plan to address ALL of the feedback below before calling {{toolName}} again.\n\nRules:\n{{planFileRule}}- Do not resubmit the same plan unchanged.\n- Do NOT change the plan title (first # heading) unless the user explicitly asks you to.\n\n## Context Anchoring\n\nBefore revising your plan:\n1. Add (or update) a `## Decisions Log` section at the bottom of the plan.\n2. For each rejected approach from this feedback, add an entry:\n   - **Rejected:** [brief description]  **Why:** [reason from this feedback]\n3. Do NOT re-propose approaches already in the Decisions Log.\n\n{{feedback}}",
      "approved": "Plan approved. Begin implementation.\n\nIf your plan contains a `## Decisions Log`, keep it as a reference during implementation. It documents the rejected alternatives that shaped this design.",
      "approvedWithNotes": "Plan approved with the following notes:\n\n{{feedback}}\n\nKeep these in mind as you implement.\n\nIf your plan contains a `## Decisions Log`, keep it as a reference during implementation. It documents the rejected alternatives that shaped this design."
    }
  }
}
```

This works because the plan is already a persistent artifact (saved to version history on every submission). The Decisions Log travels with every revision, is visible in the plan diff view, and survives context window resets since it lives in the document, not just the conversation.

*This example is based on a contribution by [Aviad Shiber](https://github.com/aviadshiber).*

## Tips

- Start by customizing `plan.denied` since that's the message agents see most often during iterative planning.
- Keep the `{{feedback}}` variable in your templates. Without it, the agent won't see your annotations.
- The denial message framing matters. Claude was tested to respond better to strong, directive language ("You MUST revise") than softer phrasing. If you soften the tone too much, you may notice the agent ignoring feedback or resubmitting unchanged plans.
- You can test your templates by denying a plan and checking what the agent receives. The full message shows up in the agent's conversation.
