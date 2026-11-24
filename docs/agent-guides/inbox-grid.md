## Inbox: Grid (experimental)

Grid is one page of all the agents' work (owner approval "inbox-agent-grid", round 3). It shows this computer's work and the work of every linked computer. The work is grouped Needs you, Moving, Not moving, Landed, Not started and Dropped. The page starts with a line of plain counts and a "Since" line. Each line shows the work's name and PR number, its agent, a bar of its life on the page's clock, and the bar in words ("Working 2 h › PR 40 min › Needs you 32 min"). An open question sits under the name in amber.

**The switch.** Experimental, off by default: Settings → Capabilities → Experimental → Grid. It is config.json `experimental.grid` and `PLANNOTATOR_EXPERIMENTAL` name `grid` (see `environment.md`). `POST /api/inbox/settings` takes `{ experimental: { grid } }`, alone or with `decision_mode`. While the variable decides, the save answers `409 experimental_env_decides`. When the switch is off, nothing of Grid runs: no sidebar row, no read, no timer. A `#grid` address goes to the Inbox (`GridRoute`). When it is on, the sidebar's Grid row sits under Inbox (core `inbox-sidebar.ts`, hideable).

**Where the code is.**
- `packages/shared/inbox/grid.ts` holds the rules. It is pure and reads nothing: `gridPlace` puts one thread in its group, and `gridModel` builds the page: groups, counts, Since, Earlier and the clock's span. `gridSaid` gives the bar's words. Unit tests are in `grid.test.ts`.
- `packages/inbox/grid/gridInput.ts` turns the window's list rows and agents into `GridThreadIn` (pure).
- `gridPulls.ts` reads the PRs.
- `gridLook.ts` keeps the last look.
- `GridPage.tsx` and `GridLine.tsx` draw the page and its lines; `grid.css` styles them.
- The DOM test is `gridPage.test.tsx`.

**Data. Only what the window already has.**
- A piece of work is a list row whose author is an agent. The list is the merged list, so a linked computer's rows and agents come the same way as local ones; the readout names the computer.
- The agent's state and its terminal permission or question mark come from the agents list (`useInboxAgents`).
- The only reads are `GET threads/:id/pulls`, for each row whose list summary (`pulls`) names a PR. Two reads run at a time, each thread is read once, and a thread is read again when its summary changes or `threadPullsBus` names it. Reads stop while the tab is hidden. The route needs no Code review and is already forwarded for linked threads, so no door entry was added.
- Steps are not used: a linked computer's steps are not forwarded.
- Time marks:
  - The PR piece starts at the PR's `added_at`.
  - "Merged" and "closed" are at the PR's `read_at` (when the Inbox saw that state). This is close to the real time, not exact.
  - "Needs you" starts at the row's `waiting_since`.
  - A permission prompt in a terminal has no words or time on the wire. Its line says "Asks for permission in its terminal" and starts at the last movement.

**The decay rules** (`gridPlace`):
- Open work stays: Moving, or Not moving after 20 quiet minutes, or Not started (a message was sent and not yet checked, and the agent has never answered).
- Work that needs the person never leaves because of age.
- Landed (headline PR merged) stays for at least 3 h, and until Grid was looked at after it landed. If nobody looks for more than 12 h, it becomes only a count in the Since line. Once seen and older than 3 h, it moves to Earlier.
- Dropped means: a PR closed without a merge, open work whose agent ended, or open work quiet for 3 days. It stays for at least 3 h and until seen, then moves to Earlier.
- Earlier keeps work for 7 days. It is made again from the rows each time; nothing is stored.
- A row with no open work (a talk that is done) is not on the page.
- The last look is kept in this browser (the window's storage, `plannotator-inbox-grid-look`), so a phone and a computer each keep their own look.

**Cost.** Nothing in a line measures. The bar's pieces are positioned by percentage, and the readout is a CSS `:hover` / `:focus-within` child (on a phone, a tap opens it, with Open thread). The model is computed again when:
- the list or the agents change;
- a PR read lands;
- the minute ticks (once a minute, only while the tab shows).

**Round 4 (not built).** Stale is one more `GridGroup` in `GRID_GROUPS` and one more branch in `gridPlace`. Nudge is one more `GridAction` kind on `GridLine.actions`, drawn in the readout beside Open thread.
