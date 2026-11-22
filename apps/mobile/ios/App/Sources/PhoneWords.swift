import Foundation
import InboxCore
import InboxWire

/// Every word the app shows that is NOT yet in the contract's generated `Words` (apps/mobile/contract/words).
///
/// The standing rule is that Swift holds no product word of its own. The generated table has about thirty words
/// today (sections, agents, delivery lines); the rest of the window's words live inside its components. Until each
/// of these is a product constant with a row in scripts/mobile/words.ts, it lives here, in one file, with where it
/// comes from, so the whole list can be read, approved and moved in one pass. Nothing outside this file and
/// InboxCore's CountWords and ActionWords (the toasts after a row action) writes a visible word.
///
/// A refusal is never shown in the Inbox's own words (they name keys and revisions): the few a person must act on
/// are said here, plainly.
enum PhoneWords {
  // MARK: First run and pairing (FLOWS 2, mock 1; the phone's own screen, no window twin)
  static let pairTitle = "Scan the code on your computer"
  static let pairWhere = "On your computer, open the Inbox, then Settings, Remote devices, Pair a phone."
  static let pairTypeInstead = "Type the address and six digits"
  /// Mock 1 says "a locked copy". The copy is encrypted by the phone and readable once the phone has been unlocked
  /// after a restart, so the words say that and no more.
  static let pairPromise = "Your messages stay on your computer. The phone keeps an encrypted copy so you can read, and answer, when the computer is away."
  /// Brief S1, "Demo mode".
  static let pairTryDemo = "Try it without a computer"
  static let pairAddress = "Address"
  static let pairAddressHint = "computer.tailnet.ts.net:8443"
  static let pairDigits = "Six digits"
  static let pairAction = "Pair"
  /// packages/inbox/components/PairFlow.tsx:406, as flow check pair-06 cites it.
  static let pairTailnetOnly = "Over Wi-Fi the phone pairs by scanning only."
  static let pairCameraOff = "Allow the camera in Settings to scan the code."
  static let pairOpenSettings = "Open Settings"
  static let pairNotACode = "That is not a Plannotator pairing code."
  static func pairTriesLeft(_ n: Int) -> String { n == 1 ? "1 try left." : "\(n) tries left." }
  /// Flow check pair-09: say which address was tried and what each one needs.
  static func pairNoAnswer(_ address: String) -> String { "No answer from \(address)." }
  static let pairNeedsWifi = "Over Wi-Fi: this phone must be on the same Wi-Fi as the computer, with Local Network allowed."
  static let pairNeedsTailnet = "Over the tailnet: Tailscale must be signed in on this phone."
  static let cancel = "Cancel"
  static let pairNoCamera = "No camera on this device."
  static let pairNotSaved = "This phone could not keep the pairing. Try again."
  /// A pairing link opened from outside the app (a web page, another app, the Camera app): one sheet, two equal actions.
  /// The address is the one thing the phone can vouch for; the name is only what the link says.
  static let pairAsk = "Pair with this computer?"
  static func pairCallsItself(_ name: String) -> String { "It calls itself “\(name)”." }
  static let pairAskDetail = "This phone will read and answer its Inbox."
  static let pairing = "Pairing…"
  /// FLOWS 13.
  static let pairAnother = "Pair another"
  static let demoMark = "Demo"

  // MARK: Versions (SPEC 1.9)
  /// The door's own words for `426 app_needs_update` (packages/server/inbox-door-version.ts, `appBelowFloor`).
  static let updatePhone = "Update Plannotator on your phone."
  /// FLOWS 2 and 13.
  static func updateComputer(_ name: String) -> String { "Update Plannotator on \(name)" }
  static func removedByComputer(_ name: String) -> String { "\(name) removed this phone. Pair again to use it." }
  static let pairAgain = "Pair again"
  static let update = "Update"
  /// What still works while the app is too old for the computer: the copy this phone keeps.
  static let updateStillReads = "You can still read what this phone has. Answering needs the update."
  static let updateToAnswer = "Update Plannotator on your phone to answer."

