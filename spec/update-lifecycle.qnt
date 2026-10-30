// -*- mode: Bluespec; -*-
/**
 * Plannotator's update and "What's new" lifecycle, as the code on main does it.
 *
 * One machine, one data dir. Actors: the GitHub release, the Inbox process
 * (start, restart, ticks, page loads, crash), a CLI session (the release check
 * and opt-in auto-update on session start, a review window's Update), the
 * person (Update now, Restart, Check now, the update-check switch), the
 * installers (the detached wrapper and install.sh / install.ps1), the network,
 * and a kill at any step.
 *
 * Time is in minutes. A step that lets time pass (`advance`) ends with one
 * Inbox health tick; the real Inbox ticks every minute, so a jump of d minutes
 * stands for d quiet ticks followed by the one that sees the new time.
 *
 * Every definition names the code it mirrors (file:line on main, 35f9ad90d).
 * spec/README.md maps the state to the code and explains each property.
 *
 * Four switches:
 *   NOTES_FIX   PR #2337: an empty "What's New" answer for a release under
 *               2 days old is asked again after 15 minutes, not 24 hours.
 *   WHATS_NEW_FIX  F2-F4: a claim nobody answered is asked again after 15
 *               minutes; a failure that may have been the network is asked
 *               again 15 minutes after it once a release check answers; a
 *               start on the version whose link was not yet offered with
 *               readable notes (whatsNewPending) shows it again.
 *   DRAFT_FLOW  PR #2337's release.yml: the release is created as a draft,
 *               its notes written, then published, so GitHub's generated body
 *               is never public.
 *   WINDOWS     install.ps1's replace (move aside, then move in) and the
 *               Windows lock (no holder line, the hour's rule only).
 */
module updateLifecycle {
  const NOTES_FIX: bool
  const DRAFT_FLOW: bool
  const WINDOWS: bool
  const WHATS_NEW_FIX: bool

  pure val VERSIONS = 1.to(3)
  pure val IDS = 1.to(3)

  // packages/shared/update-check.ts:34-38
  pure val CHECK_INTERVAL = 10       // RELEASE_CHECK_INTERVAL_MS
  pure val CHECK_RETRY = 10          // RELEASE_CHECK_RETRY_MS
  pure val START_FRESH = 1           // RELEASE_CHECK_ON_START_MS
  // packages/shared/update-check.ts:84-85
  pure val NOTES_INTERVAL = 1440     // RELEASE_ASSETS_FETCH_INTERVAL_MS
  pure val NOTES_FAIL_RETRY = 360    // RELEASE_ASSETS_FETCH_RETRY_MS
  // PR #2337: RELEASE_NOTES_PENDING_RETRY_MS, RELEASE_NOTES_YOUNG_MS
  pure val NOTES_PENDING_RETRY = 15
  pure val NOTES_YOUNG = 2880
  // packages/server/auto-update.ts:106, 126
  pure val AUTO_WINDOW = 1440        // AUTO_UPDATE_INTERVAL_MS
  pure val LOCK_STALE = 60           // AUTO_UPDATE_LOCK_STALE_MS
  pure val LOCK_LIVE_MAX = 1440      // AUTO_UPDATE_LOCK_LIVE_MAX_MS (PR #2342)

  // The bounds of the "eventually" properties (checked as invariants).
  pure val WHATS_NEW_BOUND = 30      // a tick this long after the real notes exist shows the link
  pure val OFFER_BOUND = 11          // 10 minutes plus one health tick
  // Environment assumption: CI replaces the generated body within the hour.
  pure val NOTES_LAG = 60

  // update-notes/<v>.json: none, saved without a "What's New" part, or readable.
  // notesFetch[v] (update-state.json): at = -1 when there is none.
  // inFlight: the claim, not yet answered. quick: retryOnline (on a claim, what
  // a failure of it records).
  type NotesFetch = { at: int, failed: bool, pub: int, inFlight: bool, quick: bool }

  // One install: the detached wrapper's process group and the install script in it.
  // phase: unused | spawned | locked | downloaded | aside | replaced | done | dead
  type Installer = { phase: str, v: int, person: bool, startedAt: int }

  type Sys = {
    act: str,                   // the step that led here (for reading traces)
    now: int,
    // --- GitHub ---
    published: int,             // newest published release ("latest")
    pubAt: int -> int,          // published_at
    body: int -> str,           // "none" | "generated" (GitHub's) | "ours" (the written notes)
    oursAt: int -> int,         // when the written notes went in
    draft: int,                 // DRAFT_FLOW: a draft not yet published (0: none)
    netUp: bool,
    // --- data dir: update-state.json and friends ---
    latest: int, latestAt: int,             // latestRelease
    rcAt: int, rcFailed: bool,              // releaseCheck.attemptedAt / failedAt >= attemptedAt
    notes: int -> str,                      // update-notes/<v>.json: none | empty | content
    nf: int -> NotesFetch,                  // notesFetch
    inboxVer: int,                          // inboxVersion
    wnPending: int,                         // whatsNewPending (0: none)
    pendingV: int, pendingPerson: bool,     // pending.version, pending.by == "person"
    resultV: int, resultCode: int,          // update-result.json (resultV 0: none)
    lockHeld: bool, lockKind: str, lockAt: int, lockOwner: int,  // update.lock: exists, form, mtime, whose
    autoLast: int,                          // lastCheckAt (auto-update's 24 h window)
    checksOn: bool,                         // PLANNOTATOR_UPDATE_CHECK
    autoOn: bool,                           // PLANNOTATOR_AUTO_UPDATE
    // --- disk: ~/.local/bin/plannotator ---
    binOk: bool,                            // the path holds a complete binary
    binV: int,
    // --- the Inbox process ---
    ibAlive: bool, ibRuns: int,
    ibUpdated: int,                         // `updated` (inbox-updates.ts:291), fixed at start
    ibOnDisk: int, ibStartedAt: int, ibLastTick: int,
    ibInflight: int -> bool,                // notesInFlight
    // --- installers ---
    inst: int -> Installer,
    // --- ghost (observations for the properties; no code reads them) ---
    netStableSince: int,                    // the network came back up
    netEverDown: bool,
    abandonedCheckAt: int,                  // a release check claimed by a process that quit mid-request
    checksOnSince: int,
    lastAutoCheck: int, minCheckGap: int,   // automatic release-check requests
    lastNotesReq: int -> int, minNotesGap: int,
    offFetch: bool,                         // an automatic request while checks were off
    startFailed: bool,                      // an Inbox start found no binary
    personV: int, personOutcome: str,       // the last install the person started: none | running | ok | failed
    tickAfterPersonEnd: bool,
    updatedTo: int -> bool,                 // an Inbox started on v right after an older version
    whatsNewSeen: int -> bool,              // the link to v's readable notes was shown
    abandoned: int -> bool,                 // an Inbox stopped while its request for v's notes was in flight
  }

