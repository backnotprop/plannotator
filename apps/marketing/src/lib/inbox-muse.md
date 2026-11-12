# Connect Muse to the person's Plannotator Inbox

You are Muse, Meta's personal agent, on your own cloud computer. The person uses Plannotator Inbox, an app on their computer where they talk with their coding agents. They sent you this page and a pairing string (it starts with `plannotator-pairing-2.`). Follow these steps once, in order. After that you read the Inbox threads the person gives you and answer in them under your own name. Everything you send and read is sealed end to end; the relay in between cannot read it.

Three rules, always:

- Never print, echo, log or repeat the pairing string. Never put it in a message, a memory, a connector, a repository or a file other than the one in step 2. Anyone holding it can read your threads and post as you.
- Never ask the person for a key, token or password. Plannotator needs none from them.
- Answer the person's Inbox messages in the Inbox (step 7), not in this chat. In this chat, say only what this page tells you to say.

## 1. Install the `plannotator` command

When `plannotator --version` fails (the first time, or after your computer was replaced), run:

```sh
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal --non-interactive
export PATH="$HOME/.local/bin:$PATH"
```

Check: `plannotator --version` prints a version.

## 2. Keep the pairing string in a file only you can read

Your runs here are unattended, so do not put it in the Secure Credentials Store (that asks for approval). Save it once, without printing it, putting the whole string from the person's message between the quotes:

```sh
umask 077; mkdir -p ~/.config/plannotator
printf '%s' 'plannotator-pairing-2.(the whole string)' > ~/.config/plannotator/pairing
```

Start every command that talks to the Inbox with:

```sh
export PATH="$HOME/.local/bin:$PATH"; export PLANNOTATOR_PAIRING="$(cat ~/.config/plannotator/pairing)"
```

## 3. Check the setup

```sh
plannotator inbox call whoami
```

It works when it exits 0 and prints one line of JSON with your `name`. The person's Inbox Settings then shows "Connected". Otherwise it prints one line `<code>: <what is wrong>`. Then delete the saved string (`rm -f ~/.config/plannotator/pairing`), do what the table says, and stop:

| Code | What it means and what to do |
|---|---|
| `invalid_pairing` | The string is cut off or changed, or has spaces or line breaks in it. Ask the person to copy the whole message from Plannotator's Settings again. |
| `pairing_removed` | The person removed you, or made a new pairing. Ask them to pair you again in Plannotator's Settings (Cloud agents) and send you the new message. |
| `pairing_without_relay` | The string was made while their computer could not reach the relay. Ask them for a new pairing. |
| `relay_unreachable` | Your computer cannot reach the relay address in the string. Tell the person which host, and that your web access must allow it. |
| `computer_asleep` | The person's computer is asleep or offline. The string is fine: keep it (do not delete it), tell the person, and run this step again later. |

When it works, keep the signal address. It is a public address whose value changes only when the person writes in one of your threads; it needs no login:

```sh
umask 077; mkdir -p ~/hooks/state
plannotator inbox call whoami | sed -n 's/.*"signal_url":"\([^"]*\)".*/\1/p' > ~/.config/plannotator/signal_url
curl -fsS --max-time 10 "$(cat ~/.config/plannotator/signal_url)" > ~/hooks/state/plannotator-inbox-signal
```

Check: `~/.config/plannotator/signal_url` holds one web address.

## 4. Answer what is already waiting

The person may have written to you before you were set up. Do step 7 once now.

## 5. Hear the person quickly: the hook

Your runtime can run a small script every few seconds and wake you only when something changed (a hook). Meta does not document hooks; they come from people who found them by experiment, and Meta can change or remove them at any time. If you have no hooks tool, or any part of this step fails, skip to step 6. Do not invent another way.

Write this script, exactly, to `~/hooks/scripts/plannotator-inbox.sh` and make it executable (`chmod 700`). It saves the new value before it wakes you, so one change wakes you once:

```sh
#!/bin/bash
source "$HATCH_HOOK_RUNTIME"
url="$(cat "$HOME/.config/plannotator/signal_url" 2>/dev/null)"
[ -n "$url" ] || silent "plannotator-inbox: not set up" '{}'
now="$(curl --fail --silent --show-error --max-time 8 "$url" 2>/dev/null)" || silent "plannotator-inbox: signal not reachable" '{}'
seen="$(cat "$HOME/hooks/state/plannotator-inbox-signal" 2>/dev/null)"
[ "$now" = "$seen" ] && silent "plannotator-inbox: nothing new" '{}'
[ "$HATCH_HOOK_DRY_RUN" = "1" ] || printf '%s' "$now" > "$HOME/hooks/state/plannotator-inbox-signal"
wake "plannotator-inbox" '{"source":"plannotator-inbox"}'
```

Add the hook with your hooks tool (`hooks.add`): id `plannotator-inbox`, version `1`, script path `~/hooks/scripts/plannotator-inbox.sh`, poll interval 10 seconds (never less: the signal allows 20 reads a minute), script timeout 20 seconds, delivery to this chat (however your hooks tool names the current conversation), and as its prompt the words in "The prompt" below. It starts disabled: dry-run it (`hooks.dry_run`), and when the dry run ends without an error, enable it (`hooks.enable`).

If the hook is enabled, you are done with this step: do not set up step 6.

## 6. Only without the hook: a check every 5 minutes

If step 5 did not work, create a recurring scheduled task named "Plannotator Inbox" that runs every 5 minutes, with the words in "The prompt" below as its instruction. Each run starts you, so a check costs one of your runs (about 288 a day). Do not use a plain cron file or script for this: it cannot start you, so nobody would answer.

## The prompt

Use these words, exactly, for the hook's prompt or the scheduled task's instruction:

    Plannotator Inbox: the person may have written to you. Follow step 7 of https://plannotator.ai/inbox/muse.md: list your threads and answer, in the Inbox, every thread marked unread. Say nothing in this chat.

## 7. Read and answer

List your threads (after the `export` line from step 2):

```sh
plannotator inbox call read_thread '{}'
```

Each row has a `thread_id`, and `"unread": true` where the person wrote something you have not read, with their latest message's id in `last_person_message_id`. If no row is unread, stop: say nothing. For each unread thread, read it:

```sh
plannotator inbox call read_thread '{"thread_id":"<thread id>"}'
```

Do what the person asked, with your own tools. If you cannot, say so in the thread and ask; never make things up. Then answer in that thread, replying to their latest message:

```sh
plannotator inbox call send_message '{"reply_to":"<their latest message id>","body":"<your answer>"}'
```

- A question for the person goes in the body as a card. They answer it in the Inbox, and the answer reaches you like any message:

      :::question
      Book the 9:40 train?
      - Yes
      - No
      :::

- If read_thread says `name_this_thread: true`, add `"thread": "<a few words>"` to that reply: it names the thread.
- To start a new thread yourself: `send_message` with `"subject"` and `"body"` and no `reply_to`.
- Files: `"attachments": ["report.md", "shot.png"]`, paths on your computer; they are sent as bytes and show below your message.
- If `send_message` prints `"queued": true`, the person's computer is asleep. It is posted once when the computer is back. Do not send it again.
- `computer_asleep` on a read, or `too_many_waiting` on a send (many of your messages already wait for the person's computer): end quietly and send nothing more; the next change wakes you again.
- `pairing_removed` or `invalid_pairing` at any time: disable the `plannotator-inbox` hook or delete the "Plannotator Inbox" task, and tell the person once in this chat that you were unpaired and they can make a new pairing in Plannotator's Settings.
- You can never answer the person's own questions, approve anything for them, or see threads they did not give you. That is by design.
- `plannotator inbox call --help` lists everything you can do.

## 8. Tell the person

One short line in this chat, in plain words, for example: "Connected to your Plannotator Inbox as Muse. I'll see your messages there within about a minute." Without the hook: "... I check every 5 minutes." If step 3 failed, say what the table says to ask for. Do not mention scripts, hooks, signals or files.
