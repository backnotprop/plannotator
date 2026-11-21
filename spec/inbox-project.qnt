// -*- mode: Bluespec; -*-
/**
 * Which Inbox project a Claude Code session's messages land in while the
 * agent moves between folders.
 *
 * One Claude Code session and one Inbox. Actors: the agent (a shell `cd`, a
 * send with or without `project_path`, a thread list), the person (Claude
 * Code's own `/cd`, a New message to the session). Every definition names the
 * code it mirrors; spec/README.md maps the state to the code and explains each
 * property.
 *
 * The resolver is the Inbox's (packages/server/inbox-project-root.ts,
 * `resolveFolder`): a folder in a git repository files under the repository's
 * toplevel, a linked worktree under its main repository, any other folder
 * under itself. A project, once made, is kept forever (store.ts
 * `ensureProject`, append-only).
 *
 * Three switches:
 *   FOLLOW_CWD          main before the fix: the mod files under the shell's
 *                       current folder, `$.session.cwd()`, which every `cd`
 *                       moves (mod/register.ts:419, 722; mod/inbox.ts poll).
 *   FOLLOW_SLASH_CD     with the fix: the session's root, `$.session.root()`,
 *                       which only `/cd` moves, is the project folder
 *                       (INBOX_PROJECT_FOLLOWS_SLASH_CD in mod/inbox.ts).
 *                       Off: the folder the session started in, for good.
 *   READ_MAKES_PROJECT  main before the fix: read_thread's list resolved the
 *                       folder through `resolveProject`, which makes a project.
 */
module inboxProject {
  const FOLLOW_CWD: bool
  const FOLLOW_SLASH_CD: bool
  const READ_MAKES_PROJECT: bool

  // The folders, shaped like the workspace that showed the bug (spec/README.md):
  //   top              a plain folder (no .git) holding everything; sessions start here
  //   top/notes        a plain subfolder (a notes or findings folder)
  //   top/notes/deep   a plain subfolder of that
  //   top/repo         a git repository inside top
  //   top/repo/src     a subfolder of that repository
  //   wt               a linked worktree of top/repo, outside top (.claude/worktrees/agent-…)
  //   sib              another repository outside top
  //   tmp              a scratch folder (/tmp/x)
  pure val FOLDERS = Set("top", "top/notes", "top/notes/deep", "top/repo", "top/repo/src", "wt", "sib", "tmp")

  // packages/server/inbox-project-root.ts resolveFolder: git toplevel, a
  // linked worktree's main repository, else the folder itself.
  pure def rootOf(f: str): str =
    if (f == "top/repo" or f == "top/repo/src" or f == "wt") "top/repo" else f

  // What the last action did, for the properties.
  type Event = {
    kind: str,      // "start", "cd", "slashcd", "send", "named", "new", "read"
    project: str,   // the project root it landed in ("" for none)
    base: str,      // where its relative attachments resolved ("" for none)
    cwd: str,       // the working folder at that moment
    root: str,      // the session root at that moment
    named: str,     // the folder the agent named (kind "named")
    made: bool,     // whether it made a project
    fresh: bool,    // a New message: the session polled since the last /cd
  }

  var start: str            // where the session started
  var root: str             // $.session.root(): moves on /cd only
  var cwd: str              // $.session.cwd(): moves on cd and /cd
  var projects: Set[str]    // the Inbox's projects (store.listProjects(); never shrinks)
  var allowed: Set[str]     // roots a project may come from: the start, each /cd, each named folder
  var lastPoll: str         // the folder the session's latest bridge poll named ("" before the first)
  var polled: bool          // a poll came after the last /cd
  var last: Event

  // mod/inbox.ts InboxLink.projectFolder (after), or $.session.cwd() (before).
  def projectFolder: str =
    if (FOLLOW_CWD) cwd else if (FOLLOW_SLASH_CD) root else start

  pure val NONE: Event = { kind: "start", project: "", base: "", cwd: "", root: "", named: "", made: false, fresh: true }

  action initAt(f: str): bool = all {
    start' = f,
    root' = f,
    cwd' = f,
    projects' = Set(),
    allowed' = Set(rootOf(f)),
    lastPoll' = "",
    polled' = false,
    last' = { ...NONE, cwd: f, root: f },
  }

  action init = nondet f = FOLDERS.oneOf() initAt(f)

