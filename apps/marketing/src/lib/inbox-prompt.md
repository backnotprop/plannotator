# Set up the Plannotator Inbox

The Plannotator Inbox is one local window per machine where coding agents leave the person questions, files to annotate and reviews of their work, and the person answers when they can. It runs on `127.0.0.1` only and keeps its data in `~/.plannotator/inbox/`.

You are an agent. Set the Inbox up for the person you work with, connect yourself to it, send them one message and confirm that their reply reached you. Follow the steps in order.

Rules for every step:

- Never run `plannotator uninstall`, never delete files, never stop processes.
- Never guess a flag. When unsure, run `plannotator --help` or `plannotator inbox --help`. If the CLI and this text disagree, the CLI is right.
- If a command fails because of a sandbox, missing permissions or no network, stop and give the person the exact command to run in their own terminal.
- Running this setup twice is safe. Skip any step that is already done.

## 1. Install or update Plannotator

Run `plannotator --version`. If `plannotator` is not found, try `~/.local/bin/plannotator --version` (PowerShell: `& "$env:LOCALAPPDATA\plannotator\plannotator.exe" --version`). If that works, use that path for every command below.

Install Plannotator when it is missing. Update it when the output of `plannotator inbox --help` does not start with `# Plannotator Inbox: a guide for agents` (an older release). The same command does both:

- macOS, Linux, WSL: `curl -fsSL https://plannotator.ai/install.sh | bash -s -- --non-interactive`
- Windows PowerShell: `& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -NonInteractive`

The installer needs `git` for the slash-command skills. If `git` is missing, add `--skip-skills` (PowerShell: `-SkipSkills`); everything else still installs. The binary goes to `~/.local/bin/plannotator`. If that folder is not on `PATH` in your shell, call the binary by its full path.

Note the absolute path of the binary: `command -v plannotator` (PowerShell: `(Get-Command plannotator).Source`).

## 2. Start the Inbox and open it

1. Run `plannotator inbox --background`. It starts the Inbox without a browser (or finds the running one), prints its URL and exits.
2. Run `plannotator inbox`. With the Inbox running, it opens the window in the browser and exits. If no browser opens (SSH, container, headless), give the person the URL from step 2.1 and tell them to open it on this machine.

## 3. Read the guide and connect yourself

Run `plannotator inbox --help` and read all of it. It is the installed release's guide for agents: the tools, threads and questions. Then follow its "Connecting yourself" section for your host (Claude Code, Pi, OpenCode, Codex, Cursor or another MCP client; ask the person if you cannot tell which you are). Use the absolute path from step 1 wherever a command names `plannotator`. Tell the person when a restart is needed.

A connection takes effect when a session starts, never in the session that is running now. Do not wait for it: step 4 works without it.

## 4. Send the first message

If you have a tool whose name ends in `plannotator_inbox`, call it with `action: "send_message"` plus the fields of the `arguments` object below as top-level fields, leaving out `agent_name` and `agent_host` (the tool fills them). Every later call in this setup (`read_thread`, `wait_for_reply`, `resolve_message`) works the same way: `action` set to the MCP tool's name, its fields beside it. Otherwise send through the stdio MCP command, which works from any shell:

1. Write the JSON below to a temporary file as ONE line, for example `/tmp/plannotator-inbox-first.json`. Use your file-writing tool, not `echo` (some shells rewrite `\n`). Replace `AGENT_NAME` (how the person knows you, e.g. "Codex") and `AGENT_HOST` (e.g. `codex`; also in the `idempotency_key`).
2. From the person's project folder, run `plannotator inbox mcp < /tmp/plannotator-inbox-first.json` (PowerShell: `Get-Content /path/to/file | plannotator inbox mcp`). It prints one JSON-RPC answer. Keep `result.structuredContent.thread_id`.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send_message","arguments":{"subject":"Your Plannotator Inbox is set up","agent_name":"AGENT_NAME","agent_host":"AGENT_HOST","idempotency_key":"plannotator-inbox-first-v1-AGENT_HOST","body":"This is your Plannotator Inbox. Agents leave you questions, files to annotate and reviews of their work here while they keep working.\n\nClick a choice to answer, then press **Send** (Cmd or Ctrl + Enter). Nothing reaches the agent until you send.\n\n:::question\nWant me to send some of our recent work here so you can see how it works?\n\n- [ ] Yes, send something from what we are working on\n- [ ] No, the setup is enough for now\n\nRecommended: Yes, send something from what we are working on\n:::"}}}
```

If the answer says "Already sent", this setup ran before. Read the thread (`read_thread` with the `thread_id`, sent the same way) and skip step 5 if the person already replied.

Tell the person: "Your Inbox is set up and I sent you a first message there. Pick an answer and press Send."

## 5. Wait for the reply and act on it

Call `wait_for_reply` with the `thread_id`, the same way you sent the message. Through the stdio command, pass `timeout_seconds: 45` (lower it if your shell stops commands sooner):

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wait_for_reply","arguments":{"thread_id":"THREAD_ID","timeout_seconds":45}}}
```

It returns the reply as soon as the person sends it, or `{ "status": "waiting", "cursor": N }`. Then call it again with `"cursor": N`. After about five minutes without a reply, stop and tell the person to say "done" when they have sent it.

When the reply arrives, quote it back to the person to show the round trip worked. Then resolve the first thread with `resolve_message` (`message_id` = its `thread_id`). It moves to Quiet and nothing is deleted. Your next message starts a new thread.

- **Yes:** send one or two real messages from what you and the person are actually working on in this project: an open decision written as a `:::question` block (the syntax is in `plannotator inbox --help`), and, if there is one, a plan or document you wrote, attached with `attachments: ["path"]` so they can annotate it. Keep them short and real. Never invent work, and never send secrets or `.env` files. If this session has no work to draw on, say so and send nothing more.
- **No:** do nothing more.

## 6. Tell the person, in plain words

- Where replies go: to the session that asked. Claude Code, Pi and OpenCode 2 get the reply as their next turn once idle. Other agents read it when they call `wait_for_reply`.
- Notifications: the open Inbox page can show a browser notification when a question arrives while its tab is in the background. It asks once. Change it in the Inbox's Settings.
- Local only: the Inbox listens on `127.0.0.1`. Threads, answers, attached files and decisions are files in `~/.plannotator/inbox/`. Nothing leaves the machine.
- Opening it later: `plannotator inbox`. Agents start a stopped Inbox in the background when they write to it.
