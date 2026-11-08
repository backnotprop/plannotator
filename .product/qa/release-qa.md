# Release QA list

Re-check these before every release tag. Each item says what to do, what "works" looks like, and how it is checked.

- **CI** means a job runs it on the bump commit (see `.agents/skills/release/SKILL.md`, Phase 4 step 2).
- **Local** means a script or test you run from a scratch worktree.
- **By hand** means a person does it on a real machine.

Run the release skill's own checklist too. This list does not repeat its version, notes and SBOM steps.

Safety for every local check: a scratch `HOME`, `PLANNOTATOR_DATA_DIR` and `TMPDIR` in the spawned process's env only, `NO_BROWSER=1`, `PLANNOTATOR_BROWSER=/usr/bin/true`, never port 59812, never the real `~/.plannotator`, and update tests only against a loopback mirror.

## 0. Gates (all must be green before tagging)

1. **CI is green on the bump commit.** Do: dispatch `inbox-e2e.yml`, `windows.yml`, `inbox-pi.yml`, `inbox-claude-code.yml`, `relay.yml` on main, as the release skill says. Works: every run on that commit succeeded, and the PR's Test workflow (unit, DOM) and Release workflow (`smoke-binaries`, `install-script-smoke`, `npm-package`, `release-security`) passed. Check: CI.
2. **Published-package floors did not move.** Works: no `engines`, `os`, `cpu`, `libc` or host peer changed on a published package without an owner-approved `ALLOWED` entry. Check: local, `bun test tests/published-package-floors.test.ts`.
3. **Sibling deps resolve on npm.** Check: local, `bun run check:sibling-deps @plannotator/opencode @plannotator/pi-extension` (it only reads npm).
4. **The Pi package holds every file it imports.** Do: `bun run build:pi`, then `cd apps/pi-extension && bun pm pack --dry-run`. Works: every relative import in a packed file resolves to a packed file, and `vendor.sh` copies every `../generated/*` module. Check: local.
5. **Checksum file names are unchanged.** Works: the release ships `plannotator-{darwin,linux}-{arm64,x64}.sha256` under exactly these names. Without its own `.sha256`, an installed 0.28.33+ cannot update. Check: CI (`update-prepare.test.ts` guards `candidateAssets`) and by hand on the GitHub Release page after tagging.
6. **install.sh / .ps1 / .cmd synced to plannotator.ai.** Do this when a script changed since the last tag. Works: `curl -fsSL https://plannotator.ai/install.sh | grep -c PLANNOTATOR_EXPECTED_SHA256` prints a number other than 0. Check: by hand (the owner syncs to S3).

## 1. Install

7. **Fresh install, macOS and Linux (`install.sh`).** Do: run the install script into an empty scratch HOME. Works: the binary lands in `~/.local/bin/plannotator`, `--version` prints the new version, and "SHA256 verified" appears. Check: CI `install-script-smoke` (Linux, with the Codex hook config) and `smoke-binaries`. Locally, run the real `scripts/install.sh` with a curl shim that sends GitHub release URLs to a loopback mirror and refuses every other URL. By hand: one real `curl -fsSL https://plannotator.ai/install.sh | bash` after the release is live.
8. **Fresh install, Windows (`install.ps1`, `install.cmd`).** Works: the binary installs and runs, and uninstall works. Check: CI `smoke-binaries (windows-latest)`, `windows.yml`, `scripts/install.test.ts`. By hand: one real install on Windows after the release is live.
9. **npm packages.** Works: `@plannotator/opencode`, `@plannotator/pi-extension`, `@plannotator/dsh` and `@plannotator/cline` publish at the new version, with provenance. Check: CI `npm-package` / `npm-publish`, then `npm view <pkg> version`.
10. **Pi and OpenCode plugin installs.** Do: `pi install npm:@plannotator/pi-extension`, and add `@plannotator/opencode@latest` to opencode.json. Works: the plan review and `plannotator_inbox` tools load in a new session. Check: by hand (real agent CLIs). CI covers the package contents (`inbox-pi.yml`, `pi-extension-ai-runtime-windows`).

## 2. Update: nobody gets stuck

