---
name: plannotator-routine
description: "Make or change a routine in the Plannotator Inbox: a saved prompt that an agent on this computer runs by itself on a schedule, each run reporting in the routine's own Inbox thread. Use when the person asks for work that repeats or runs later on its own (\"every weekday at 9\", \"each Friday\", \"every morning\", \"tomorrow at 5 PM\") and reports back, or asks to list, change, pause or delete their routines. Not for work to do now, or for a reminder within this session."
disable-model-invocation: true
---

# Plannotator routines

A routine is a saved prompt with a schedule. At each scheduled time the Plannotator Inbox starts an agent on this computer, in the folder you chose, and the run replies in the routine's own Inbox thread. You make it with the `plannotator routine` command. What the person wants is the text that came with this command, else their last message.

## Before you make one

1. The person asked for it. Never make a routine on your own idea.
2. Use the schedule they gave. If they gave none ("check it regularly"), ask them when. Never make up a time or a frequency.
3. Run `plannotator routine create --help` once and read it: every option and its default.

## Make it

```bash
plannotator routine create --name "<a few words>" --cron '<minute hour day month weekday>' --prompt '<what each run does>'
```

- Write the prompt for a fresh agent that knows nothing of this chat: what to do, where, and what to report. For a long prompt, or one with quotes in it, use `--prompt -` and a quoted heredoc.
- Each run works in your project unless you pass `--folder <path>` (or `--scratch` for an empty folder). It runs as the agent you are unless you pass `--agent`.
- If you work in an Inbox thread, pass `--thread <id>`: the person then sees the new routine there.
- `--at 2026-11-20T17:00` in place of `--cron` runs it once.

Examples:

```bash
# "Every weekday at 9, check for outdated dependencies and tell me in the Inbox."
plannotator routine create --name "Dependency check" --cron '0 9 * * 1-5' \
  --prompt 'Check this repo for outdated dependencies. Reply with each outdated package, its current and latest version, and which updates look safe.'

# "Every Friday at 4 PM, draft the release notes." (a long prompt, from stdin)
plannotator routine create --name "Weekly release notes" --cron '0 16 * * 5' --prompt - <<'EOF'
Draft release notes from the pull requests merged since last Friday.
Group them into features, fixes and chores, and reply with the draft.
EOF

# "Stop the dependency check." (take the id from list)
plannotator routine list
plannotator routine off sch_1a2b
```

`plannotator routine --help` lists the other commands: `get`, `update`, `on`, `run`, `delete`.

## After you make it

Tell the person, in two or three lines:

- its name and its schedule in words, as the command's result says them;
- that it is off until they turn it on in the Inbox, and it runs only after that;
- that each run replies in the routine's own Inbox thread.

## Do not

- Do not invent a schedule, or make it run more often than the person asked.
- Do not start a run (`plannotator routine run`) unless the person asks for one now.
- Do not try to turn it on for the person: until they turn it on once in the Inbox, `on` and `run` answer `routine_not_approved`. Leave it off and tell them.
- If a command answers `routines_off`, tell the person that Routines are off in the Inbox (Settings → Capabilities), and stop. Do not change their settings.
- Do not pass `--model` or `--effort` unless the person asks for them.
