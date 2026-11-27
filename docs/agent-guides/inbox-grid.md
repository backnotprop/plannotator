## Inbox: Grid (experimental)

Grid is one page of all the agents' work (owner approval "inbox-agent-grid", round 3). It shows this computer's work and the work of every linked computer. The work is grouped Needs you, Moving, Not moving, Landed, Not started and Dropped. The page starts with a line of plain counts and a "Since" line. Each line shows the work's name and PR number, its agent, a bar of its life on the page's clock, and the bar in words ("Working 2 h › PR 40 min › Needs you 32 min"). An open question sits under the name in amber.

**The switch.** Experimental, off by default: Settings → Capabilities → Experimental → Grid. It is config.json `experimental.grid` and `PLANNOTATOR_EXPERIMENTAL` name `grid` (see `environment.md`). `POST /api/inbox/settings` takes `{ experimental: { grid } }` (an older window may add `decision_mode` there, which saves Decision mode's own switch, kept one release). While the variable decides, the save answers `409 experimental_env_decides`. When the switch is off, nothing of Grid runs or is written: no sidebar row, no read, no look, no timer. A `#grid` address goes to the Inbox (`GridRoute`). A sidebar save while it is off never writes `grid`: the server leaves it out of config.json `inboxSidebar` (`inboxSidebarOff`, `inbox-sidebar-save.ts`) and the window leaves it out of the cookie (`setSidebarUnsaved`, `sidebarLayout.ts`), as for an off Plans. When it is on, the sidebar's Grid row sits under Inbox (core `inbox-sidebar.ts`, hideable).

**Where the code is.**
- `packages/shared/inbox/grid.ts` holds the rules. It is pure and reads nothing: `gridPlace` puts one thread in its group, and `createGridModel` builds the page (groups, counts, Since, the lines only counted, Earlier and the clock's span), kept between reads. `gridSaid` gives the bar's words, `gridLandedWord` Landed's word, `gridHourTicks` the clock's local hours. Unit tests are in `grid.test.ts`.
- `packages/inbox/grid/gridInput.ts` turns the window's list rows and agents into `GridThreadIn` (pure).
- `gridSeen.ts` sends the looks; `gridOn.ts` holds the switch and the list reads Grid's events ask for.
- `GridPage.tsx` and `GridLine.tsx` draw the page and its lines; `grid.css` styles them.
- Server: `inbox-grid-seen.ts` (the looks), `inbox-grid-row.ts` (what a row carries for Grid).
- Tests: `gridPage.test.tsx` (DOM), `packages/server/inbox-grid-seen.test.ts`.

**One line per piece of work.** A piece of work is a list row with an agent. A PR put on two threads is the work of the thread it was put on first (then the lower thread id): one line, counted once. A thread with several PRs is one line over all of them: open while any is open; Landed when none is open and one merged (at the last end); Dropped "PR closed" when all closed.

**Off adds nothing.** Grid's fields (`now`, `grid_seen`, `steps_progress`, `pulls.items`) are on a list answer only for a read that asks `grid=1`: the window asks only while Grid is on and its page shows (`listRead.ts` `setListGrid`, from `gridOn.ts`), a linked machine only while Grid is on there (inbox-peer-link.ts `gridOn`). A server with Grid off ignores a window's `grid=1`, strips them from linked rows for a read that did not ask (`gridRowStripped`), shows no `clock_ms`, and sends no `grid-seen` to its windows; its links ask for no `grid-seen`. Turning Grid on or off redials each link quietly (`gridChanged`). Guarded by `packages/server/inbox-grid-off.test.ts`.

**Data. Only what the list already carries; Grid reads nothing of its own.**
- The list is the merged list, so a linked computer's rows, agents (with their `status_mark`), `run`, PRs, checklists and looks come the same way as local ones; the readout names the computer.
- The row's PR summary carries every PR (`pulls.items`: `added_at`, `read_at`, `checks`, `review`), from the store and the thread-PR states the list read already refreshes. A `thread-pulls` event (checks or review changed) reads the list again only while Grid shows, once per burst (`gridHeard`).
- `steps_progress` on a row: the latest checklist's done, counted, the step in progress and its last change, while that computer's Checklist switch is on. A step's change is movement; the readout says "Steps 2 of 5" and the step in progress.
- Clocks: the list answers with its `now`; a linked machine reads how far apart the two clocks run (`clock_ms` on its `machines` entry, whole minutes, absent within two minutes). Grid takes it off every time of that computer's rows, so a clock that is off does not make work look quiet.
- Time marks:
  - The PR piece starts at the first PR's `added_at`.
  - "Merged" and "closed" are at the PR's `read_at` (when the Inbox saw that state). This is close to the real time, not exact.
  - "Needs you" starts at the row's `waiting_since`.
  - A permission prompt in a terminal has no words or time on the wire. Its line says "Asks for permission in its terminal" and starts at the last movement.
- A closed PR is read again at most every 10 minutes for a week after it closed (`inbox-thread-pulls.ts`), so a reopened PR comes back. Merged is never read again.

**Seen.** A line counts as seen only once at least half of it was on screen in a tab that shows (an IntersectionObserver; no layout read). A line behind "N more" or a closed Earlier is not drawn, so not seen; the landed lines only counted in the Since line are seen when that line is. The look is kept with the thread on its own computer: `POST /api/inbox/grid/seen` `{ seen: [{ thread, through, at }] }` (`through`: the line's last landing or drop shown; `at`: when; each keeps its larger value; ahead of the clock is now), in `inbox/grid-seen.json`, kept while this Inbox holds the thread (never dropped for age or count). A linked computer's window sends it through the forward (outbox `set`), a phone through the door; `event: grid-seen` makes windows and linked machines read the list again (a reread event, `PEER_REREAD_EVENTS`). Rows carry it as `grid_seen`. A sitting compares with the looks it found when it began, so bold stays bold while the person reads; a sitting begins when the page opens or the tab shows after 5 minutes away.

**The decay rules** (`gridPlace`):
- Open work stays: Moving, then Not moving after 20 quiet minutes. Not started is a message sent and not yet checked, the agent never having answered.
- Work that needs the person never leaves because of age.
- Landed stays for at least 3 h and until its line is seen. Unseen for more than 12 h it is only a count in the Since line, until that line is seen. Once seen and older than 3 h, it moves to Earlier.
- Nothing else leaves without Dropped: all its PRs closed, its agent ended, or 3 days with no movement. Dropped stays for at least 3 h and until seen, however long; then Earlier.
- Earlier keeps work for 7 days after it was seen (and its 3 h). It is made again from the rows each time.
- An end older than 7 days that no look ever showed happened before Grid could show it: not drawn.

**Cost.** Nothing in a line measures. The bar's pieces are positioned by percentage, and the readout is a CSS `:hover` / `:focus-within` child (on a phone, a tap opens it, with Open thread). Its rows share one set of columns (CSS subgrid, `max-content`), so the time ("Tue 10:09 AM" or a longer locale's), the state and the detail line up and never overlap: no fixed column width. A thread's place is worked out again only when what Grid reads of it changed (compared field by field, `gridSameIn`; no JSON) or the clock reached its next mark (`gridPlaceTimed`'s `until`: the next minute for a bar that runs to now, else 3 h, 12 h, 3 days or a week); otherwise its line keeps its object, so its memoized drawing holds. A list read is O(n) to compare plus the changed threads to place, and O(n log n) to sort; the minute tick places again only the open lines.

**Screen readers.** A line's name says its group and its bar in words ("Pagination cursors. Needs you. Working 1.5 hours, Needs you 32 minutes. Keep the old page param?"); the readout, with the times, describes it. The bar is hidden from them.

**Round 4 (not built).** Stale is one more `GridGroup` in `GRID_GROUPS` and one more branch in `gridPlace`. Nudge is one more `GridAction` kind on `GridLine.actions`, drawn in the readout beside Open thread.