  // A shell `cd` (the Bash tool): only the working folder moves.
  action shellCd(f: str): bool = all {
    cwd' = f,
    last' = { ...NONE, kind: "cd", cwd: f, root: root },
    start' = start, root' = root, projects' = projects, allowed' = allowed, lastPoll' = lastPoll, polled' = polled,
  }

  // Claude Code's `/cd`: the session root moves, and the working folder with it.
  action slashCd(f: str): bool = all {
    root' = f,
    cwd' = f,
    allowed' = allowed.union(Set(rootOf(f))),
    last' = { ...NONE, kind: "slashcd", cwd: f, root: f },
    polled' = false,
    start' = start, projects' = projects, lastPoll' = lastPoll,
  }

  // The mod's bridge poll (every second): it names the project folder
  // (mod/inbox.ts pendingNow; before the fix, the cwd), which the Inbox keeps
  // as the session's place (inbox-sessions.ts pollStarted). Makes no project.
  action poll: bool = all {
    lastPoll' = projectFolder,
    polled' = true,
    last' = { ...NONE, kind: "poll", cwd: cwd, root: root },
    start' = start, root' = root, cwd' = cwd, projects' = projects, allowed' = allowed,
  }

  // send_message / submit_guide without project_path or reply_to
  // (inbox-mcp.ts sendProject -> resolveProject). Relative attachments resolve
  // against project_path (before: the cwd) or the working folder the mod sends
  // (after: INBOX_WORKING_FOLDER_META_KEY, and absolute attachment paths).
  action send: bool = {
    val p = rootOf(projectFolder)
    all {
      projects' = projects.union(Set(p)),
      last' = { ...NONE, kind: "send", project: p, base: cwd, cwd: cwd, root: root, made: not(p.in(projects)) },
      start' = start, root' = root, cwd' = cwd, allowed' = allowed, lastPoll' = lastPoll, polled' = polled,
    }
  }

  // The agent names project_path (relative to the cwd, resolved by the mod):
  // its project, and its relative paths stay relative to it.
  action sendNamed(f: str): bool = {
    val p = rootOf(f)
    all {
      projects' = projects.union(Set(p)),
      allowed' = allowed.union(Set(p)),
      last' = { ...NONE, kind: "named", project: p, base: f, cwd: cwd, root: root, named: f, made: not(p.in(projects)) },
      start' = start, root' = root, cwd' = cwd, lastPoll' = lastPoll, polled' = polled,
    }
  }

  // The person's New message to this session: the Inbox files it under the
  // folder the session's latest poll named (inbox-compose.ts startThread).
  // Only a session that polled is live and can be picked.
  action newMessage: bool = {
    val p = rootOf(lastPoll)
    all {
      lastPoll != "",
      projects' = projects.union(Set(p)),
      last' = { ...NONE, kind: "new", project: p, cwd: cwd, root: root, made: not(p.in(projects)), fresh: polled },
      start' = start, root' = root, cwd' = cwd, allowed' = allowed, lastPoll' = lastPoll, polled' = polled,
    }
  }

  // read_thread's list (and the thread list after a compaction) for the
  // session's folder.
  action readList: bool = {
    val p = rootOf(projectFolder)
    val makes = READ_MAKES_PROJECT and not(p.in(projects))
    all {
      projects' = if (makes) projects.union(Set(p)) else projects,
      last' = { ...NONE, kind: "read", project: p, cwd: cwd, root: root, made: makes },
      start' = start, root' = root, cwd' = cwd, allowed' = allowed, lastPoll' = lastPoll, polled' = polled,
    }
  }

  action step = {
    nondet f = FOLDERS.oneOf()
    any {
      shellCd(f),
      slashCd(f),
      poll,
      send,
      sendNamed(f),
      newMessage,
      readList,
    }
  }

  // ---- Properties ---------------------------------------------------------

  // The folder the session files under: where it started, or where the
  // person last /cd'd to (FOLLOW_SLASH_CD).
  def sessionFolder: str = if (FOLLOW_SLASH_CD) root else start

  // A session's sends and New messages land in one project, its folder's,
  // unless the agent names project_path. A shell `cd` never changes it.
  // (A New message in the second between a /cd and the next poll still
  // lands where the session was: the poll is what tells the Inbox.)
  val OneProjectPerSession =
    and {
      last.kind == "send" implies last.project == rootOf(sessionFolder),
      (last.kind == "new" and last.fresh) implies last.project == rootOf(sessionFolder),
    }

