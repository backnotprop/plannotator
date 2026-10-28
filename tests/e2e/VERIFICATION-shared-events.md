# Verification: Inbox tabs share one event connection

What changed: every Inbox tab of one browser origin shares ONE event stream
(`packages/inbox/sharedEvents.ts`). A Web Locks leader holds the EventSource
and passes each frame on over a BroadcastChannel; followers only listen. See
"One event stream per browser" in
docs/agent-guides/inbox-notifications-and-agents.md.

All runs: macOS, the compiled binary built from this branch
(`.local/plannotator`), scratch data dirs under the OS temp dir (never `/tmp`,
never `~/.plannotator`), `PLANNOTATOR_INBOX_CONNECT=0`, `NO_BROWSER`,
headless browsers, notifications fully stubbed (no OS notification), the sound
counted (never played). "Streams" is the server's own count of open event
streams (`event_streams` on `/api/inbox/health`), less the test's reference
stream.

How a tab is checked: each tab logs the records it handled
(`window.__plannotatorInboxEventLog`). The ground truth is a reference stream
the test holds from the start. "Exact" means the tab handled exactly the
reference's lines after its subscribe cursor, once each, in order.

## Browser proofs (Playwright, real tabs in one browser context)

| Case | Browser | Result |
| --- | --- | --- |
| 1 tab | Chromium | 1 stream, exact, notify_reach windows 1 |
| 3 tabs | Chromium, WebKit | 1 stream, every tab exact, windows 3 |
| 8 tabs | Chromium, WebKit | 1 stream, every tab exact, windows 8 |
| 12 tabs | Chromium | 1 stream, every tab exact, windows 12; tab loads 440-495 ms each |
| Old build (origin/main), 7th tab | Chromium | 6 tabs load (~460 ms); the 7th does not load in 8 s; closing one tab lets it load in 534 ms: the six-connection limit |
| New build, 9th tab with 8 open | Chromium / WebKit | loads in 467 ms / under 3 s, 1 stream |
| Leader closes while an agent writes (~48 messages) | Chromium, WebKit | another tab leads 1 ms after (Chromium); under 1 s (WebKit); every tab exact; 1 stream |
| Leader reloads while an agent writes | Chromium, WebKit | another leads in 8 ms; every tab (the reloaded one from its new cursor) exact; 1 stream |
| Leader crashes (`Page.crash`, no unload) while an agent writes | Chromium | another leads in 2 ms; every tab exact; 1 stream |
| Leader frozen (`freeze`, main thread held, `resume`) while an agent writes | Chromium | another leads in 217 ms; the frozen tab catches up on resume; every tab exact; 1 stream |
| Leader stalled (debugger holds its main thread 8 s, NO freeze event) while an agent writes, one follower in front | Chromium | the front tab took the lock (`steal`) 3.4 s in; its longest gap without a record 3.2 s; 2 streams at most (77 samples); the old leader learned it lost the lock 8.0 s in (when it ran again), closed its stream and followed (9 ms later); every tab exact (4/4); 1 stream after |
| Leader stalled by a looping script in an attached HTML page (sandboxed srcdoc frame, 8 s), one follower in front | WebKit | the front tab led 3.8 s in; longest gap 3.7 s; 2 streams at most; the old leader learned 8.1 s in and followed; every tab exact (3/3) |
| Every case above, the tab in front | Chromium | longest gap without a record: close 48 ms, reload 47 ms, crash 46 ms, freeze 235 ms |
| Notifications, 4 tabs all in the background | Chromium | 1 notice and 1 ring in total |
| A follower in front, the leader in the background | Chromium | 1 notice, raised by the front tab; 0 rings |
| A question in the thread the front tab has open | Chromium | 0 notices, 0 rings |
| notify_reach: follower closes / crashes / leader closes / tab opens | Chromium | 4→3 in 1 ms, 3→2 in 27 ms (crash: the leader saw its lock freed), 2→1 in 1 ms, held at 1 for 17 s (past the grace), 1→2 in 26 ms |
| notify_reach: follower closes, leader closes | WebKit | each step within the timeout (see results-webkit.json) |
| Inbox restart (stopped, started on the same port) | Chromium | 1 stream again 1.2 s after start; windows 4; every tab exact |
| Two origins (`localhost` and `inbox-second.localhost`, standing in for the tailnet address) | Chromium | 2 streams, one leader per origin, every tab exact |
| No Web Locks (removed by an init script) | Chromium, WebKit | each tab its own stream (3 streams for 3 tabs), as before |
| Soak: 5 minutes, tabs opening, closing, reloading and crashing at random (87 opens, 51 closes, 48 reloads, 34 crashes) while an agent wrote 5,577 messages | Chromium | streams never above 1 in 231 samples; every surviving tab exact; every leaving tab in order and never twice |
| Soak, second run on the final build: 4 minutes (68 opens, 40 closes, 35 reloads, 27 crashes), 4,501 messages | Chromium | streams never above 1 in 179 samples; 4/4 surviving tabs exact; all 102 tabs that left were in order and never twice |
| Soak, after the review fixes: 4.5 minutes (41 opens, 24 closes, 51 reloads, 19 crashes, 17 tabs brought to the front, 7 leaders stalled 3-9 s by the debugger, all 7 taken over), 4,996 messages | Chromium | outside stalls streams never above 1 in 176 samples; during stalls never above 2 in 179 samples; the surviving tab exact; all 94 tabs that left were in order and never twice |
| `GET /api/inbox/events` from another site | server | `Sec-Fetch-Site` cross-site / same-site, a foreign Origin and `Origin: null`: 403 `cross_origin`, not counted; same-origin, `none`, no metadata (the phone's door, agents) and the page's own Origin: 200 |
| Page errors | both | none |

Final run after the review fixes, repeated on the head that merges origin/main
(Chromium 14 tests in 6.4 min with a 4.5-minute soak, WebKit 7 in 37 s, both
times all passing; numbers from the first, the second within a few ms: stall
3.38 s / gap 3.17 s, WebKit stall 3.78 s / 3.71 s, soak 5,050 messages with 7
of 7 stalls taken over, streams never above 1 outside stalls, never above 2
during): takeovers 1 ms (close), 8 ms (reload),
2 ms (crash), 223 ms (freeze), 3.4 s (stall), 12 ms (WebKit close), 3.8 s
(WebKit stall); the old build (origin/main) stalled the seventh tab 8 s and
loaded it 533 ms after one tab closed, the new build loaded a ninth in 459 ms;
the Inbox restart reconnected in 1.2 s; notify_reach steps 0/27/0/28 ms.

## Second review

- A tab that came to lead while its catch-up ran, the catch-up then failing,
  used to hold every frame of its own stream for good (the reviewer's probe:
  0 of 5 records 3 s later). It now clears what it holds and handles its
  stream. The unit test `a tab that comes to lead while its catch-up runs…`
  fails on the previous code and passes now; the random stress with stopping
  leaders now also fails catch-ups (some at the end of a slow answer) and
  fails on the previous code too.
- CI (GitHub's Linux runner): the crashed leader was taken over in 2.6 s
  against a 1 s bound (2-3 ms on macOS). A crashed tab's lock is freed when the
  browser notices the renderer died, which on Linux takes about 3 s: the next
  CI run recorded the takeover as `queue` (the lock came in line, not by a
  steal) 3.0 s after the crash, and a crashed follower stopped counting 3.3 s
  after (other cases on that runner: close 3 ms, reload 23 ms, freeze 567 ms,
  stall 3.6 s by `steal`, WebKit stall 5.1 s, every tab exact). The crash case's bound is now the stalled-leader
  takeover (7 s: the check every 3 s, no answer in 2 s, room for a slow
  runner), two streams allowed for a moment, and each takeover records how it
  came (`queue` or `steal`; locally every case but the stall is `queue`). The
  freeze bound is 2 s, and the follower-crash step of the reach proof 8 s.
- `inbox-shared-windows.test.ts` "after the whole browser goes…" waited for
  the count, not for the notice (the expiry timer fires 1 ms past the grace):
  it now waits for the notice, 20 of 20 runs passing.
- Rerun on the head that merges origin/main again: unit 26 pass, server
  `packages/server/inbox*` 689 pass (694 tests), DOM 564 pass, shared-events
  e2e Chromium 12 pass (the old-build proof and the soak skipped: no baseline
  binary or soak time set) and WebKit 7 pass.

## Unit and server tests

| Test | Result |
| --- | --- |
| `packages/inbox/sharedEvents.test.ts` (fakes for Web Locks with `steal`, BroadcastChannel, the server's stream, and a paused tab whose main thread runs nothing): 1/3/12 tabs, cursor skip, served_by, all frame kinds, leader close/crash during writes, follower gone (crash and close), freeze/resume, back/forward cache, a sleeping follower behind a new leader, a late subscriber, a failed catch-up retried at the next hello, a stopped leader taken over by a visible follower and following when it runs again, a leader that answers never taken over, hidden followers at the hidden pace, a failed catch-up keeping its gap (the reviewer's [3,4] probe now gives [1,2,3,4]), the early channel closed when no subscription follows, junk messages, unsubscribe, 40 seeded random lives of up to 12 tabs, 30 seeded random lives with leaders stopping and tabs shown and hidden (at most 2 streams, every record once) | 25 pass; the 4 new review tests fail on the previous code |
| `packages/server/inbox-shared-windows.test.ts`: served_by, gone, the grace through a handover, two tabs naming each other never counted, one link further never counted, the whole browser gone (followers stop counting one grace after the leader's stream, and the pages hear it), event_streams, once=1, the cross-site refusal | 7 pass |
| `packages/server/inbox*.test.ts` (tailnet, door included) | 685 pass, 0 fail (690 tests, on the merged head) |
| `packages/inbox` DOM tests (`DOM_TESTS=1 --isolate`), which run the fallback path (happy-dom has no Web Locks) | 562 pass (merged head) |
| Typecheck (`bun run typecheck`) | clean |
| Existing e2e specs that read the event stream (Chromium, compiled binary): `notifications`, `inbox-sound`, `inbox`, `inbox-reply-drafts`, `inbox-send-now`, `inbox-open-stays-put`, `inbox-seen-on-sight`, `inbox-restart`, `inbox-updates`, and main's new `inbox-picks-composing`, `inbox-refresh` | 74 pass, 1 skipped (as on main) |

## Not verified

- A real Chrome freeze (Energy Saver). Headless pages are always visible, so
  `Page.setWebLifecycleState` does nothing; the proof plays the same sequence
  (`freeze`, the main thread held, `resume`).
- A leader that never runs again (an endless loop): the others take over at
  once (they do not need it to run), but its tab keeps its stream open on the
  server until the browser kills it; 2 streams meanwhile.
- With every tab hidden, the hidden pace (15 s) is what the browser allows:
  Chrome throttles a long-hidden tab's timers to once a minute, Safari
  suspends background tabs; measured in fakes only, not in a browser.
- iOS Safari's own suspension of a background leader (inferred by the
  reviewer): covered by the same check, not run on a device.
- Firefox, and Safari itself (WebKit through Playwright only).
- The tailnet address itself (another origin, stood in for by a second
  loopback name).
- Mixed tabs of an older and a newer Inbox build on one origin (an older tab
  keeps its own stream; not run).
