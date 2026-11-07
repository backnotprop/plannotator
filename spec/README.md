# The update and "What's new" lifecycle, as a state machine

`update-lifecycle.qnt` is a [Quint](https://quint-lang.org) model of how a
Plannotator install learns of a release, updates, restarts and shows "What's
new", written from the code on main (`35f9ad90d`). It covers one machine and
one data dir. The PR #2338 description lists what the model found and which
findings the real code reproduces.

The model is tied to the code in two ways:

- **Scripted runs** (`run …Test` in the spec): the minimal trace of each
  finding, replayed in the model.
- **A fast-check twin**, `packages/server/update-lifecycle.model.test.ts`: the
  same state and rules in TypeScript, driven next to the real code through the
  same actions. After every action, the real button, the real link and the
  requests GitHub saw must equal the model's.

## How to run it

```sh
# The scripted traces (each instance module separately)
quint test --main onMain      spec/update-lifecycle.qnt
quint test --main onFix       spec/update-lifecycle.qnt
quint test --main onWhatsNewFix spec/update-lifecycle.qnt
quint test --main onFixDraft  spec/update-lifecycle.qnt
quint test --main onWindows   spec/update-lifecycle.qnt
quint test --main onLocks     spec/update-lifecycle.qnt

# Random simulation: every property on every instance (about 5 minutes)
bash spec/simulate.sh
SAMPLES=50000 PROPERTIES="WhatsNewWithinRun" INSTANCES="onMain onFix" bash spec/simulate.sh

# Keep the traces of violations, and print one as plain steps
TRACES=/tmp/traces bash spec/simulate.sh
bun spec/show-trace.ts /tmp/traces/onMain-WhatsNewWithinRun.itf.json

# The model next to the real code (fast-check). Todo tests are the findings.
bun test packages/server/update-lifecycle.model.test.ts
bun test --todo packages/server/update-lifecycle.model.test.ts   # runs the findings (they fail on main)
PLANNOTATOR_MODEL_RUNS=500 bun test packages/server/update-lifecycle.model.test.ts
```

`simulate.sh` uses Quint's rust simulator (`BACKEND=typescript` uses the
slower one). On first use, Quint's rust backend downloads its evaluator from
Quint's GitHub releases into `~/.quint`. Nothing here runs `quint verify`. That needs Apalache, which this
work did not download.

## Instances

| Module | Code it stands for |
|---|---|
| `onMain` | main as of `35f9ad90d` |
| `onFix` | PR #2337: an empty "What's New" answer for a release under 2 days old is asked again after 15 min instead of 24 h |
| `onWhatsNewFix` | #2337 plus the F2-F4 fix (`WHATS_NEW_FIX`): a notes claim nobody answered is asked again after 15 min; a failure that may have been the network (no release check answered since the failure before) is asked again 15 min after it once a release check answers, once; `whatsNewPending` keeps "What's new" across Inbox starts until it was offered with readable notes |
| `onFixDraft` | #2337 plus its release.yml change: the draft is published with the written notes already in it |
| `onWindows` | main, with install.ps1's replace (move aside, then move in) and the Windows lock (the wrapper's pid, no past-the-hour hold) |
| `onLocks` | main (scripted lock traces only: F5 and F6 fixed) |

The lock rules in every instance are those of PR #2342: `launchInstaller` names the wrapper in the lock at the spawn, a lock whose installer still runs holds past the hour up to a day (POSIX), a lock that no longer holds is released and recorded as failed, and a wrapper releases only its own lock.

## Properties in plain words

Each property is an invariant that `quint run` checks in every state. The
"eventually" properties use bounds: once the bound has passed since their
precondition began, the outcome must hold.