  // MARK: The list (FLOWS 3 and 12, mocks 2 and 3)
  static let inbox = "Inbox"
  /// FLOWS 1, Settings: "Remove this phone".
  static let removeThisPhone = "Remove this phone"
  static let leaveDemo = "Leave the demo"
  static let listEmpty = "Nothing here yet"
  /// FLOWS 12 says "<computer> is asleep"; without the relay the phone cannot tell asleep from out of reach.
  static func away(_ name: String) -> String { "Can't reach \(name). You are reading what this phone has." }
  static func awayNoCopy(_ name: String) -> String { "Can't reach \(name)." }
  static let tryAgain = "Try again"
  /// FLOWS 12: "Will send when Work Mac is back".
  static func willSendWhenBack(_ name: String) -> String { "Will send when \(name) is back." }
  /// FLOWS 3, the row's tag.
  static let willSend = "Will send"
  static let stateHere = "Connected"
  /// The window's words for a path that does not answer (packages/inbox/components/Devices.tsx:336).
  static let stateAway = "Not reachable yet"
  static let stateNeedsUpdate = "Needs an update"
  static let stateRemoved = "Removed"
  static let stateConnecting = "Connecting"
  static let unreadMark = "Unread"

  // MARK: A thread (FLOWS 4, mock 4)
  /// packages/core/inbox-types.ts:490 `inboxAgentName`'s fallback.
  static let anAgent = "An agent"
  /// The window's own word for the person in a row's preview (packages/core/inbox-row-preview.ts:61, "You: …").
  static let you = "You"
  /// Brief S1: a block this slice does not draw yet.
  static let moreOnComputer = "More on your computer"
  static let threadGone = "This thread is no longer on your computer."
  static let reply = "Reply"
  static let send = "Send"
  /// Mock 4.
  static let noteOrSend = "Add a note, or just send"
  static let replyOnComputer = "Reply to this one on your computer"
  static let wordsBack = "Your words are back in the box."
  /// Who a reply went to, beside "You" (the window says it in the delivery line, "Delivered to Claude Code").
  static func to(_ name: String) -> String { "to \(name)" }
  /// TODO(contract): "words rows" (`openItemsLabel`, packages/core/inbox-open-questions.ts). The button at a thread's
  /// foot: "3 open questions" or "2 open action items" when one kind waits; both named, without "open", when both
  /// do; "1 permission waiting" when only a started agent's permission prompts do.
  /// Nil when every question is answered in the draft: the button is its mark alone then, named `allAnswered`.
  static func openItems(_ items: OpenItems) -> String? {
    func each(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
    if items.answered { return nil }
    if items.permission { return "\(items.unanswered) permission\(items.unanswered == 1 ? "" : "s") waiting" }
    if items.actions == 0 { return "\(items.unanswered) open question\(items.unanswered == 1 ? "" : "s")" }
    if items.unanswered == 0 { return "\(items.actions) open action item\(items.actions == 1 ? "" : "s")" }
    return "\(each(items.unanswered, "question")), \(each(items.actions, "action item"))"
  }
  /// packages/inbox/components/OpenQuestions.tsx: the button's name when it shows no count.
  static let allAnswered = "Questions, all answered in your draft"
  /// TODO(contract): "words rows". packages/ui/components/blocks/CodeBlock.tsx:63: the copy button and its answer.
  static let copy = "Copy code"
  static let copied = "Copied!"
  /// TODO(contract): "words rows" (the question eyebrow, packages/ui/components/blocks/QuestionBlock.tsx:743).
  static func eyebrow(_ index: Int, _ count: Int, multi: Bool) -> String { "Question \(index) of \(count)\(multi ? " · pick any" : "")" }

  // MARK: What was not taken (TODO(contract): "words rows": sendFailure.ts and the pick lines of Thread.tsx)
  /// Why a Send was not taken (packages/inbox/sendFailure.ts): a short plain refusal of the Inbox is the line as it
  /// is, because it says what to do; anything else is the window's own line. Two cases have their own words: an
  /// answer another device changed (the Inbox's line for it names a key and a revision), and a session that ended.
  static func notice(_ notice: InboxSession.Notice, computer: String, agent: String? = nil) -> String {
    switch notice {
    case .refused(_, "question_revision_conflict"): return answerChanged
    case .refused(_, "session_not_live"): return sessionEnded(agent)
    case .refused(let words, _): return SendFailure.plain(words) ?? replyNotSent
    case .unreadable: return replyNotSent
    case .notOffered: return "Plannotator on \(computer) cannot do this yet."
    case .appNeedsUpdate: return updatePhone
    case .gaveWay: return answerChanged
    }
  }
  /// packages/inbox/sendFailure.ts.
  static let replyNotSent = "The reply was not sent."
  /// `raceWhat` (packages/inbox/components/ReplyRoute.tsx:387).
  static func sessionEnded(_ agent: String?) -> String { "That \(agent.map { "\($0) " } ?? "")session ended before your reply went. Nothing was sent." }
  /// A Send that named an answer another device changed after this phone read it.
  static let answerChanged = "An answer changed on another device. Check it, then send again."
  /// Why a pick did not go, on its card (packages/inbox/components/Thread.tsx:2499, :2505, :2516).
  static func pickNotice(_ notice: InboxSession.Notice, computer: String) -> String {
    switch notice {
    case .refused(_, "question_superseded"): return "Pick not saved. That question was replaced, so this answer won't be sent."
    case .refused(_, "question_already_sent"): return "Pick not saved. That question was already sent, so your last change did not go."
    case .refused(_, "question_revision_conflict"): return pickNotSaved
    case .refused(let words, _): return SendFailure.plain(words) ?? pickNotSaved
    case .gaveWay: return gaveWay
    case .unreadable: return pickNotSaved
    case .notOffered, .appNeedsUpdate: return self.notice(notice, computer: computer)
    }
  }
  static let pickNotSaved = "The pick was not saved."
  /// The phone's own: a pick that waited on the phone while another device answered gives way to that answer.
  static let gaveWay = "Another device answered after you, while your pick waited. That answer is shown, not yours."
  /// Why a Done or Can't do it the person pressed did not go. The Inbox's own lines name the item's key.
  static func markNotice(_ notice: InboxSession.Notice, computer: String) -> String {
    switch notice {
    case .refused(_, "action_already_sent"): return "Not saved. It was already sent."
    case .refused(_, "action_closed"): return "Not saved. This action item is closed."
    case .refused(_, "thread_resolved"): return "Not saved. This thread is archived."
    case .notOffered, .appNeedsUpdate: return self.notice(notice, computer: computer)
    default: return "Not saved. Try again."
    }
  }

  // MARK: The stale guard (packages/inbox/components/ReplacedQuestion.tsx `StaleGuard`: every word is the window's)
  static func guardHeading(position: Int?, count: Int) -> String { count == 1 ? "Question \((position ?? 0) + 1) changed before you sent" : "\(count) questions changed before you sent" }
  static func guardReplaced(agent: String, prompt: String, at time: String, by: Bool) -> String { by ? "\(agent) replaced **\(prompt)** at \(time)." : "\(agent) said at \(time) that **\(prompt)** no longer applies." }
  static func guardPick(_ words: String?) -> String { words.map { "Your pick, **\($0)**, will not be sent." } ?? "Your pick on it will not be sent." }
  static let guardWordsGo = "Your words still go if you send. They were written for the old question, so check they still fit."
  static let guardRestGoes = "The rest of this reply still goes if you send."
  static let guardNothingElse = "Nothing else is in this reply yet."
  static let guardAnswerNew = "Answer the new question"
  static let guardReadWhy = "Read why"
  static func guardSendRest(words: Bool, picks: Int) -> String {
    let rest = [words ? "your words" : nil, picks > 0 ? "\(picks) other \(picks == 1 ? "pick" : "picks")" : nil].compactMap { $0 }
    return "Send \(rest.joined(separator: " and ")) only"
  }
  static let guardKeepEditing = "Keep editing"

  // MARK: A row's marks, said (TODO(contract): "words rows": `questionMarkWords`, `actionMarkWords`, RowBadge.tsx)
  static func markWords(_ marks: RowMarks) -> [String] {
    func head(_ step: RowMarks.Step) -> String? { step == .open ? nil : Words.sections[step == .stop ? "stopped" : "holding"] }
    func plural(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
    var out: [String] = []
    if marks.actions > 0 { out.append(head(marks.action).map { "\($0): \(plural(marks.actions, "action item"))" } ?? "\(marks.actions) action\(marks.actions == 1 ? "" : "s") to do") }
    if marks.questions > 0 { out.append(head(marks.question).map { "\($0): \(plural(marks.questions, "question"))" } ?? plural(marks.questions, "question")) }
    return out
  }

  // MARK: Acting on a row (FLOWS 3; every word here is the window's unless it says "the phone's own")
  /// The row menu and the thread's More menu (packages/inbox/components/RowMenu.tsx `LABELS`, CopyMenus.tsx).
  static let select = "Select"
  static let starThread = "Star thread"
  static let unstarThread = "Unstar thread"
  static let addToPriority = "Add to Priority"
  static let removeFromPriority = "Remove from Priority"
  static let copyLink = "Copy link"
  static let copyThreadID = "Copy thread ID"
  static let snooze = "Snooze"
  static let unsnooze = "Unsnooze"
  static let markRead = "Mark read"
  static let markUnread = "Mark unread"
  static let moveBack = "Move back"
  static let moveBackToTop = "Move back to the top"
  static let archive = "Archive"
  static let unarchive = "Unarchive"
  static let archiveThread = "Archive thread"
  static let unarchiveThread = "Unarchive thread"
  /// The thread's More button (packages/inbox/components/Thread.tsx, "More").
  static let more = "More"
  /// The swipes (packages/inbox/rowSwipe.ts `SWIPE_QUIET_LABEL`, `SWIPE_QUIET_NAME`).
  static let swipeQuiet = "Quiet"
  static let swipeQuietName = "Mark read, move to Quiet"
  /// Snooze's times (packages/ui/components/inbox-thread/SnoozeMenu.tsx).
  static let snoozeUntil = "Snooze until"
  static let pickATime = "Pick a time…"
  static let pickATimeTitle = "Pick a time"
  static let day = "Day"
  static let time = "Time"
  /// A snoozed row's return, said (packages/inbox/components/InboxList.tsx `SnoozedUntil`, `RowTime`).
  static func snoozedUntil(_ when: String) -> String { "Snoozed until \(when)" }
  static let backFromSnooze = "Back from snooze"
  /// The thread's lines (packages/inbox/components/Thread.tsx `data-snooze-line`, `data-read-line`, the archived foot,
  /// `snoozeBackWords`).
  static func readLine(at time: String, agent: String) -> String { "Read \(time). It stays out of the top until \(agent) writes again." }
  static func archivedLine(_ agent: String) -> String { "Archived. The next message from \(agent) starts a new thread." }
  static func backFromSnooze(_ when: String) -> String { "Back from snooze · \(when)" }
  /// A starred row (packages/inbox/components/PinnedRow.tsx), and the star on a list row (InboxList.tsx).
  static let starred = "Starred"
  static let moveUp = "Move up"
  static let moveDown = "Move down"
  /// The picks' bar and sheet (packages/inbox/components/PickBar.tsx).
  static let selectAll = "Select all"
  static func selected(_ n: Int) -> String { "\(n.formatted(.number.locale(Locale(identifier: "en_US")))) selected" }
  /// The large title while picking with nothing picked: short enough to stand whole (the window's hint, "Tap
  /// threads to select them", is cut off at a large title's size).
  static let tapToSelect = "Select threads"
  static let starThreads = "Star threads"
  static let unstarThreads = "Unstar threads"
  /// The toast's way out (packages/inbox/components/Toast.tsx).
  static let dismiss = "Dismiss"
  /// A closed group (packages/inbox/components/InboxList.tsx): ", new since closed" for a screen reader.
  static let newSinceClosed = "new since closed"
  /// The Archived list (packages/inbox/components/ArchivedGroup.tsx; its name is the window's group's, "Archived").
  static let archived = "Archived"
  static let nothingArchived = "Nothing archived."
  static let showMore = "Show 20 more"
  /// The warning before a Mark read that sets questions aside is ActionWords.setAsideWarning; its other button:
  /// packages/inbox/components/MarkReadWarning.tsx.
  /// Why an act on a thread was not taken: the Inbox's own short sentence, else the window's fallback
  /// (packages/inbox/toastError.ts, App.tsx).
  static func actNotice(_ notice: InboxSession.Notice, computer: String) -> String {
    switch notice {
    case .refused(_, "snooze_past"): return ActionWords.timePassed
    case .refused(let words, _): return SendFailure.plain(words) ?? ActionWords.threadDidNotChange
    case .unreadable: return ActionWords.unreachable
    case .gaveWay: return actGaveWay
    case .notOffered, .appNeedsUpdate: return self.notice(notice, computer: computer)
    }
  }
  /// The phone's own: an act that waited on the phone while the thread changed on another device is not sent.
  static let actGaveWay = "Not changed: it changed on another device"

  // MARK: Answering (FLOWS 5, mock 4; contract flow checks answer-01 to answer-14)
  /// FLOWS 5: the kind, above the prompt.
  static func kind(_ kind: InboxQuestionKind) -> String? {
    switch kind {
    case .single: return "Pick one"
    case .multi: return "Pick any"
    case .text: return "Your words"
    default: return nil
    }
  }
  /// Mock 4: "Holding up the pull request".
  static func holdingUp(_ what: [String]) -> String { "Holding up \(what.joined(separator: ", "))" }
  static let recommended = "Recommended"
  /// The window's own word (packages/ui/components/blocks/QuestionBlock.tsx:34, flow check answer-03).
  static let other = "Other…"
  static let otherHint = "Your own words"
  static let answerHint = "Your answer"
  /// Flow check answer-01: the card's footer.
  static let addNote = "Add note"
  /// packages/ui/components/blocks/QuestionBlock.tsx:1275.
  static let hideNote = "Hide note"
  static let note = "Note"
  static let noteHint = "A note for this answer"
  static let skip = "Skip"
  static let skipped = "Skipped"
  /// packages/ui/components/blocks/QuestionBlock.tsx:1290.
  static let undoSkip = "Unskip"
  /// Flow check answer-07 (packages/inbox/components/Thread.tsx:2658): "Picked <time> · in your draft".
  static func picked(at time: String) -> String { time.isEmpty ? "Picked · in your draft" : "Picked \(time) · in your draft" }
  static func sent(at time: String) -> String { time.isEmpty ? "Sent" : "Sent \(time)" }
  /// A pick the computer does not have yet.
  static let pickedOnPhone = "Picked · on this phone"
  /// packages/ui/components/blocks/QuestionBlock.tsx:1302.
  static let acceptRecommended = "Accept recommended"

  // MARK: Action items (packages/inbox/components/ActionChecklist.tsx: every word here is the window's)
  static func thingsOnlyYou(_ n: Int) -> String { n == 1 ? "1 thing only you can do" : "\(n) things only you can do" }
  static func actionsReplaced(_ n: Int) -> String { n == 1 ? "1 action item, replaced" : "\(n) action items, replaced" }
  static func doneOf(_ done: Int, _ total: Int, replaced: Int) -> String { "\(done) of \(total) done" + (replaced > 0 ? " · \(replaced) replaced" : "") }
  static let stopped = "Stopped"
  static func holdsUp(_ n: Int) -> String { "Holds up \(n)" }
  static func holdsUpWhat(_ what: [String]) -> String { "Holds up \(what.joined(separator: "; "))" }
  static let cantDoIt = "Can't do it"
  static let cantDoItMore = "Can't do it…"
  static let setAside = "Set aside"
  static let closed = "Closed"
  static func whyCant(_ agent: String) -> String { "Why can't you? \(agent) gets this word for word." }
  static func noteFor(_ agent: String) -> String { "Add a note for \(agent)" }
  /// The draft field's name for a screen reader: a reason, or a note.
  static func noteLabel(_ agent: String, cant: Bool) -> String { cant ? "Why you can't, for \(agent)" : "A note for \(agent)" }
  static func markInDraft(cant: Bool, seen: Bool, at time: String) -> String {
    if seen { return "\(cant ? "Your reason" : "Your note") · in your draft" }
    return "\(cant ? cantDoIt : done)\(time.isEmpty ? "" : " \(time)") · in your draft"
  }
  static func markWaits(cant: Bool, computer: String) -> String { "\(cant ? cantDoIt : done) · will send when \(computer) is back" }
  static func watching(_ agent: String, _ what: [String]) -> String {
    let text = what.joined(separator: "; ")
    return "\(agent) is watching: \(text)\(text.last.map { ".!?…".contains($0) } == true ? "" : ".")"
  }
  static func openLink(_ place: String?) -> String { "Open \(place ?? "link")" }
  static let command = "Command"
  static func goesSoon(cant: Bool, note: String?, at time: String, agent: String) -> String {
    cant ? "Can't do it: “\(note ?? "")”. Goes to \(agent) in a few seconds." : "Done \(time)\(note == nil ? "" : " with a note"). Goes to \(agent) in a few seconds."
  }
  static let undo = "Undo"
  static func cantSent(note: String?, agent: String, withReply: Bool) -> String { "Can't do it: “\(note ?? "")” Sent to \(agent)\(withReply ? " with your reply" : "")." }
  static func sawItDone(_ agent: String, at time: String) -> String { "\(agent) saw it done, \(time)." }
  static func sawItDoneWithNote(_ agent: String, at time: String) -> String { "\(agent) saw it done, \(time). Your note went with your reply." }
  static func markedDone(at time: String, note: Bool, agent: String, withReply: Bool) -> String { "You marked it done, \(time)\(note ? " with a note" : ""). Sent to \(agent)\(withReply ? " with your reply" : "")." }
  static func setAsideLine(_ agent: String) -> String { "Set aside when you marked the thread read. \(agent) was told not to wait." }
  static func replacedLine(_ agent: String) -> String { "\(agent) replaced this action item." }
  static let closedLine = "Closed when the thread was archived."
  static func doneTask(_ task: String) -> String { "Done: \(task)" }

  // MARK: A permission prompt (packages/inbox/components/PermissionCard.tsx: every word here is the window's)
  static let permWaiting = "waiting"
  static func permMinutes(_ n: Int) -> String { " · \(n) min" }
  static func asksPermission(_ agent: String, to what: String) -> String { "\(agent) asks permission to \(what)" }
  static let lookingFor = "Looking for:"
  static let alsoInRequest = "Also in the request:"
  static let outsideSandbox = "Runs outside the sandbox"
  static let runsIn = "Runs in"
  static let linksTo = "Links to"
  static let host = "Host:"
  static func lines(_ n: Int) -> String { n == 1 ? "1 line" : "\(n) lines" }
  static func fileFacts(kind: String, lines all: [String]) -> String {
    let count = lines(all.count)
    switch kind {
    case "new": return "New file, \(count)"
    case "overwrite": return "Replaces the whole file, \(count)"
    case "write", "cell": return count
    default:
      let changes = "\(all.filter { $0.hasPrefix("-") }.count) removed, \(all.filter { $0.hasPrefix("+") }.count) added"
      return kind == "diff-all" ? "\(changes), every occurrence" : changes
    }
  }
  static func showMoreLines(_ n: Int) -> String { n == 1 ? "Show 1 more line" : "Show \(n) more lines" }
  static let showLess = "Show less"
  static let denyWithReason = "Deny with a reason"
  static func tellWhatInstead(_ who: String) -> String { "Tell \(who) what to do instead" }
  static func whyYouDeny(_ who: String) -> String { "Why you deny this, for \(who)" }
  static let denyAndSend = "Deny and send"
  static let orAllowAndSwitch = "Or allow and switch to"
  static let autoMode = "Auto mode"
  static let fullPermissions = "Full permissions"
  static let switchToFull = "Switch this session to Full permissions?"
  static func switchToFullDetail(_ agent: String) -> String { "\(agent) will run commands, edit files and open pages without asking, until this session ends." }
  static let allowAndSwitch = "Allow and switch"
  static func youChose(_ label: String) -> String { "You chose \(label)" }
  static let notAnswered = "Not answered"
  static let noLongerWaiting = "No longer waiting"
  static func youSaid(_ reason: String) -> String { "You said: “\(reason)”" }
  /// PermissionCard.tsx:444.
  static let answerNotSent = "Your answer was not sent. Try again."
  /// Flow check answer-12.
  static let replaced = "Replaced"
  /// Flow check answer-10.
  static let cantBeUndone = "Can't be undone"
  /// SPEC 1.9: a question kind this app does not know.
  static let answerOnComputer = "Answer this one on your computer"
  static let done = "Done"
  static let selected = "Selected"

  // MARK: Comments on files (FLOWS 7; every one is the window's own word)
  /// packages/inbox/components/ImageAttachmentView.tsx, HtmlPageComment.tsx: the button that keeps a comment.
  static let comment = "Comment"
  /// packages/inbox/components/AttachmentPane.tsx:264, the field over a selection or a line.
  static let commentOnThis = "Comment on this…"
  /// packages/inbox/components/ImageAttachmentView.tsx:370.
  static let commentOnImage = "Comment on this image…"
  /// The same field once something is drawn on the picture.
  static let whatShouldChange = "What should change?"
  /// packages/inbox/components/HtmlPageComment.tsx:384.
  static let commentOnPage = "Comment on this page…"
  /// packages/inbox/components/ImageAttachmentView.tsx:393.
  static let markUp = "Mark up"
  /// apps/mobile/contract/flows/07-attachment.md: the page's two modes ("Comment" and "Use the page").
  static let useThePage = "Use the page"
  /// packages/inbox/components/AnnotationsChip.tsx: "Edit the comment", "No comments", and Remove.
  static let editComment = "Edit the comment"
  static let remove = "Remove"
  static let noComments = "No comments"
  /// packages/inbox/components/Thread.tsx: a comment the computer would not keep.
  static let commentNotSaved = "The comment was not saved."
  /// The editor's line for a change to a comment that already went in a Send (the owner's words, 2026-11-21; the
  /// window has no such race: its comments go with the Send pressed there).
  static let commentAlreadySent = "Not saved. This comment was already sent."
  /// packages/inbox/components/AnnotationsChip.tsx: a comment whose place in the file is lost (it goes with its quote).
  static let unanchored = "Unanchored"
  /// A comment whose drawing can reach the computer only on its own network (the relay carries no drawing). The
  /// owner's words; the window runs on the computer and has no such state.
  static let needsNetwork = "Needs your computer's network"
  /// The thread's line for the comments sent while their drawing could not go: each goes by itself once it can.
  static func commentsNeedNetwork(_ n: Int) -> String { "\(CountWords.comments(n)) \(n == 1 ? "needs" : "need") your computer's network" }
  /// packages/ui/components/Viewer.tsx: a comment on the whole document.
  static let globalComment = "Global comment"
  /// packages/inbox/components/Markup.tsx `markupToast`: a drawing added to the reply.
  static let markupAdded = "Markup added to your reply"
  static let addedToReply = "Added to your reply"
  static let markupAddedSpoken = "Markup added to your reply."
  /// packages/inbox/components/AttachmentPane.tsx, the panel's foot: what rides the next Send, comments for
  /// annotations.
  static func commentsRide(_ n: Int, agent: String, elsewhere: Int) -> String {
    let lead = "\(CountWords.comments(n)) \(n == 1 ? "rides" : "ride") your next Send to \(agent)."
    return elsewhere > 0 ? "\(lead) \(elsewhere) \(elsewhere == 1 ? "is" : "are") on other files." : lead
  }

  /// VoiceOver's state for a task box in a document (it cannot be ticked here).
  static let taskTicked = "Checked"
  static let taskOpen = "Not checked"

  // MARK: Files (FLOWS 7; the window's file viewer)
  /// apps/mobile/contract/flows/07-attachment.md: "File 2 of 4".
  static func filePlace(_ at: Int, of count: Int) -> String { "File \(at) of \(count)" }
  /// flows/07: the More menu's Share.
  static let share = "Share"
  /// packages/inbox/components/CopyFileButton.tsx.
  static let copyFile = "Copy file"
  /// The window's tile menu (parity ledger files-068).
  static let copyImage = "Copy image"
  /// packages/inbox/components/AttachmentPane.tsx:2235, the note over a file that is not what was sent.
  static let fileChanged = "Changed since sent"
  static let fileShowingSent = "Showing the sent version"
  static let fileGone = "The file is gone; showing the sent copy"
  static let fileOtherKind = "The file is not that kind any more; showing the sent copy"
  /// A tile's short words for a file that cannot be opened as it is now (packages/inbox/components/ArtifactsView.tsx).
  static let fileNoLongerOnDisk = "No longer on disk"
  static let fileChangedType = "Changed type"
  /// packages/inbox/components/versionLineWords.ts.
  static let viewSent = "View sent version"
  static let viewCurrent = "View current file"
  /// packages/inbox/components/ReferencedFilePane.tsx, after the file's name.
  static func fileTooLarge(_ name: String) -> String { "\(name) is too large to show here." }
  static func fileNotShown(_ name: String) -> String { "\(name) does not show here." }
  /// An alert in a document, by its kind (`> [!NOTE]`).
  static func alert(_ kind: String) -> String { kind.prefix(1).uppercased() + kind.dropFirst() }
}