11. **`plannotator update` from the previous release.** Do: install the published previous binary as `~/.local/bin/plannotator` in a scratch HOME, then run `plannotator update` against a loopback mirror (`PLANNOTATOR_UPDATE_API_URL`, `PLANNOTATOR_INSTALL_SCRIPT_URL`, `PLANNOTATOR_RELEASE_DOWNLOAD_URL`). Works: "Checksum matches the one Plannotator fetched", "Updated to X", `--version` shows X, and no `update.lock` or `plannotator-update-*` folder is left behind. Check: local. CI runs `scripts/smoke-update-prepare.sh` on every built binary.
12. **A failed update never strands anyone.** Do: repeat item 11 with each failure: the mirror 404s the native `.sha256`, it serves a wrong checksum, it 404s the binary, it 404s `install.sh`, or the mirror is down. Works: the update exits non-zero with a plain message ("nothing was changed", "still installed and works", the retry command). The old binary is untouched (same SHA-256), no lock is left, and running `plannotator update` again after the mirror is fixed succeeds. Check: local. Unit tests: `update-prepare.test.ts`, `auto-update-stuck.test.ts`, `update-command-stuck.test.ts`, `update-check-stuck.test.ts`.
13. **Inbox Update button.** Do: run the Inbox as the install-script-managed copy with update checks pointed at a loopback mirror that offers a newer version. Works: the sidebar shows "Update to X". When the update fails, the button shows "Update failed", and its dialog says nothing changed and offers the log, the install command and **Try Again**. Try Again installs. The Inbox restarts itself onto X (new pid, same env), and the page shows "What's new in X". Check: local (screenshots). CI `inbox-updates.spec.ts`, `inbox-update-notice.spec.ts`, `inbox-updates-stuck.test.ts`, `updateStuck.test.tsx`.
14. **Auto-reload after an update.** Do: with an Inbox running, update the Claude Code plugin under a live session. Then update the Pi extension under a live Pi. Works: Claude Code runs `/reload-plugins plannotator` by itself once the session is idle. Pi reloads itself, and the new version answers. When the reload does not take, the manual notice stays and nothing loops. Check: by hand (real agents). Unit tests: `apps/hook/hooks/mod/auto-reload.test.ts`, `auto-reload-register.test.ts`, `packages/server/inbox-auto-reload.test.ts`, `apps/pi-extension/auto-reload.test.ts`. CI: `inbox-claude-code.yml`, `inbox-pi.yml`.
15. **The version notice keeps offering a missed update.** Works: after a failed install, the Inbox and the plan review update toast still offer the version. After update checks fail for 3 h, Settings → About says so and names the command that always works. Check: CI `inbox-updates-stuck.test.ts`, `update-advert.test.ts`, `MenuVersionSection.test.tsx`. Locally: `GET /api/inbox/update` shows `state: "failed"` with the version still offered.

## 3. Old app (plan review, code review, annotate)

16. **Plan review via the hook: approve.** Do: pipe a `PermissionRequest` / `ExitPlanMode` JSON to the binary, then approve in the page (or `POST /api/approve`). Works: stdout is `decision.behavior: "allow"`, and the plan is saved under `plans/…-approved.md`. Check: local over HTTP. By hand: one real Claude Code plan in the browser.
17. **Plan review: request changes.** Do: deny with feedback. Works: `behavior: "deny"`, and the message carries the feedback. Check: local over HTTP. By hand in Claude Code.
18. **Code review (`plannotator review`).** Do: run it in a git repo with a change, then send feedback. Works: `/api/diff` holds the change, the page loads, and the feedback prints on stdout. Check: CI `smoke-binaries` (`/api/diff`) and local over HTTP.
19. **Annotate a file, a folder and a URL.** Works: each opens (`mode` `annotate`, `annotate-folder`, and `annotate-app` for a loopback or live app), and the feedback prints on stdout. Check: CI `smoke-binaries` (annotate README) and local. By hand: a public `https://` URL, which needs the network.
20. **Last message (`plannotator last`).** Works: `--stdin` opens the message, and the feedback prints. By hand: `/plannotator-last` in a real Claude Code session, which reads the transcript. Check: local (`--stdin`) and by hand.
21. **Share links.** Do: Share from plan review, then open the link in a private window. Works: the plan and annotations come back the same, and the short link resolves. Check: by hand (needs the network).
22. **Archive.** Do: `plannotator archive` after a few decisions. Works: `/api/archive/plans` lists them, newest first, with approved/denied. Check: local.

## 4. Inbox

23. **Open.** Do: `plannotator inbox`. Works: the window loads, a first run shows the tour or connect screen, and no "Inbox updated" banner appears on a fresh load. Check: local (screenshots), CI `inbox-e2e.yml`.
24. **An agent's message arrives.** Do: `plannotator inbox call send_message` and the stdio MCP (`plannotator inbox mcp`, `tools/call send_message`). Works: the thread shows at once under its project. Check: local.
25. **A question answered reaches the agent.** Do: answer a `:::question` in the window and Send. Then, as the agent, `read_thread`. Works: the question reads `state: "sent"` with the answer, and the person's reply holds "Answer: …". By hand: the live wake into a running Claude Code / Pi session. Check: local, plus by hand for the wake.
26. **New message.** Works: compose opens. With no agent running, it says so and offers a draft. With Launch available, "New Claude Code session" / "New Pi session" show in To. Check: local (screenshot). CI `inbox-new-message.spec.ts`, `inbox-compose*.spec.ts`.
27. **Start an agent (Launch, on by default).** Works: Settings → Agents shows "Start agents from New message" on. Sending to a new Claude Code session starts `claude --bg`, and the thread shows Starting → Working. Check: by hand (real Claude Code). CI `inbox-launch-*.spec.ts`.
28. **Settings.** Works: every section opens (General, Rows, Agents, Prompts, Devices, Machines, Accounts, Voice, Capabilities, Archived, Storage, Decision data, About), and About shows the version and update state. Check: local, CI `inbox-settings.spec.ts`.
29. **Held features stay hidden (until 0.29).** Works: Settings → Capabilities has no Code review, Shape or System row. `/api/inbox/settings` has no `code_review`, `shape` or `system` key. `/api/inbox/reviews` and `/api/inbox/pulls` answer 409 `code_review_off`, and `/api/inbox/system/setup` answers 409 `system_off`. `?system-setup` opens nothing. Check: local (`heldSwitch` / `switchesHeld` in `packages/server/inbox.ts`).
30. **Phone layout.** Do: open at 390×844 (or on a real phone over the tailnet). Works: the list and a thread fit with no sideways scroll, and the answer summary reads. Check: local (screenshot), CI `inbox-phone*.spec.ts`, by hand on a real phone.
