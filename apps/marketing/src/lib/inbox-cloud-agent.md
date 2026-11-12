# Connect yourself to the person's Plannotator Inbox

The person uses Plannotator Inbox, an app on their computer where they talk with their coding agents. They sent you this page and a pairing string (it starts with `plannotator-pairing-2.`). Follow these steps once. After that you can read the Inbox threads the person gives you and answer in them under your own name. Everything you send and read is sealed end to end; the relay in between cannot read it.

Two rules, always:

- Never print, echo, log or repeat the pairing string. Never put it in a repository, a commit, a pull request, an issue or a message. Anyone holding it can read your threads and post as you.
- Never ask the person for a webhook key, token or password. When a webhook wakes you, the person pastes its key into their Inbox themselves.

## 1. Install the `plannotator` command

In every run where `plannotator --version` fails, run:

    curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal --non-interactive
    export PATH="$HOME/.local/bin:$PATH"

Check: `plannotator --version` prints a version.

## 2. Keep the pairing string as `PLANNOTATOR_PAIRING`

Every `plannotator inbox call` reads the pairing string from the environment variable `PLANNOTATOR_PAIRING`.

- **Claude Code routine:** the person put it in the routine's cloud environment already. Check with `test -n "$PLANNOTATOR_PAIRING" && echo set`. If it is not set, tell the person: "Add the PLANNOTATOR_PAIRING line from Plannotator's Settings to this routine's cloud environment (Environment variables), then run the routine again." Then stop.
- **Grok Bot, or any other agent:** if your platform keeps secrets as environment variables for every run, store it there as `PLANNOTATOR_PAIRING`. Otherwise save it once in a file only you can read, outside any repository, without printing it:

      umask 077; mkdir -p ~/.config/plannotator
      printf '%s' 'plannotator-pairing-2.(the whole string)' > ~/.config/plannotator/pairing

  and start every run with:

      export PLANNOTATOR_PAIRING="$(cat ~/.config/plannotator/pairing)"

## 3. Check the setup

    plannotator inbox call whoami

It works when it exits 0 and prints one line of JSON with your `name`. The person's Settings then shows "Connected". Tell the person in one line, for example: "Connected to your Plannotator Inbox as Nightly fixer."

Then do step 5 once right away: the person may have written to you already.

Otherwise it prints one line `<code>: <what is wrong>`:

| Code | What it means and what to do |
|---|---|
| `invalid_pairing` | The string is cut off or changed, or has spaces or line breaks in it. Ask the person to copy it again, whole. |
| `pairing_removed` | The person removed you, or made a new pairing. Ask them for the new one (Settings, Devices, Cloud agents, New pairing). |
| `pairing_without_relay` | The string was made while their computer could not reach the relay. Ask them for a new pairing. |
| `relay_unreachable` | This machine cannot reach the relay address in the string. Claude Code routine: ask the person to add the hosts Plannotator's Settings showed under Network access, Allowed domains. Other platforms: the network blocks it; tell the person which host. |
| `computer_asleep` | The person's computer is asleep or offline. The setup is fine; try again later. |

`whoami` also prints `signal_url`. Keep it as private as the pairing string.

## 4. Know when the person writes to you

Pick what your platform has. Be honest with the person about which one you set up.

**A wake (best).** The person's Inbox calls your webhook each time they write to you, with the thread id and their words.

- **Claude Code routine:** the routine needs an API trigger. Tell the person: "In the routine on claude.ai/code: Edit, add an API trigger, Generate token. Then in Plannotator Settings, Devices, Cloud agents, press Add wake address and paste the Fire URL and the token." Routines cannot run more often than once an hour on a schedule, so the wake is the way.
- **Grok Bot:** add a webhook trigger to the routine that does this work (if there is none, create a routine named "Plannotator Inbox" whose instruction is: "Follow https://plannotator.ai/inbox/cloud-agent.md, steps 1 to 5."). Then tell the person: "Open this routine in the Grok Bot desktop app, Webhook section. In Plannotator Settings, Devices, Cloud agents, press Add wake address and paste POST to and the key." Do not ask them to send you the key.
- **Grok Bot also needs one rule**, or a woken run stops and waits for approval. Tell the person: "In Grok Bot, open Settings, General, Auto-review, and under Custom Rules add an Allow automatically rule for running plannotator inbox call in this routine." (Some versions show it as Settings, General, Bot, Auto-review.)

**Polling (no webhook).** `signal_url` answers `{"signal":"..."}`; the value changes when the person writes in one of your threads. Read it with `curl -fsS "$SIGNAL_URL"`. At most 20 reads a minute.

- **Fast check:** only if your platform has a way to run a small check every 10 seconds or so (a long-running process, a heartbeat), read the signal every 10 seconds, and when the value differs from the last one you saw, do step 5. Neither Claude Code routines nor Grok Bot document such a hook; do not invent one.
- **Scheduled check (fallback):** a schedule that starts a run of you every 5 minutes. Each run reads the signal, compares it with the value saved last time (in a file), and does step 5 only when it changed. It must start you, the agent: a plain cron job that runs a script cannot answer the person, so do not set one up as if it could. Grok Bot accepts schedules in plain words ("every 5 minutes"); the shortest interval it allows is not documented. Claude Code routines cannot run more often than hourly; use the wake there.
- If your platform has neither a wake nor a schedule that starts you, say so plainly: you will see the person's messages only when they start you.

## 5. Read and answer

When woken, the wake's text names the thread id. When polling, list your threads first:

    plannotator inbox call read_thread '{}'

Each row has the thread id, and `unread: true` where the person wrote something you have not read. Read a thread:

    plannotator inbox call read_thread '{"thread_id":"<thread id>"}'

Do what the person asked, with your own tools and repositories. Then answer in that thread, replying to the person's latest message (its id is in read_thread's output; in a new thread it is the thread id):

    plannotator inbox call send_message '{"reply_to":"<their message id>","body":"<your answer>"}'

- A question for the person goes in the body as a card. They answer it in the Inbox, and the answer reaches you like any message:

      :::question
      Ship the fix tonight?
      - Yes
      - No
      :::

- If read_thread says `name_this_thread: true`, add `"thread": "<a few words>"` to that reply: it names the thread.
- Files: `"attachments": ["report.md", "shot.png"]`, paths on your machine; they are sent as bytes and show below your message.
- If `send_message` prints `"queued": true`, the person's computer is asleep. It is posted once when the computer is back. Do not send it again.
- A wake that says it is a test from Settings needs nothing: end the run.
- `plannotator inbox call --help` lists everything you can do.