  var s: Sys

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  pure def imin(a: int, b: int): int = if (a < b) a else b
  pure def imax(a: int, b: int): int = if (a > b) a else b
  pure def iabs(a: int): int = if (a < 0) -a else a

  pure def running(i: Installer): bool =
    Set("spawned", "locked", "downloaded", "aside", "replaced").contains(i.phase)

  pure def anyRunning(st: Sys): bool = IDS.exists(i => running(st.inst.get(i)))

  // auto-update.ts:331 lockExpired: an hour old, or an hour in the future.
  pure def lockExpired(st: Sys): bool =
    st.now - st.lockAt >= LOCK_STALE or st.lockAt - st.now >= LOCK_STALE

  // auto-update.ts lockHolderGone: only a holder line (pid= group= host= ...)
  // can be judged; a bare pid keeps the hour. launchInstaller writes the line at
  // the spawn on every platform (Windows judges the wrapper's pid).
  pure def holderGone(st: Sys): bool =
    st.lockKind == "wrapper" and not(running(st.inst.get(st.lockOwner)))

  // auto-update.ts lockHeld: a lock whose installer still runs holds past the
  // hour, up to a day (POSIX; Windows keeps the hour, it reuses a pid too soon).
  pure def liveLock(st: Sys): bool =
    not(WINDOWS) and st.lockKind == "wrapper" and running(st.inst.get(st.lockOwner))
      and iabs(st.now - st.lockAt) < LOCK_LIVE_MAX

  // auto-update.ts lockHeld (isUpdateLockHeld)
  pure def lockHeldView(st: Sys): bool =
    st.lockHeld and not(holderGone(st)) and (not(lockExpired(st)) or liveLock(st))

  // auto-update.ts acquireUpdateLock: free, or a lock that no longer holds.
  pure def canAcquire(st: Sys): bool = not(lockHeldView(st))

  // ---------------------------------------------------------------------------
  // The sidebar's update button: inbox-updates.ts:230 deriveInboxUpdate
  // ---------------------------------------------------------------------------

  pure def uiState(st: Sys): str =
    if (not(st.ibAlive)) "none"
    else if (st.ibOnDisk != st.ibRuns) "ready"
    else if (lockHeldView(st)) "updating"
    else if (st.pendingPerson and st.pendingV > st.ibRuns and st.resultV == st.pendingV and st.resultCode != 0) "failed"
    else if (not(st.checksOn) or st.latest <= st.ibRuns) "none"
    else "available"

  // ---------------------------------------------------------------------------
  // The release check: update-check.ts:455 isReleaseCheckDue, :825 runReleaseCheck
  // (the page source; the API fallback and the page's rate limit are not modelled)
  // ---------------------------------------------------------------------------

  pure def checkDue(st: Sys, fresh: int): bool =
    if (st.latest > 0 and st.latestAt <= st.now and st.now - st.latestAt < fresh) false
    else if (st.rcAt < 0 or st.rcAt > st.now) true
    else st.now - st.rcAt >= (if (st.rcFailed) CHECK_RETRY else imin(fresh, CHECK_RETRY))

  pure def noteAutoCheck(st: Sys): Sys =
    st.with("minCheckGap", if (st.lastAutoCheck < 0) st.minCheckGap else imin(st.minCheckGap, st.now - st.lastAutoCheck))
      .with("lastAutoCheck", st.now)
      .with("offFetch", st.offFetch or not(st.checksOn))

  pure def answerCheck(st: Sys): Sys =
    if (st.netUp)
      st.with("latest", st.published).with("latestAt", st.now).with("rcAt", st.now).with("rcFailed", false)
    else st.with("rcAt", st.now).with("rcFailed", true)

  pure def releaseCheck(st: Sys, fresh: int, isOn: bool, force: bool): Sys =
    if (force) answerCheck(st)
    else if (not(isOn) or not(checkDue(st, fresh))) st
    else answerCheck(noteAutoCheck(st))

  // ---------------------------------------------------------------------------
  // One release's notes by its tag: update-check.ts:1053 isNotesFetchDue,
  // :1082 fetchReleaseNotesFor; inbox-updates.ts:334 fetchableVersion, :341 ensureNotes
  // ---------------------------------------------------------------------------

  pure def young(r: NotesFetch, now: int): bool = r.pub >= 0 and iabs(now - r.pub) < NOTES_YOUNG

  pure def notesDue(st: Sys, v: int): bool =
    val r = st.nf.get(v)
    if (r.at < 0 or r.at > st.now) true
    else st.now - r.at >= (
      // WHATS_NEW_FIX: a failure that may have been the network, once a release check answered after it.
      if (r.failed) (if (WHATS_NEW_FIX and r.quick and st.latestAt > r.at) NOTES_PENDING_RETRY else NOTES_FAIL_RETRY)
      // WHATS_NEW_FIX: a claim nobody answered (its process quit).
      else if (WHATS_NEW_FIX and r.inFlight) NOTES_PENDING_RETRY
      else if (NOTES_FIX and young(r, st.now)) NOTES_PENDING_RETRY
      else NOTES_INTERVAL)