| Property | Meaning |
|---|---|
| `NoTwoInstallers` | Two installs never run at the same time, unless the first has run past the lock's limit (a day on POSIX, the hour on Windows). |
| `BinaryAlwaysThere` | A kill at any step never leaves the install path without a complete binary. |
| `InboxCanStart` | An Inbox start (or Restart) always finds a binary to run. |
| `NothingFetchedWhileChecksOff` | With `PLANNOTATOR_UPDATE_CHECK` off, nothing automatic asks GitHub. Check now and Update now are the person's own requests, so they are allowed. |
| `RequestRateBounded` | No request loops. Automatic release checks are at least 1 minute apart. Requests for one release's notes are at least 15 minutes apart. |
| `StaleLockRecovered` | "Updating…" with no install alive never lasts an hour. |
| `PersonCanUpdate` | "Updating…" hides Update now and Try again, so it may show only while an install really runs. |
| `WhatsNewWithinRun` | **The 0.28.37 bug.** After an update, in the Inbox run that started on the new version, the "What's new" link shows within 30 minutes of the written notes. The precondition excludes the two other causes found: the network never failed, and no request for the notes was abandoned. |
| `WhatsNewAfterAbandonedRequest` | The same, when an Inbox quit while its request for the notes was in flight. |
| `WhatsNewAfterBlip` | The same, after the network was down and came back. On `onWhatsNewFix` this holds after one outage of any length. A network that drops again before the quick retry runs (it returned, a release check answered, then it went down again) still waits 6 h, today's back-off: trace `flappingNetworkWaitsTest`. |
| `WhatsNewAfterUpdate` | After an update, the link shows at least once, even when the Inbox restarts before the notes were readable. |
| `NewReleaseOffered` | A newer release is offered within 10 minutes plus one tick. |
| `NewReleaseOfferedAfterAbandonedCheck` | The same, counted from a release check that a process abandoned mid-request. |
| `FailedUpdateShown` | A failed install the person started shows as Failed, with the log and Try again. Excluded: an older install that ran past the lock's day beside the person's, and ended after it, overwrote `update-result.json` with its own version. |

Environment assumptions: CI writes the release notes within an hour of
publishing (`NOTES_LAG`). A request answers or times out before time moves on.
A spawned wrapper writes its lock line (its first command) before time moves
on, or is killed first.
The real Inbox ticks every minute; `advance` jumps 1 to 1440 minutes and
ends with one tick.

## State to code

| Model (`Sys` field or definition) | Code (main, `35f9ad90d`) |
|---|---|
| `published`, `body`, `pubAt` | GitHub: `releases/latest` redirect (`fetchLatestFromPage`, `packages/shared/update-check.ts:700`), `releases/tags/vX` (`fetchReleaseByTag`, `:787`) |
| `latest`, `latestAt` | `update-state.json` `latestRelease` (`update-check.ts:151`) |
| `rcAt`, `rcFailed`, `checkDue`, `releaseCheck` | `releaseCheck` (`:158`), `isReleaseCheckDue` (`:455`), `runReleaseCheck` (`:825`) |
| `notes` | `update-notes/<v>.json`, `writeReleaseNotes` (`:542`), "empty" = `!hasReleaseNotesContent` (`:573`) |
| `nf`, `notesDue`, `notesClaim`, `notesAnswered` | `notesFetch` (`:223`), `isNotesFetchDue` (`:1053`), `fetchReleaseNotesFor` (`:1082`, claim `:1101`, failure `:1113`, save `:1121`) |
| `nf[v].inFlight`, `nf[v].quick` | `notesFetch[v].inFlight`, `notesFetch[v].retryOnline` (`WHATS_NEW_FIX`) |
| `inboxVer` | `inboxVersion` (`:211`) |
| `wnPending` | `whatsNewPending` (`WHATS_NEW_FIX`) |
| `pendingV`, `pendingPerson` | `pending` (`:199`) |
| `resultV`, `resultCode` | `update-result.json`, `readAutoUpdateResult` (`packages/server/auto-update.ts:309`) |
| `lockHeld`, `lockKind`, `lockAt`, `lockOwner` | `update.lock`: the holder line `launchInstaller` writes at the spawn, then the POSIX wrapper's own (`POSIX_WRAPPER`) |
| `lockExpired`, `holderGone`, `liveLock`, `lockHeldView`, `canAcquire`, `reap` | `lockExpired`, `lockHolderGone` / `judgeLockHolder`, `lockHeld` (`isUpdateLockHeld`), `acquireUpdateLock`, `reapDeadUpdateLock` (`auto-update.ts`) |
| `autoLast`, `cliRun`, `autoAfterClaim` | `lastCheckAt`, `scheduleAutoUpdateCheck` (`:1077`), `runAutoUpdateCheck` (`:547`) |
| `launch` | `beginManualUpdate` (`:698`), `startManualUpdate` (`:742`), the launch in `runAutoUpdateCheck` (`:629-655`), `launchInstaller` (`:970`) |
| `inst[i].phase` | The detached wrapper and install script: lock line (`:792`), `update-prepare` download (`:816`), replace (`scripts/install.sh:1088-1099`; Windows `scripts/install.ps1:741-766`, `scripts/install.cmd:956-966`), `record` and `release_lock` (only its own lock), signal trap (`:806-814`) |
| `binOk`, `binV` | `~/.local/bin/plannotator` (`%LOCALAPPDATA%\plannotator\plannotator.exe`) |
| `ibAlive`, `ibRuns`, `startInbox` | `createInboxUpdates` (`packages/server/inbox-updates.ts:274`), `start()` (`:584`) |
| `ibUpdated` | `updated` (`:291`), set at start (`:296-313`) |
| `ibOnDisk` | `onDisk`, `probeBinary` (`:464`) |
| `ibInflight` | `notesInFlight`, `ensureNotes` (`:341`) |
| `fetchable` | `fetchableVersion` (`:334`) |
| `tick` | `tick` (`:488`); page load: `nudge` (`:598`) |
| `link` | `computeUpdatedLink` (`:385`) |
| `uiState` | `deriveInboxUpdate` (`:230`) through `compute` (`:418`) |
| `doUpdateNow` / `doCliUpdateNow` | `updateNow` (`:608`); `POST /api/update` (`auto-update.ts:1243`) and `plannotator update` |
| `doRestart` | `POST /api/inbox/restart` (`packages/server/inbox.ts:2608`), `onRestartRequested` (`apps/hook/server/inbox-command.ts:302`) |

