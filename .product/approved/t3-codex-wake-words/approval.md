# T3 Code: say that Codex threads wake too

- Approved: 2026-11-26 by the owner, in the Inbox thread "Hosts and launchers".
- Artifact: the Before / After list of 18 items, read from `origin/main` at dcb4df2278.

## The owner's words
- "Yes, all 16 as drafted in the file"

## Approved state
Each After went in character for character. Item 5 (`reference/inbox.md`, Claude Code section) was "no change".

1. `packages/t3-code/usage.ts:24-25` (`plannotator t3 --help`): "Claude threads in T3 wake. Codex threads wake too when T3 runs on this computer (not on Windows). ..."
2. `apps/marketing/src/content/docs/getting-started/installation.md:378` (T3 Code section, last sentence).
3. `apps/marketing/src/content/docs/reference/inbox.md:540` (what does not wake).
4. `apps/marketing/src/content/docs/reference/inbox.md:541` (the T3 Code bullet, one sentence added at the end).
6. `README.md:262` (integrations table, T3 Code row).
7. `apps/skills/core/plannotator/SKILL.md:206` (the plannotator skill, `plannotator t3`).
8. `apps/hook/server/inbox-help.ts:452` (`plannotator inbox --help`, "Connecting yourself").
9. `apps/hook/server/inbox-help.ts:483` (`plannotator inbox --help`, "Where replies go").
10. `apps/marketing/src/lib/inbox-prompt.md:91` (`/inbox/prompt.md`, step 6).
11. `apps/marketing/src/lib/inbox-agents.ts:1000` (T3 Code agent page, lede).
12. `apps/marketing/src/lib/inbox-agents.ts:1001` (comparison line).
13. `apps/marketing/src/lib/inbox-agents.ts:1011` ("Your reply" label).
14. `apps/marketing/src/lib/inbox-agents.ts:1012` ("Your reply" detail, last sentence).
15. `apps/marketing/src/lib/inbox-agents.ts:1089` (troubleshooting row).
16. `apps/marketing/src/lib/inbox-agents.ts:1098` (limits).
17. `apps/marketing/src/lib/inbox-agents.ts:1092` ("Waiting for T3 Code" fix).

Item 18, `packages/t3-code/README.md:7` (developer notes), was optional. Its After adds only the same correction (a Codex thread on the same computer needs no sign-in), so it went in too.

## Out of scope (left as they are)
- The sign-in sentences for Claude threads on the same computer (installation.md:372, reference/inbox.md:541, inbox-agents.ts:1012, :1053, :1092, the setup order in `t3 --help`). A separate fix.
- The Settings → Agents row for T3 (shared UI words, the owner's decision).