  pure def fetchable(st: Sys, v: int): bool =
    v == st.ibRuns or v == st.latest or v == st.ibOnDisk or v == st.pendingV

  // The claim (update-check.ts:1101), the request leaves; notesAnswer comes later.
  pure def notesClaim(st: Sys, v: int): Sys =
    if (v <= 0 or st.ibInflight.get(v) or st.notes.get(v) == "content" or not(st.checksOn)
        or not(fetchable(st, v)) or not(notesDue(st, v))) st
    else
      val prev = st.nf.get(v)
      // #2337 keeps a young release's date on the claim (pendingBefore).
      val keep = NOTES_FIX and prev.at >= 0 and not(prev.failed) and young(prev, st.now)
      // WHATS_NEW_FIX: marked in flight; a failure of it may retry quickly unless a
      // release check answered since the failure before it.
      val quick = WHATS_NEW_FIX and not(prev.at >= 0 and prev.failed and st.latestAt > prev.at)
      st.with("nf", st.nf.set(v, { at: st.now, failed: false, pub: if (keep) prev.pub else -1, inFlight: WHATS_NEW_FIX, quick: quick }))
        .with("ibInflight", st.ibInflight.set(v, true))
        .with("minNotesGap", if (st.lastNotesReq.get(v) < 0) st.minNotesGap else imin(st.minNotesGap, st.now - st.lastNotesReq.get(v)))
        .with("lastNotesReq", st.lastNotesReq.set(v, st.now))
        .with("offFetch", st.offFetch or not(st.checksOn))

  // GitHub answers releases/tags/v<v> as it is NOW (the body may have changed).
  pure def notesAnswered(st: Sys, v: int): Sys =
    val rec = st.nf.get(v)
    val claim = rec.at
    val done = st.with("ibInflight", st.ibInflight.set(v, false))
    if (not(st.netUp) or v > st.published)
      // update-check.ts:1113: a failure waits 6 h (a draft or missing tag answers 404);
      // WHATS_NEW_FIX: 15 min once a release check answered, when the claim allowed it.
      done.with("nf", st.nf.set(v, { at: claim, failed: true, pub: -1, inFlight: false, quick: rec.quick }))
    else if (st.body.get(v) == "ours")
      done.with("notes", st.notes.set(v, "content"))
        .with("nf", st.nf.set(v, rec.with("inFlight", false)))
    else
      // update-check.ts:1121 saves the empty notes; the claim stays as written
      // (main: 24 h). #2337 records the release's date: 15 min while young.
      done.with("notes", st.notes.set(v, if (st.notes.get(v) == "content") "content" else "empty"))
        .with("nf", st.nf.set(v, if (NOTES_FIX) { at: claim, failed: false, pub: st.pubAt.get(v), inFlight: false, quick: false } else rec.with("inFlight", false)))

  // inbox-updates.ts:385 computeUpdatedLink
  pure def link(st: Sys): int =
    if (not(st.ibAlive) or st.ibUpdated == 0) 0
    else if (st.notes.get(st.ibUpdated) == "content") st.ibUpdated
    else if (not(st.checksOn)) 0
    else if (st.ibInflight.get(st.ibUpdated)) st.ibUpdated
    else if (notesDue(st, st.ibUpdated)) st.ibUpdated
    else 0

  // ---------------------------------------------------------------------------
  // The Inbox: inbox-updates.ts:296 start, :418 compute (reap), :488 tick
  // ---------------------------------------------------------------------------

  // auto-update.ts reapDeadUpdateLock: a lock that no longer holds (its holder
  // gone, or past its hour) is released and its install recorded as failed.
  pure def reap(st: Sys): Sys =
    if (st.lockHeld and not(lockHeldView(st)))
      val record = st.pendingV > 0 and st.resultV != st.pendingV
      st.with("lockHeld", false)
        .with("resultV", if (record) st.pendingV else st.resultV)
        .with("resultCode", if (record) -1 else st.resultCode)
    else st

  // The link offered with readable notes; WHATS_NEW_FIX clears whatsNewPending then.
  pure def markSeen(st: Sys): Sys =
    if (st.ibUpdated > 0 and link(st) == st.ibUpdated and st.notes.get(st.ibUpdated) == "content")
      st.with("whatsNewSeen", st.whatsNewSeen.set(st.ibUpdated, true))
        .with("wnPending", if (st.wnPending == st.ibUpdated) 0 else st.wnPending)
    else st

  pure def tick(st: Sys, fresh: int): Sys =
    val probed = st.with("ibOnDisk", if (st.binOk) st.binV else st.ibOnDisk)  // :464 probeBinary
    val checked = releaseCheck(probed, fresh, probed.checksOn, false)        // :497
    val forLatest =                                                           // :507
      if (checked.latest > checked.ibRuns and checked.notes.get(checked.latest) != "content")
        notesClaim(checked, checked.latest)
      else checked
    val forUpdated =                                                          // :512
      if (forLatest.ibUpdated > 0 and forLatest.notes.get(forLatest.ibUpdated) != "content")
        notesClaim(forLatest, forLatest.ibUpdated)
      else forLatest
    markSeen(reap(forUpdated)                                                 // :519 refresh -> compute -> reap
      .with("ibLastTick", forUpdated.now)
      .with("tickAfterPersonEnd", true))

  pure def startInbox(st: Sys): Sys =
    val runs = st.binV
    val newer = st.inboxVer > 0 and runs > st.inboxVer                         // :300
    // WHATS_NEW_FIX: a start on the version still owed its link (whatsNewPending).
    val owed = newer or (WHATS_NEW_FIX and st.inboxVer == runs and st.wnPending == runs)
    tick(st.with("ibAlive", true).with("ibRuns", runs)
      .with("ibUpdated", if (owed) runs else 0)
      .with("wnPending", if (WHATS_NEW_FIX and newer) runs else st.wnPending)
      .with("ibOnDisk", runs).with("ibStartedAt", st.now)
      .with("ibInflight", VERSIONS.mapBy(v => false))
      .with("inboxVer", runs)                                                 // :303
      .with("updatedTo", if (newer) st.updatedTo.set(runs, true) else st.updatedTo),
      START_FRESH)                                                            // :591

