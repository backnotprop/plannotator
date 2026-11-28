// Made by the product's own code: `inboxPermissionQuestion` wrote each body and `readInboxPermissionBody` and
// `inboxPermissionCodeSpans` read it back (packages/core/inbox-permission.ts). Not edited by hand: to remake it,
// run those three over the same inputs and paste the JSON.
enum PermissionVectors {
  static let json = #"""
{
 "bash": {
  "body": "```\nbun run db:migrate --env staging\n```\n\nPurpose: Apply the billing migration to staging.\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to run a command\n\n- [ ] Allow once\n- [ ] Allow `bun run db:migrate` for this session\n- [ ] Deny\n- [ ] Allow and switch to Auto mode\n- [ ] Allow and switch to Full permissions\n:::",
  "prompt": "Claude Code wants to run a command",
  "choices": [
   "Allow once",
   "Allow `bun run db:migrate` for this session",
   "Deny",
   "Allow and switch to Auto mode",
   "Allow and switch to Full permissions"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "bun run db:migrate --env staging",
    "on": "block"
   },
   "preview": null,
   "leftover": null,
   "purpose": "Apply the billing migration to staging.",
   "folder": "~/work/api-server",
   "unsandboxed": false,
   "linksTo": null,
   "note": null,
   "handoff": null
  }
 },
 "bashMultiline": {
  "body": "Runs outside the sandbox.\n\n````\necho `id`\n:\u200b::question\ncat <<'EOF'\n```\nEOF\n````\n\n```input\n{\n  \"extra\": 1\n}\n```\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to run a command\n\n- [ ] Allow once\n- [ ] Deny\n- [ ] Allow and switch to Auto mode\n:::",
  "prompt": "Claude Code wants to run a command",
  "choices": [
   "Allow once",
   "Deny",
   "Allow and switch to Auto mode"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "echo `id`\n:::question\ncat <<'EOF'\n```\nEOF",
    "on": "block"
   },
   "preview": null,
   "leftover": "{\n  \"extra\": 1\n}",
   "purpose": null,
   "folder": "~/work/api-server",
   "unsandboxed": true,
   "linksTo": null,
   "note": null,
   "handoff": null
  }
 },
 "fetch": {
  "body": "`https://bun.sh/docs/bundler#splitting`\n\nPurpose: How does Bun split chunks, and can a chunk be capped by size?\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to open a web page\n\n- [ ] Allow once\n- [ ] Allow pages on bun.sh for this session\n- [ ] Deny\n- [ ] Allow and switch to Auto mode\n:::",
  "prompt": "Claude Code wants to open a web page",
  "choices": [
   "Allow once",
   "Allow pages on bun.sh for this session",
   "Deny",
   "Allow and switch to Auto mode"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "https://bun.sh/docs/bundler#splitting",
    "on": "line"
   },
   "preview": null,
   "leftover": null,
   "purpose": "How does Bun split chunks, and can a chunk be capped by size?",
   "folder": "~/work/api-server",
   "unsandboxed": false,
   "linksTo": null,
   "note": null,
   "handoff": null
  }
 },
 "edit": {
  "body": "`~/work/api-server/relay/client.ts`\n\nLinks to `~/shared/client.ts`\n\n```diff\n-const wait = 1000\n+const wait = Math.min(60_000, 1000 * 2 ** tries)\n```\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to edit a file\n\n- [ ] Allow once\n- [ ] Deny\n- [ ] Allow and switch to Auto mode\n:::",
  "prompt": "Claude Code wants to edit a file",
  "choices": [
   "Allow once",
   "Deny",
   "Allow and switch to Auto mode"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "~/work/api-server/relay/client.ts",
    "on": "line"
   },
   "preview": {
    "kind": "diff",
    "text": "-const wait = 1000\n+const wait = Math.min(60_000, 1000 * 2 ** tries)"
   },
   "leftover": null,
   "purpose": null,
   "folder": "~/work/api-server",
   "unsandboxed": false,
   "linksTo": "~/shared/client.ts",
   "note": null,
   "handoff": null
  }
 },
 "write": {
  "body": "`~/work/api-server/notes.md`\n\n```new\n# Notes\n\nOne.\n```\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to create a file\n\n- [ ] Allow once\n- [ ] Deny\n- [ ] Allow and switch to Auto mode\n:::",
  "prompt": "Claude Code wants to create a file",
  "choices": [
   "Allow once",
   "Deny",
   "Allow and switch to Auto mode"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "~/work/api-server/notes.md",
    "on": "line"
   },
   "preview": {
    "kind": "new",
    "text": "# Notes\n\nOne."
   },
   "leftover": null,
   "purpose": null,
   "folder": "~/work/api-server",
   "unsandboxed": false,
   "linksTo": null,
   "note": null,
   "handoff": null
  }
 },
 "terminalOnly": {
  "body": "```\nrm -rf build\n```\n\nNote: Claude approves this only in its own dialog.\n\nThen: Its dialog waits ten minutes.\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to run a command\n\n- [ ] Deny\n- [ ] Approve in Terminal\n:::",
  "prompt": "Claude Code wants to run a command",
  "choices": [
   "Deny",
   "Approve in Terminal"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "rm -rf build",
    "on": "block"
   },
   "preview": null,
   "leftover": null,
   "purpose": null,
   "folder": "~/work/api-server",
   "unsandboxed": false,
   "linksTo": null,
   "note": "Claude approves this only in its own dialog.",
   "handoff": "Its dialog waits ten minutes."
  }
 },
 "mcp": {
  "body": "```\n{\n  \"title\": \"x\"\n}\n```\n\nin `~/work/api-server`\n\n:::question\nClaude Code wants to use `create_issue` from linear\n\n- [ ] Allow once\n- [ ] Deny\n:::",
  "prompt": "Claude Code wants to use `create_issue` from linear",
  "choices": [
   "Allow once",
   "Deny"
  ],
  "askable": true,
  "read": {
   "detail": {
    "text": "{\n  \"title\": \"x\"\n}",
    "on": "block"
   },
   "preview": null,
   "leftover": null,
   "purpose": null,
   "folder": "~/work/api-server",
   "unsandboxed": false,
   "linksTo": null,
   "note": null,
   "handoff": null
  }
 },
 "spans": [
  {
   "text": "Allow `bun run` for this session",
   "spans": [
    {
     "text": "Allow ",
     "code": false
    },
    {
     "text": "bun run",
     "code": true
    },
    {
     "text": " for this session",
     "code": false
    }
   ]
  },
  {
   "text": "``echo `id` ``",
   "spans": [
    {
     "text": "echo `id` ",
     "code": true
    }
   ]
  },
  {
   "text": "a ` b",
   "spans": [
    {
     "text": "a ` b",
     "code": false
    }
   ]
  },
  {
   "text": "`` x`` y",
   "spans": [
    {
     "text": " x",
     "code": true
    },
    {
     "text": " y",
     "code": false
    }
   ]
  },
  {
   "text": "plain",
   "spans": [
    {
     "text": "plain",
     "code": false
    }
   ]
  }
 ]
}
"""#
}
