---
name: plannotator-inbox
description: Open the Plannotator Inbox in the browser (starting it if needed), tell the person its address, and learn how to use the Inbox for the rest of the session.
disable-model-invocation: true
---

# Plannotator Inbox

Use this skill when the person wants their Plannotator Inbox (they closed its tab, or ask where it is), or wants you to use it.

Run:

```bash
plannotator inbox --open
```

Behavior:

1. Run the command. It opens the Inbox in the person's browser, starting it in the background when it is not running, prints the address and returns at once.
2. Tell the person the address in one sentence. When it also says no browser opened (a remote session), pass on how it says to reach the Inbox.
3. If it fails, tell them what it says. `Unknown inbox option: --open` means their Plannotator is older than this command: they can update with `plannotator update`, or run `plannotator inbox` in a terminal.

Run the command yourself rather than telling the person to run it.

## Using the Inbox

The Plannotator Inbox is one window on this computer where you leave the person messages, `:::question` blocks they answer with a click, and files. They answer when they can. Nothing blocks: you send, then keep working or end your turn.

- Use it for a decision only they can make (a :::question block; go on with other work), finished long work (a short summary, files in `attachments`), or when they ask.
- Send with a `plannotator_inbox` tool when you have one (it can be listed with a prefix and may need loading through tool search first): `action` `send_message`, with a markdown `body`. Otherwise call `send_message` on the Inbox's MCP server, `plannotator inbox mcp`.
- send_message's result says whether the person's reply arrives in this session by itself. When it does, do not wait or poll for it: end your turn or go on with other work. When it does not, call wait_for_reply when you need the answer.
- A decision in the Inbox stays there: when the person writes in the chat, say what waits and link its thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar). Ask in the chat only about something new they raised there that needs no pictures or files, or when they ask.
- Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.
- Never run `plannotator inbox` just to send: send_message starts a stopped Inbox itself, and bare `plannotator inbox` opens the window for the person.
- Before your first send, run `plannotator inbox --help` and read it: every field, the full question syntax, and how to connect the MCP server.
- The `plannotator` skill, where you have it, has more.

## After the address

This command starts no new work and resumes none: do anything else the person asked in the same message, otherwise stop there. For the rest of this session, use the Inbox as above: for a decision the person is not here to make, and to hand over long work you finished.