  // A New message lands where the session's own send would land at that
  // moment, without waiting for a poll after a shell `cd`.
  val NewMessageAgreesWithSend =
    (last.kind == "new" and last.fresh) implies last.project == rootOf(projectFolder)

  // No project is made by a `cd`: every project is the start folder's, a
  // /cd target's, or one the agent named.
  val NoProjectFromCd = projects.subseteq(allowed)

  // Relative attachments resolve against the folder the agent works in now;
  // a named project_path keeps them relative to it.
  val AttachmentsWhereAgentWorks =
    and {
      last.kind == "send" implies last.base == last.cwd,
      last.kind == "named" implies last.base == last.named,
    }

  // A thread list never makes a project.
  val ReadMakesNoProject = last.kind == "read" implies not(last.made)

  // A named project_path is honoured.
  val NamedProjectHonoured = last.kind == "named" implies last.project == rootOf(last.named)

  val AllProperties = and {
    OneProjectPerSession,
    NewMessageAgreesWithSend,
    NoProjectFromCd,
    AttachmentsWhereAgentWorks,
    ReadMakesNoProject,
    NamedProjectHonoured,
  }

  // ---- The session that showed the bug: four New messages ----------------
  //
  // Started in a plain top folder (no .git). Each New message went out
  // while the session's shell stood somewhere else.
  run workspaceFourMessagesTest =
    initAt("top")
      .then(poll)
      .then(newMessage)                // 1st: the shell in the top folder
      .then(shellCd("top/repo"))
      .then(poll)
      .then(newMessage)                // 2nd: in a repository inside it
      .then(shellCd("top/notes"))
      .then(poll)
      .then(newMessage)                // 3rd: in a plain subfolder
      .then(shellCd("top/notes/deep"))
      .then(poll)
      .then(newMessage)                // 4th: in a plain subfolder of that
      .expect(projects.size() == (if (FOLLOW_CWD) 4 else 1))
}

module onMain {
  import inboxProject(FOLLOW_CWD = true, FOLLOW_SLASH_CD = true, READ_MAKES_PROJECT = true).*

  // A cd into a plain subfolder, one send: a new project for good.
  run cdMakesProjectTest =
    initAt("top")
      .then(send)
      .then(shellCd("top/notes"))
      .then(send)
      .expect(projects == Set("top", "top/notes") and not(NoProjectFromCd) and not(OneProjectPerSession))

  // After a cd, the session's next send and a New message (before the next
  // poll) land in two projects.
  run newMessageSplitsFromSendTest =
    initAt("top")
      .then(poll)
      .then(shellCd("top/notes"))
      .then(send)
      .then(newMessage)
      .expect(last.project == "top" and projects == Set("top", "top/notes") and not(NewMessageAgreesWithSend))

  // A thread list from a folder the Inbox never saw makes a project.
  run readMakesProjectTest =
    initAt("top")
      .then(shellCd("tmp"))
      .then(readList)
      .expect(projects == Set("tmp") and not(ReadMakesNoProject))
}

module onFix {
  import inboxProject(FOLLOW_CWD = false, FOLLOW_SLASH_CD = true, READ_MAKES_PROJECT = false).*

  // Every kind of move, then a send and a New message: still the start project.
  run wanderTest =
    initAt("top")
      .then(shellCd("top/notes/deep"))
      .then(send)
      .then(shellCd("wt"))
      .then(poll)
      .then(newMessage)
      .then(shellCd("tmp"))
      .then(readList)
      .then(shellCd("sib"))
      .then(send)
      .expect(projects == Set("top") and AllProperties)

  // The agent names another repository: that project, once; its next plain send is home again.
  run namedThenHomeTest =
    initAt("top/repo/src")
      .then(sendNamed("sib"))
      .then(send)
      .expect(projects == Set("sib", "top/repo") and AllProperties)

  // /cd is the person's deliberate move: the project follows it.
  run slashCdMovesTest =
    initAt("top")
      .then(send)
      .then(slashCd("sib"))
      .then(poll)
      .then(newMessage)
      .expect(projects == Set("top", "sib") and last.project == "sib" and AllProperties)
}

module onFixStartOnly {
  import inboxProject(FOLLOW_CWD = false, FOLLOW_SLASH_CD = false, READ_MAKES_PROJECT = false).*

  // The switch off: even /cd keeps the start folder.
  run slashCdStaysTest =
    initAt("top")
      .then(slashCd("sib"))
      .then(send)
      .expect(projects == Set("top") and AllProperties)
}