  pure def stopInbox(st: Sys): Sys =
    st.with("ibAlive", false).with("ibInflight", VERSIONS.mapBy(v => false))
      .with("abandoned", VERSIONS.mapBy(v => st.abandoned.get(v) or st.ibInflight.get(v)))

  // ---------------------------------------------------------------------------
  // Installs: auto-update.ts:547 runAutoUpdateCheck, :698 beginManualUpdate,
  // :786 POSIX_WRAPPER, scripts/install.sh:1088, scripts/install.ps1:741
  // ---------------------------------------------------------------------------

  pure def freeSlot(st: Sys): int =
    if (st.inst.get(1).phase == "unused") 1
    else if (st.inst.get(2).phase == "unused") 2
    else if (st.inst.get(3).phase == "unused") 3
    else 0

  // Take update.lock, forget the old result, record pending, spawn the
  // detached wrapper; launchInstaller names the wrapper in the lock at once.
  pure def launch(st: Sys, v: int, person: bool): Sys =
    val id = freeSlot(st)
    if (not(canAcquire(st)) or id == 0) st
    else
      st.with("lockHeld", true).with("lockKind", "wrapper").with("lockAt", st.now).with("lockOwner", id)
        .with("resultV", 0).with("resultCode", 0)
        .with("pendingV", v).with("pendingPerson", person)
        .with("inst", st.inst.set(id, { phase: "spawned", v: v, person: person, startedAt: st.now }))
        .with("personV", if (person) v else st.personV)
        .with("personOutcome", if (person) "running" else st.personOutcome)

  pure def autoAfterClaim(st: Sys, current: int, othersOpen: bool, prevLast: int): Sys =
    if (st.latest <= current)
      // no-release gives the window back (:596); up-to-date keeps it (:601)
      if (st.latest == 0) st.with("autoLast", prevLast) else st
    else if (othersOpen) st.with("autoLast", prevLast)                         // :617 sessions-open
    else launch(st, st.latest, false)                                          // :629 (locked keeps the window)

  pure def cliRun(st: Sys, othersOpen: bool): Sys =
    val current = st.binV
    val checked = releaseCheck(st, CHECK_INTERVAL, st.checksOn, false)        // :1087
    if (not(checked.autoOn) or not(checked.checksOn)) checked                  // :550-551
    else if (checked.autoLast >= 0 and checked.autoLast <= checked.now and checked.now - checked.autoLast < AUTO_WINDOW) checked
    else autoAfterClaim(checked.with("autoLast", checked.now), current, othersOpen, checked.autoLast)

  pure def personEnded(st: Sys, i: int, failed: bool): Sys =
    val ins = st.inst.get(i)
    // (ghost) the person's last install ends: none of theirs still runs beside it
    if (ins.person and ins.v == st.personV and st.personOutcome == "running"
        and not(IDS.exists(j => j != i and running(st.inst.get(j)) and st.inst.get(j).person)))
      st.with("personOutcome", if (failed) "failed" else "ok").with("tickAfterPersonEnd", false)
    else st

  // The wrapper's end: record the code (update-result.json), then release the
  // lock only while it is still its own (release_lock; the PowerShell wrapper's
  // own check).
  pure def finish(st: Sys, i: int, code: int): Sys =
    val ins = st.inst.get(i)
    personEnded(
      st.with("resultV", ins.v).with("resultCode", code).with("lockHeld", st.lockHeld and st.lockOwner != i)
        .with("inst", st.inst.set(i, ins.with("phase", "done"))),
      i, code != 0)

  pure def kill(st: Sys, i: int): Sys =
    val ins = st.inst.get(i)
    personEnded(st.with("inst", st.inst.set(i, ins.with("phase", "dead"))), i, true)

  // The wrapper's first line (auto-update.ts:792-795) replaces the lock's
  // content with its own holder line: `>` creates or truncates, whoever held it.
  // The Windows wrapper writes none: the lock keeps the line launchInstaller wrote.
  pure def wrapperLock(st: Sys, i: int): Sys =
    val ins = st.inst.get(i)
    val s1 = st.with("inst", st.inst.set(i, ins.with("phase", "locked")))
    if (WINDOWS) s1
    else s1.with("lockHeld", true).with("lockKind", "wrapper").with("lockAt", st.now).with("lockOwner", i)

  pure def download(st: Sys, i: int): Sys =
    val ins = st.inst.get(i)
    if (st.netUp) st.with("inst", st.inst.set(i, ins.with("phase", "downloaded")))
    else finish(st, i, 75)                                                     // UPDATE_PREPARE_FAILED

  // install.sh:1088-1099: staged beside the target, one rename(2).
  // install.ps1:749-758 / install.cmd:956-961: move the old one aside, then move the new one in.
  pure def replace(st: Sys, i: int): Sys =
    val ins = st.inst.get(i)
    if (WINDOWS) st.with("binOk", false).with("inst", st.inst.set(i, ins.with("phase", "aside")))
    else st.with("binV", ins.v).with("inst", st.inst.set(i, ins.with("phase", "replaced")))

  pure def moveIn(st: Sys, i: int): Sys =
    val ins = st.inst.get(i)
    st.with("binOk", true).with("binV", ins.v).with("inst", st.inst.set(i, ins.with("phase", "replaced")))

  // ---------------------------------------------------------------------------
  // Actions (deterministic forms, for the tests; `step` picks among them)
  // ---------------------------------------------------------------------------

  action doAdvance(d: int): bool = all {
    VERSIONS.forall(v => not(s.ibInflight.get(v))),   // a request answers or times out in seconds
    // A wrapper writes its lock line within moments of its spawn (it is the
    // first thing it runs), or is killed first.
    IDS.forall(i => s.inst.get(i).phase != "spawned"),
    val later = s.with("now", s.now + d)
    s' = (if (later.ibAlive) tick(later, CHECK_INTERVAL) else later).with("act", "Advance"),
  }

