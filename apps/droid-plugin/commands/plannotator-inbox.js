#!/usr/bin/env node

// Opens the Plannotator Inbox in the browser (starting it in the background
// when it is not running) and prints its address, then a short guide to the
// Inbox for the agent, which reads this output. Returns at once.
const { exitWithFailure, runPlannotator } = require("../lib/run-plannotator");

// What the agent reads after the address: the same guide every
// /plannotator-inbox command carries (tests/inbox-guidance-parity.test.ts).
const GUIDE = [
  "",
  "## Using the Inbox",
  "",
  "The Plannotator Inbox is one window on this computer where you leave the person messages, `:::question` blocks they answer with a click, and files. They answer when they can. Nothing blocks: you send, then keep working or end your turn.",
  "",
  "- Use it for a decision only they can make (a :::question block; go on with other work), finished long work (a short summary, files in `attachments`), or when they ask.",
  "- Send with the `send_message` tool of the Inbox's MCP server, `plannotator inbox mcp`, with a markdown `body`.",
  "- send_message's result says whether the person's reply arrives in this session by itself. When it does, do not wait or poll for it: end your turn or go on with other work. When it does not, call wait_for_reply when you need the answer.",
  "- A decision in the Inbox stays there: when the person writes in the chat, say what waits and link its thread, but never also ask it in the chat with a blocking question tool (AskUserQuestion or similar). Ask in the chat only about something new they raised there that needs no pictures or files, or when they ask.",
  "- Be proactive about Inbox updates and about replying to the person through the Inbox when you think they would want you to. Don't withhold important updates or decisions, and don't batch updates to send later: proactivity is better than procrastination.",
  "- Never run `plannotator inbox` just to send: send_message starts a stopped Inbox itself, and bare `plannotator inbox` opens the window for the person.",
  "- Before your first send, run `plannotator inbox --help` and read it: every field, the full question syntax, and how to connect the MCP server.",
  "- The `plannotator` skill, where you have it, has more.",
  "",
  "## Your task",
  "",
  "Tell the user the Inbox's address above in one sentence, with the note under it when there is one (why no browser opened). This command starts no new work and resumes none: do anything else the person asked in the same message, otherwise stop there. For the rest of this session, use the Inbox as above: for a decision the person is not here to make, and to hand over long work you finished.",
].join("\n");

// The CLI waits up to 20 s for an Inbox it starts; never wait much longer.
const result = runPlannotator(["inbox", "--open"], { timeout: 30_000 });

if (result.error || result.status !== 0) {
  exitWithFailure(result, "plannotator inbox --open");
}

// Stderr says why no browser opened, when none did (a remote session).
const note = (result.stderr || "").trim();
process.stdout.write(`Plannotator Inbox: ${result.stdout.trim()}${note ? `\n${note}` : ""}\n${GUIDE}\n`);