Not modelled: the API fallback and the page's rate limit (rate-limit waits
only lengthen the bounds), snooze, release images, an unwritable state file,
the clock moving back, and the read-modify-write race on `update-state.json`
between processes. The PR #2338 description lists that race as a code-read
suspicion.

# Where a Claude Code session's Inbox messages land, as a state machine

`inbox-project.qnt` models one Claude Code session and one Inbox while the
agent moves between folders: a shell `cd`, Claude Code's own `/cd`, the mod's
bridge poll, a send with and without `project_path`, the person's New message
and a thread list. The folders are shaped like the workspace that showed the
bug: a plain folder (no `.git`) holding plain subfolders, a repository and its
subfolder, a linked worktree of that repository elsewhere, another repository
and a scratch folder.

```sh
quint test --main onMain         spec/inbox-project.qnt   # the bug's traces
quint test --main onFix          spec/inbox-project.qnt
quint test --main onFixStartOnly spec/inbox-project.qnt
bash spec/simulate-inbox-project.sh                       # every property, every instance (seconds)
bun test packages/server/inbox-project.model.test.ts      # the model next to the real code (fast-check)
```

| Module | Code it stands for |
|---|---|
| `onMain` | main before the fix: the mod files under `$.session.cwd()`; `read_thread`'s list makes a project |
| `onFix` | the fix: the mod files under `$.session.root()` (`InboxLink.projectFolder`), which only `/cd` moves |
| `onFixStartOnly` | the fix with `INBOX_PROJECT_FOLLOWS_SLASH_CD` off: the start folder, even after `/cd` |

| Property | Meaning | `onMain` | `onFix`, `onFixStartOnly` |
|---|---|---|---|
| `OneProjectPerSession` | A session's sends and New messages land in one project, its folder's, unless the agent names `project_path`. A shell `cd` never changes it. | violated | holds |
| `NewMessageAgreesWithSend` | A New message lands where the session's own send would at that moment. | violated | holds |
| `NoProjectFromCd` | Every project is the start folder's, a `/cd` target's or one the agent named. | violated | holds |
| `AttachmentsWhereAgentWorks` | Relative attachments resolve against the current working folder; a named `project_path` keeps them relative to it. | holds | holds |
| `ReadMakesNoProject` | A thread list never makes a project. | violated | holds |
| `NamedProjectHonoured` | A named `project_path` is the project. | holds | holds |

Known window: a New message in the second between a `/cd` and the next poll
lands where the session was (the poll is what tells the Inbox). The two
properties about New messages are stated for a session that polled since its
last `/cd`.

The fast-check twin (`packages/server/inbox-project.model.test.ts`) drives the
mod's real `InboxLink` (tool calls and the bridge poll) and a real Inbox over
real folders and repositories, and checks after every action that the Inbox's
projects, each message's project, its attachments' files and its `base_path`
equal the model's. With the mod's project folder put back to the cwd, it fails
at once (`cd top/repo/src`, `send`); with the Inbox ignoring the working
folder, it fails on the message's `base_path`.