  action doInboxStart: bool = all {
    not(s.ibAlive),
    s' = (if (s.binOk) startInbox(s) else s.with("startFailed", true)).with("act", "InboxStart"),
  }

  action doInboxCrash: bool = all { s.ibAlive, s' = (stopInbox(s)).with("act", "InboxCrash") }

  // A page load (nudge, inbox-updates.ts:598).
  action doPageLoad: bool = all { s.ibAlive, s' = (tick(s, START_FRESH)).with("act", "PageLoad") }

  // Check now (inbox-updates.ts:629): explicit, allowed with checks off.
  action doCheckNow: bool = all { s.ibAlive, s' = (releaseCheck(s, CHECK_INTERVAL, true, true)).with("act", "CheckNow") }

  // Update now in the sidebar (inbox-updates.ts:608): pressable when available or failed.
  action doUpdateNow: bool = all {
    s.ibAlive,
    Set("available", "failed").contains(uiState(s)),
    s.latest > s.ibRuns,
    s' = (launch(s, s.latest, true)).with("act", "UpdateNow"),
  }

  // A review window's Update (auto-update.ts:1243) or `plannotator update`: no UI gate.
  action doCliUpdateNow: bool = all {
    s.binOk,
    s.latest > s.binV,
    s' = (launch(s, s.latest, true)).with("act", "CliUpdateNow"),
  }

  // Restart (inbox.ts:2608, inbox-command.ts:302): stop, start the binary on disk.
  action doRestart: bool = all {
    s.ibAlive,
    uiState(s) == "ready",
    val stopped = stopInbox(s)
    s' = (if (stopped.binOk) startInbox(stopped) else stopped.with("startFailed", true)).with("act", "Restart"),
  }

  action doToggleChecks: bool = all {
    s' = (s.with("checksOn", not(s.checksOn))
          .with("checksOnSince", if (not(s.checksOn)) s.now else s.checksOnSince)).with("act", "ToggleChecks"),
  }

  // A session start (auto-update.ts:1077 scheduleAutoUpdateCheck).
  action doCliSession(othersOpen: bool): bool = all { s.binOk, s' = (cliRun(s, othersOpen)).with("act", "CliSession") }

  // A session's release check claimed (update-check.ts:841) and its process quit mid-request.
  action doCliCrashMidCheck: bool = all {
    s.checksOn,
    checkDue(s, CHECK_INTERVAL),
    s' = (noteAutoCheck(s).with("rcAt", s.now).with("rcFailed", false).with("abandonedCheckAt", s.now)).with("act", "CliCrashMidCheck"),
  }

  action doNotesAnswer(v: int): bool = all { s.ibAlive, s.ibInflight.get(v), s' = (notesAnswered(s, v)).with("act", "NotesAnswer") }

  // GitHub: CI publishes with GitHub's generated body; the written notes replace it later.
  action doPublish: bool = all {
    s.published < 3,
    s.draft == 0,
    s' = (if (DRAFT_FLOW) s.with("draft", s.published + 1)
         else s.with("published", s.published + 1)
                .with("pubAt", s.pubAt.set(s.published + 1, s.now))
                .with("body", s.body.set(s.published + 1, "generated"))).with("act", "Publish"),
  }

  action doWriteNotes(v: int): bool = all {
    v <= s.published,
    s.body.get(v) == "generated",
    s' = (s.with("body", s.body.set(v, "ours")).with("oursAt", s.oursAt.set(v, s.now))).with("act", "WriteNotes"),
  }

  // DRAFT_FLOW: the draft already carries the written notes when it is published.
  action doPublishDraft: bool = all {
    s.draft > 0,
    s' = (s.with("published", s.draft)
          .with("pubAt", s.pubAt.set(s.draft, s.now))
          .with("body", s.body.set(s.draft, "ours"))
          .with("oursAt", s.oursAt.set(s.draft, s.now))
          .with("draft", 0)).with("act", "PublishDraft"),
  }

  action doNetToggle: bool = all {
    s' = (s.with("netUp", not(s.netUp))
          .with("netStableSince", if (not(s.netUp)) s.now else s.netStableSince)
          .with("netEverDown", s.netEverDown or s.netUp)).with("act", "NetToggle"),
  }

  action doInstallerStep(i: int, ok: bool): bool = {
    val ins = s.inst.get(i)
    any {
      all { ins.phase == "spawned", s' = (wrapperLock(s, i)).with("act", "Installer: wrapper writes its lock line") },
      all { ins.phase == "locked", s' = (download(s, i)).with("act", "Installer: download") },
      all { ins.phase == "downloaded", s' = (replace(s, i)).with("act", if (WINDOWS) "Installer: move old binary aside" else "Installer: rename into place") },
      all { ins.phase == "aside", s' = (moveIn(s, i)).with("act", "Installer: move new binary in") },
      all { ins.phase == "replaced", s' = (finish(s, i, if (ok) 0 else 1)).with("act", if (ok) "Installer: exit 0" else "Installer: exit 1 (a later step failed)") },
    }
  }

  // SIGKILL of the whole group (OOM, logout, a reboot), at any step.
  action doKill(i: int): bool = all { running(s.inst.get(i)), s' = (kill(s, i)).with("act", "Kill") }

  // INT / TERM / HUP: the wrapper's trap records 130 and removes the lock (auto-update.ts:806).
  action doSignal(i: int): bool = all { running(s.inst.get(i)), not(WINDOWS), s' = (finish(s, i, 130)).with("act", "Signal") }

  action init = nondet auto = Set(true, false).oneOf() all {
    s' = {
      act: "init",
      now: 0,
      published: 1,
      pubAt: VERSIONS.mapBy(v => if (v == 1) 0 else -1),
      body: VERSIONS.mapBy(v => if (v == 1) "ours" else "none"),
      oursAt: VERSIONS.mapBy(v => if (v == 1) 0 else -1),
      draft: 0,
      netUp: true,
      latest: 0, latestAt: -1, rcAt: -1, rcFailed: false,
      notes: VERSIONS.mapBy(v => "none"),
      nf: VERSIONS.mapBy(v => { at: -1, failed: false, pub: -1, inFlight: false, quick: false }),
      inboxVer: 1,
      wnPending: 0,
      pendingV: 0, pendingPerson: false, resultV: 0, resultCode: 0,
      lockHeld: false, lockKind: "none", lockAt: -1000, lockOwner: 1,
      autoLast: -1, checksOn: true, autoOn: auto,
      binOk: true, binV: 1,
      ibAlive: false, ibRuns: 0, ibUpdated: 0, ibOnDisk: 0, ibStartedAt: 0, ibLastTick: -1,
      ibInflight: VERSIONS.mapBy(v => false),
      inst: IDS.mapBy(i => { phase: "unused", v: 0, person: false, startedAt: -1 }),
      netStableSince: 0, netEverDown: false, abandonedCheckAt: -1000, checksOnSince: 0,
      lastAutoCheck: -1, minCheckGap: 1000000,
      lastNotesReq: VERSIONS.mapBy(v => -1), minNotesGap: 1000000,
      offFetch: false, startFailed: false,
      personV: 0, personOutcome: "none", tickAfterPersonEnd: false,
      updatedTo: VERSIONS.mapBy(v => false),
      whatsNewSeen: VERSIONS.mapBy(v => false),
      abandoned: VERSIONS.mapBy(v => false),
    },
  }

  // The simulator picks among the enabled actions. Disruptions (a kill, a
  // crash, the network, the switch) are enabled on one step in CHAOS, so a
  // walk mostly follows the ordinary flow and still meets each of them; an
  // installer step picks a running installer when there is one.
  pure val CHAOS = 6

  action step = {
    nondet d = Set(1, 5, 10, 15, 30, 60, 360, 1440).oneOf()
    nondet v = VERSIONS.oneOf()
    nondet live = (if (anyRunning(s)) IDS.filter(j => running(s.inst.get(j))) else IDS).oneOf()
    nondet flag = Set(true, false).oneOf()
    nondet coin = 1.to(CHAOS).oneOf()
    any {
      doAdvance(d),
      doInboxStart,
      doPageLoad,
      doCheckNow,
      doUpdateNow,
      doCliUpdateNow,
      doRestart,
      doCliSession(flag),
      doNotesAnswer(v),
      doPublish,
      doWriteNotes(v),
      doPublishDraft,
      doInstallerStep(live, flag),
      all { coin == 1, doInboxCrash },
      all { coin == 2, doToggleChecks },
      all { coin == 3, doNetToggle },
      all { coin == 4, doCliCrashMidCheck },
      all { coin == 5, doKill(live) },
      all { coin == 6, doSignal(live) },
    }
  }

  // ---------------------------------------------------------------------------
  // Safety
  // ---------------------------------------------------------------------------

  /// Never two installers at once, unless the first has run past the lock's
  /// limit (a day on POSIX; Windows keeps the hour): a hung install never
  /// holds the lock for good.
  val NoTwoInstallers = IDS.forall(i => IDS.forall(j =>
    (i != j and running(s.inst.get(i)) and running(s.inst.get(j))
      and s.inst.get(i).startedAt <= s.inst.get(j).startedAt)
    implies s.now - s.inst.get(i).startedAt >= (if (WINDOWS) LOCK_STALE else LOCK_LIVE_MAX)))

  /// A crash never leaves a missing or partial binary at the install path.
  val BinaryAlwaysThere = s.binOk

  /// The Inbox can always start again (it starts from the binary on disk).
  val InboxCanStart = not(s.startFailed)

  /// Nothing is fetched automatically while update checks are off.
  val NothingFetchedWhileChecksOff = not(s.offFetch)

  /// No request loops: automatic release checks at least a minute apart, and
  /// one release's notes at least 15 minutes apart.
  val RequestRateBounded = s.minCheckGap >= START_FRESH and s.minNotesGap >= NOTES_PENDING_RETRY

  /// A stale lock is recovered: "Updating…" with no install alive never lasts
  /// an hour (the lock's mtime is never later than the install it names).
  val StaleLockRecovered =
    (uiState(s) == "updating" and not(anyRunning(s))) implies s.now - s.lockAt < LOCK_STALE

  /// The person always has a way to update: "Updating…" (which hides Update
  /// now and Try again) only while an install really runs.
  val PersonCanUpdate = uiState(s) == "updating" implies anyRunning(s)

  // ---------------------------------------------------------------------------
  // Bounded "eventually" (true once the bound has passed, in every state)
  // ---------------------------------------------------------------------------

  pure def since(st: Sys, v: int): int =
    imax(imax(st.oursAt.get(v), st.ibStartedAt), imax(st.netStableSince, st.checksOnSince))

  // The run that started on v (`updated` = v) has had a tick WHATS_NEW_BOUND
  // minutes after the written notes, its own start, the network's return and
  // checks being turned on.
  pure def whatsNewOwed(st: Sys): bool =
    st.ibAlive and st.ibUpdated > 0 and st.checksOn and st.netUp
      and st.body.get(st.ibUpdated) == "ours" and st.oursAt.get(st.ibUpdated) - st.pubAt.get(st.ibUpdated) <= NOTES_LAG
      and st.ibLastTick - since(st, st.ibUpdated) >= WHATS_NEW_BOUND

  /// THE KNOWN BUG (0.28.37). After an update, within the Inbox run that
  /// started on it, once the written notes exist, the "What's new" link shows
  /// within WHATS_NEW_BOUND minutes. Isolated from the two other causes found
  /// below: the network never failed, and no request for those notes was
  /// abandoned by a process that quit.
  val WhatsNewWithinRun =
    (whatsNewOwed(s) and not(s.netEverDown) and not(s.abandoned.get(s.ibUpdated)))
    implies link(s) == s.ibUpdated

  /// The same when an Inbox quit while its request for the notes was in flight.
  val WhatsNewAfterAbandonedRequest =
    (whatsNewOwed(s) and not(s.netEverDown))
    implies link(s) == s.ibUpdated

  /// The same after a network blip (the network was down, and is up again since `since`).
  val WhatsNewAfterBlip =
    (whatsNewOwed(s) and not(s.abandoned.get(s.ibUpdated)))
    implies link(s) == s.ibUpdated

  /// After an update, What's new is reachable at least once, even when the
  /// Inbox restarts (or is quit and started) before the notes were readable.
  val WhatsNewAfterUpdate =
    (s.ibAlive and s.updatedTo.get(s.ibRuns) and not(s.whatsNewSeen.get(s.ibRuns))
      and s.checksOn and not(s.netEverDown) and not(s.abandoned.get(s.ibRuns))
      and s.body.get(s.ibRuns) == "ours" and s.oursAt.get(s.ibRuns) - s.pubAt.get(s.ibRuns) <= NOTES_LAG
      and s.ibLastTick - since(s, s.ibRuns) >= WHATS_NEW_BOUND)
    implies link(s) == s.ibRuns

  /// A newer release is offered within 10 minutes (plus one tick).
  val NewReleaseOffered =
    (s.ibAlive and s.checksOn and s.netUp and s.published > s.ibRuns
      and s.ibLastTick - imax(s.pubAt.get(s.published), imax(s.netStableSince, s.checksOnSince)) >= OFFER_BOUND)
    implies uiState(s) != "none"

  /// The same, counting from a release check that a process abandoned
  /// mid-request (its claim holds the next check back 10 minutes, by design).
  val NewReleaseOfferedAfterAbandonedCheck =
    (s.ibAlive and s.checksOn and s.netUp and s.published > s.ibRuns
      and s.ibLastTick - imax(imax(s.pubAt.get(s.published), s.abandonedCheckAt), imax(s.netStableSince, s.checksOnSince)) >= OFFER_BOUND)
    implies uiState(s) != "none"

  /// A failed install the person started is shown (Failed, with the log and Try again).
  /// Excluded: update-result.json names another version. Only an older install
  /// that ran past the lock's day beside the person's, and ended after it, writes that.
  val FailedUpdateShown =
    (s.ibAlive and s.personOutcome == "failed" and s.tickAfterPersonEnd
      and s.pendingPerson and s.pendingV == s.personV and s.personV > s.ibRuns
      and (s.resultV == 0 or s.resultV == s.personV)
      and s.binOk and s.binV == s.ibRuns and not(anyRunning(s)))
    implies uiState(s) == "failed"

  val Safety = NoTwoInstallers and BinaryAlwaysThere and InboxCanStart
    and NothingFetchedWhileChecksOff and RequestRateBounded and StaleLockRecovered
}

// -----------------------------------------------------------------------------
// The code on main, and on PR #2337
// -----------------------------------------------------------------------------

module onMain {
  import updateLifecycle(NOTES_FIX = false, DRAFT_FLOW = false, WINDOWS = false, WHATS_NEW_FIX = false).*

  // The 0.28.37 report: the Inbox starts on the new version while the release
  // still carries GitHub's generated body; the written notes land minutes later.
  run knownBugTest =
    init
      .then(doPublish)                            // 0.28.37 is public, generated body
      .then(doCliSession(true))                   // a session learns of 2 (another session is open)
      .then(doCliUpdateNow)                       // installed (any path)
      .then(doInstallerStep(1, true))             // the wrapper's lock line
      .then(doInstallerStep(1, true))             // downloaded
      .then(doInstallerStep(1, true))             // renamed into place
      .then(doInstallerStep(1, true))             // finished, exit 0
      .then(doInboxStart)                         // the first run on 2: `updated` = 2
      .then(doNotesAnswer(2))                     // GitHub's generated body: empty notes
      .then(doWriteNotes(2))                      // the written notes replace it
      .then(doAdvance(60))
      .then(doAdvance(360))
      .expect(s.ibUpdated == 2 and s.body.get(2) == "ours" and link(s) == 0 and not(WhatsNewWithinRun))

  // The same bug reached before the update: the Inbox on 1 fetches 2's notes
  // for the update dialog while the body is generated; the person updates later.
  run knownBugBeforeUpdateTest =
    init
      .then(doInboxStart)
      .then(doPublish)
      .then(doAdvance(10))                        // the tick sees 2, asks for its notes
      .then(doNotesAnswer(2))                     // generated: empty, 24 h
      .then(doWriteNotes(2))
      .then(doUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doAdvance(1))                         // the probe sees 2 on disk: Ready
      .then(doRestart)
      .then(doAdvance(60))
      .expect(s.ibUpdated == 2 and link(s) == 0 and not(WhatsNewWithinRun))
}

module onFix {
  import updateLifecycle(NOTES_FIX = true, DRAFT_FLOW = false, WINDOWS = false, WHATS_NEW_FIX = false).*

  run knownBugFixedTest =
    init
      .then(doPublish)
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInboxStart)
      .then(doNotesAnswer(2))
      .then(doWriteNotes(2))
      .then(doAdvance(15))                        // the 15-minute retry claims
      .then(doNotesAnswer(2))                     // the written notes are saved
      .then(doAdvance(30))
      .expect(link(s) == 2 and WhatsNewWithinRun)

  // Still open on #2337: the run that started on 2 ends before the notes are
  // readable; the next run on 2 has `updated` = 0 and never shows the link.
  run restartLosesWhatsNewTest =
    init
      .then(doPublish)
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInboxStart)
      .then(doNotesAnswer(2))
      .then(doInboxCrash)                         // quit, a reboot, a crash
      .then(doInboxStart)                         // inboxVersion is already 2
      .then(doWriteNotes(2))
      .then(doAdvance(60))
      .expect(s.ibUpdated == 0 and not(WhatsNewAfterUpdate))

  // Still open on #2337: a network blip during the first fetch hides the link 6 h.
  run blipHidesWhatsNewTest =
    init
      .then(doPublish)
      .then(doWriteNotes(2))
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doNetToggle)                          // offline (a laptop waking up)
      .then(doInboxStart)
      .then(doNotesAnswer(2))                     // failed: 6 h
      .then(doNetToggle)                          // back online
      .then(doAdvance(60))
      .expect(link(s) == 0 and not(WhatsNewAfterBlip))
}

// F2-F4 fixed (on top of #2337): the three traces that stay open on onFix.
module onWhatsNewFix {
  import updateLifecycle(NOTES_FIX = true, DRAFT_FLOW = false, WINDOWS = false, WHATS_NEW_FIX = true).*

  // F2: the Inbox quits while its request for the notes is in flight.
  run abandonedRequestRetriedTest =
    init
      .then(doPublish)
      .then(doWriteNotes(2))
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInboxStart)                         // claims 2's notes
      .then(doInboxCrash)                         // before GitHub answered
      .then(doInboxStart)                         // whatsNewPending: still owed
      .then(doAdvance(15))                        // the claim in flight is asked again
      .then(doNotesAnswer(2))
      .then(doAdvance(15))
      .expect(link(s) == 2 and WhatsNewAfterAbandonedRequest and WhatsNewAfterUpdate)

  // F3: a network blip during the first fetch.
  run blipRetriedTest =
    init
      .then(doPublish)
      .then(doWriteNotes(2))
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doNetToggle)                          // offline
      .then(doInboxStart)
      .then(doNotesAnswer(2))                     // failed, may have been the network
      .then(doNetToggle)                          // back online
      .then(doAdvance(30))                        // the release check answers; asked again
      .then(doNotesAnswer(2))
      .then(doAdvance(30))
      .expect(link(s) == 2 and WhatsNewAfterBlip)

  // The known limit of F3: the network drops again before the quick retry, so
  // the retry fails too, and that failure waits 6 h (today's back-off).
  run flappingNetworkWaitsTest =
    init
      .then(doPublish)
      .then(doWriteNotes(2))
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doNetToggle)                          // offline
      .then(doInboxStart)
      .then(doNotesAnswer(2))                     // failed
      .then(doNetToggle)                          // online
      .then(doAdvance(10))                        // the release check answers
      .then(doNetToggle)                          // offline again
      .then(doAdvance(10))                        // the quick retry claims
      .then(doNotesAnswer(2))                     // and fails: a check answered since the failure before
      .then(doNetToggle)                          // online
      .then(doAdvance(15))                        // the release check answers; not asked (6 h)
      .then(doAdvance(30))
      .expect(link(s) == 0 and not(WhatsNewAfterBlip))

  // F4: the run that started on 2 ends before the notes are readable.
  run restartKeepsWhatsNewTest =
    init
      .then(doPublish)
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInboxStart)
      .then(doNotesAnswer(2))                     // generated: empty
      .then(doInboxCrash)
      .then(doInboxStart)                         // inboxVersion is 2, whatsNewPending is 2
      .then(doWriteNotes(2))
      .then(doAdvance(30))
      .then(doNotesAnswer(2))
      .then(doAdvance(30))
      .expect(s.ibUpdated == 2 and link(s) == 2 and s.wnPending == 0 and WhatsNewAfterUpdate)
}

module onFixDraft {
  import updateLifecycle(NOTES_FIX = true, DRAFT_FLOW = true, WINDOWS = false, WHATS_NEW_FIX = false).*

  run draftNeverGeneratedTest =
    init
      .then(doPublish)
      .then(doPublishDraft)
      .expect(s.body.get(2) == "ours")
}

module onWindows {
  import updateLifecycle(NOTES_FIX = false, DRAFT_FLOW = false, WINDOWS = true, WHATS_NEW_FIX = false).*

  // A kill between install.ps1's two moves leaves no plannotator.exe.
  run windowsKillBetweenMovesTest =
    init
      .then(doPublish)
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))
      .then(doInstallerStep(1, true))             // moved aside
      .then(doKill(1))
      .expect(not(BinaryAlwaysThere))

  // F6 on Windows (PR #2342): the lock names the wrapper's pid from the spawn,
  // so a killed install shows Failed at the next tick.
  run windowsKilledInstallShowsFailedTest =
    init
      .then(doInboxStart)
      .then(doPublish)
      .then(doAdvance(10))
      .then(doNotesAnswer(2))
      .then(doUpdateNow)
      .then(doKill(1))
      .then(doAdvance(1))
      .expect(uiState(s) == "failed" and PersonCanUpdate and FailedUpdateShown)
}

module onLocks {
  import updateLifecycle(NOTES_FIX = false, DRAFT_FLOW = false, WINDOWS = false, WHATS_NEW_FIX = false).*

  // F5 (PR #2342): an install that stalls past the hour keeps its lock while it
  // runs; a second install starts beside it only after a day.
  run slowInstallKeepsLockTest =
    init
      .then(doPublish)
      .then(doCliSession(true))
      .then(doCliUpdateNow)
      .then(doInstallerStep(1, true))             // the wrapper's lock line
      .then(doInstallerStep(1, true))             // downloading... stalls
      .then(doAdvance(60))
      .then(doCliUpdateNow)                       // refused: the install still runs
      .expect(s.inst.get(2).phase == "unused" and NoTwoInstallers)
      .then(doAdvance(1440))
      .then(doCliUpdateNow)                       // a day on: the lock no longer holds
      .expect(s.inst.get(2).phase == "spawned" and NoTwoInstallers)

  // F6 (PR #2342): the install dies before the wrapper's first line; the lock
  // already names it, so the next tick shows Failed.
  run killedInstallShowsFailedTest =
    init
      .then(doInboxStart)
      .then(doPublish)
      .then(doAdvance(10))
      .then(doNotesAnswer(2))
      .then(doUpdateNow)
      .then(doKill(1))                            // before the wrapper wrote its line
      .then(doAdvance(1))
      .expect(uiState(s) == "failed" and PersonCanUpdate and FailedUpdateShown)
}

