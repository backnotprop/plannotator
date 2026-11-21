import Foundation
import InboxWire

/// The one toast after a row action, as the window words it (packages/inbox/components/Toast.tsx). A phone shows
/// `phoneLead` and `phoneDetail` where the window has them: the news first, a name last, so a cut only eats the name.
public struct ToastWords: Hashable, Sendable {
  /// The mark before the words (the window's `icon`).
  public enum Mark: String, Hashable, Sendable { case check, archive, clock, unread, unstar, warn }

  public var mark: Mark
  public var lead: String
  public var phoneLead: String?
  public var detail: String?
  public var phoneDetail: String?
  /// An agent was stopped or held up on the thread.
  public var warn: Bool
  /// An error, or a bulk action some rows refused: the words wrap, never cut.
  public var wraps: Bool
  /// What a screen reader is told instead of the lead and detail, when they are cut or terse.
  public var speech: String?

  public init(mark: Mark, lead: String, phoneLead: String? = nil, detail: String? = nil, phoneDetail: String? = nil, warn: Bool = false, wraps: Bool = false, speech: String? = nil) {
    self.mark = mark
    self.lead = lead
    self.phoneLead = phoneLead
    self.detail = detail
    self.phoneDetail = phoneDetail
    self.warn = warn
    self.wraps = wraps
    self.speech = speech
  }

  /// What the phone shows.
  public var shownLead: String { phoneLead ?? lead }
  public var shownDetail: String? { phoneDetail ?? detail }
  /// What a screen reader hears: the window's own sentence, else the lead and the detail.
  public var spoken: String { speech ?? [lead, detail].compactMap { $0 }.joined(separator: ". ") }
}

/// Every word the window says after a row action, with where it comes from. Each function is the window's own, and
/// apps/mobile/contract/vectors/acts.json and rows.json hold the cases (scripts/mobile/vectors-actions.ts runs the
/// window's functions). With PhoneWords and CountWords, the only place that writes a visible word.
public enum ActionWords {
  /// `INBOX_AGENT_NAME_SHORT_MAX`.
  public static let shortNameMax = 40
  /// `INBOX_UNREACHABLE` (packages/inbox/toastError.ts).
  public static let unreachable = "The Inbox did not answer. Try again in a moment."
  /// The fallbacks of the window's error toasts (packages/inbox/App.tsx, bulkWrites.ts).
  public static let threadDidNotChange = "The thread did not change."
  public static let threadsDidNotChange = "The threads did not change."
  public static let someDidNotMoveBack = "Some threads did not move back."
  /// packages/inbox/snoozeWrites.ts, the Inbox's `snooze_past`.
  public static let timePassed = "That time has passed."
  /// What the window says in its live region after an Undo (packages/inbox/App.tsx, snoozeWrites.ts, priorityWrites.ts).
  public static let movedBack = "Moved back."
  public static let unarchivedSaid = "Unarchived."
  public static let unsnoozedSaid = "Unsnoozed."
  public static let snoozeMovedBack = "Snooze moved back."
  public static let removedFromPriorityAgain = "Removed from Priority again."
  public static let backInPriority = "Back in Priority."

  /// `formatCount`: "1,284".
  static func count(_ n: Int) -> String { CountWords.count(n) }
  /// `plural`: "1 thread", "1,284 threads".
  static func plural(_ n: Int, _ one: String) -> String { "\(count(n)) \(n == 1 ? one : "\(one)s")" }

  /// A row's subject as a toast names it: `“${row.subject ?? '(no subject)'}”`. A row with a name and no subject
  /// is named by its name, as the list draws it: the toast never says "(no subject)" of a row that shows one.
  public static func subject(_ row: InboxListRow?) -> String { row?.subject ?? row?.threadName ?? "(no subject)" }
  static func quoted(_ row: InboxListRow?) -> String { "“\(subject(row))”" }

  /// `agentName` (packages/core/inbox-types.ts `inboxAgentName`).
  public static func agent(_ author: InboxAuthor) -> String {
    if let name = author.name, !name.isEmpty { return name }
    if let host = author.host, !host.isEmpty { return Words.agents[host] ?? host }
    return "An agent"
  }

  /// `shortAgentName`: whole up to 40 characters as a person counts them, else cut with "…", at the last space when
  /// one is near, with no bracket or dash left hanging.
  public static func shortName(_ name: String, max: Int = shortNameMax) -> String {
    let text = name.trimmingCharacters(in: .whitespacesAndNewlines).split(whereSeparator: \.isWhitespace).joined(separator: " ")
    let parts = Array(text)
    if parts.count <= max { return text }
    let kept = Array(parts.prefix(max - 1))
    let space = kept.lastIndex(of: " ") ?? -1
    var cut = space >= Int((Double(max - 1) * 0.8).rounded(.down)) ? Array(kept.prefix(space)) : kept
    let hanging: Set<Character> = ["(", "[", "{", "-", "–", "—", ",", ":", ";", "."]
    while let last = cut.last, last.isWhitespace || hanging.contains(last) { cut.removeLast() }
    return String(cut) + "…"
  }

  // MARK: Mark read, Mark unread (packages/inbox/markRead.ts)

  /// `MarkReadPlace`: where the thread was when the person marked it.
  public enum Place: String, Hashable, Sendable {
    /// The thread open on screen.
    case open
    /// A row the list holds still: it has not moved.
    case held
    /// The row has moved.
    case list
  }

  /// `markReadToast`, from the row as it was before.
  public static func markedRead(_ before: InboxListRow, place: Place) -> ToastWords {
    let subject = quoted(before)
    let warn = before.questions.stopped || !before.questions.holdsUp.isEmpty
    if place == .held { return ToastWords(mark: warn ? .warn : .check, lead: "Marked read", phoneLead: "Read", detail: subject, warn: warn) }
    if before.questions.stopped {
      let name = agent(before.author)
      let short = shortName(name)
      return ToastWords(mark: .warn, lead: "Marked read", phoneLead: "Read", detail: "\(short) was stopped", phoneDetail: "Stopped · \(short)", warn: true, speech: short != name ? "Marked read. \(name) was stopped." : nil)
    }
    if !before.questions.holdsUp.isEmpty {
      return ToastWords(mark: .warn, lead: "Marked read", phoneLead: "Read", detail: "Held up \(plural(before.questions.holdsUp.count, "thing"))", warn: true)
    }
    let archived = before.resolvedAt != nil
    let kept = !archived && before.unsent.map { $0.replyAt != nil || $0.comments > 0 } == true
    if kept { return ToastWords(mark: .check, lead: "Marked read", phoneLead: "Read", detail: place == .open ? "Your draft keeps it in New" : "\(subject) · your draft keeps it in New") }
    if place == .open { return ToastWords(mark: .check, lead: "Marked read", phoneLead: "Read", detail: archived ? "Goes back to Archived" : "Moves to Quiet") }
    return ToastWords(mark: .check, lead: archived ? "Back in Archived" : "Moved to Quiet", detail: subject)
  }

  /// `markUnreadToast`. `moved`: the row is back in New now.
  public static func markedUnread(_ before: InboxListRow?, moved: Bool) -> ToastWords {
    let subject = quoted(before)
    return ToastWords(mark: .unread, lead: "Marked unread", detail: moved ? "\(subject) · back in New" : subject)
  }

  /// `SetAsideCount`, and `setAsideCount` over several rows.
  public struct SetAside: Hashable, Sendable {
    public var questions: Int
    public var actions: Int
    public var threads: Int
    public init(questions: Int, actions: Int, threads: Int) {
      self.questions = questions
      self.actions = actions
      self.threads = threads
    }
    public init(_ rows: [InboxListRow]) {
      questions = 0
      actions = 0
      threads = 0
      for row in rows {
        let aside = RowOffers.setAside(row)
        if aside.questions + aside.actions == 0 { continue }
        questions += aside.questions
        actions += aside.actions
        threads += 1
      }
    }
    /// `warnsBeforeRead`, with the warning on.
    public var warns: Bool { questions + actions > 0 }
  }

  /// `setAsideWarning`: the warning before a Mark read that closes questions unanswered. `bulk`: several rows at once.
  public static func setAsideWarning(_ count: SetAside, bulk: Bool) -> (title: String, body: String, go: String) {
    let what = count.actions == 0 ? plural(count.questions, "open question") : count.questions == 0 ? plural(count.actions, "action item") : "\(plural(count.questions, "open question")) and \(plural(count.actions, "action item"))"
    let them = count.questions + count.actions == 1 ? "it" : "them"
    let agent = count.threads > 1 ? "the agents" : "the agent"
    if !bulk { return ("Set aside \(what)?", "Mark read closes \(them) unanswered and tells \(agent) not to wait on \(them).", "Mark read") }
    return ("Set aside \(what)?", "Mark all as read closes \(them) unanswered in \(plural(count.threads, "thread")) and tells \(agent) not to wait on \(them).", "Mark all as read")
  }

  // MARK: Archive, snooze, star, Priority (packages/inbox/App.tsx, snoozeWrites.ts, pins.ts, priorityWrites.ts)

  /// Archive's toast. `named`: from a row, so the subject says which thread.
  public static func archived(_ before: InboxListRow?, named: Bool) -> ToastWords {
    ToastWords(mark: .archive, lead: "Archived", detail: named ? quoted(before) : nil)
  }

  /// Unarchive's toast (packages/inbox/data/actions/archivedGroup.ts).
  public static func unarchived(_ before: InboxListRow?) -> ToastWords {
    ToastWords(mark: .check, lead: "Back in your Inbox", detail: subject(before))
  }

  public static func snoozed(_ before: InboxListRow?, when: String) -> ToastWords {
    ToastWords(mark: .clock, lead: "Snoozed", detail: when, speech: "Snoozed \(quoted(before)) until \(when).")
  }

  public static func unsnoozed(_ before: InboxListRow?) -> ToastWords {
    ToastWords(mark: .clock, lead: "Unsnoozed", speech: "Unsnoozed \(quoted(before)).")
  }

  /// `unpinnedWhere`: where an unstarred thread still is.
  public static func unpinnedWhere(_ row: InboxListRow?) -> String {
    guard let row else { return "Still in the Inbox" }
    if ListRules.archived(row) { return "Still in Archived" }
    return Words.sections[row.section.rawValue].map { "Still in \($0)" } ?? "Still in the Inbox"
  }

  public static func unstarred(_ before: InboxListRow?) -> ToastWords {
    let place = unpinnedWhere(before)
    return ToastWords(mark: .unstar, lead: "Unstarred", detail: place, speech: "Unstarred \(quoted(before)). \(place).")
  }

  /// What the window says in its live region for a new star.
  public static func starredSaid(_ row: InboxListRow?) -> String { "Starred \(quoted(row))" }

  /// `priorityBackIn`: the group a row goes back to when it leaves Priority.
  public static func priorityBackIn(_ row: InboxListRow?) -> String? {
    guard let row else { return nil }
    switch RowOffers.backIn(row) {
    case .archived: return "Back in Archived"
    case .snoozed: return "Back in \(Words.groupSnoozed)"
    case let group: return Words.sections[group.rawValue].map { "Back in \($0)" }
    }
  }

  public static func priorityAdded(_ before: InboxListRow?) -> ToastWords {
    ToastWords(mark: .check, lead: "Added to Priority", detail: quoted(before), speech: "Added \(quoted(before)) to Priority.")
  }

  public static func priorityRemoved(_ before: InboxListRow?) -> ToastWords {
    let back = priorityBackIn(before)
    return ToastWords(mark: .check, lead: "Removed from Priority", detail: back, speech: "Removed \(quoted(before)) from Priority.\(back.map { " \($0)." } ?? "")")
  }

  /// Copy link and Copy thread ID (packages/inbox/App.tsx): `copied` nil when the copy failed.
  public static func copied(link: Bool, _ row: InboxListRow?, ok: Bool) -> ToastWords {
    ok ? ToastWords(mark: .check, lead: link ? "Link copied" : "Thread ID copied", detail: quoted(row)) : ToastWords(mark: .warn, lead: "Couldn't copy")
  }

  /// Several acts were not taken (acts that waited on the phone, sent together when the computer was back): how
  /// many, with the first one's reason, in the words a bulk action's toast uses for its refusals.
  public static func didNotChange(_ count: Int, why: String) -> ToastWords {
    ToastWords(mark: .warn, lead: "\(self.count(count)) did not change: \(why)", wraps: true)
  }

  /// An error's toast: the words wrap, and a screen reader hears them whole.
  public static func failed(_ words: String) -> ToastWords { ToastWords(mark: .warn, lead: words, wraps: true) }

  // MARK: Several rows at once (packages/inbox/bulkWrites.ts)

  static func bulkLead(_ action: BulkAction, _ n: String) -> String {
    switch action {
    case .archive: return "Archived \(n)"
    case .snooze: return "Snoozed \(n)"
    case .read: return "Marked \(n) read"
    case .unread: return "Marked \(n) unread"
    case .star: return "Starred \(n)"
    case .unstar: return "Unstarred \(n)"
    case .priorityAdd: return "Added \(n) to Priority"
    case .priorityRemove: return "Removed \(n) from Priority"
    }
  }

  /// What a phone says of the rows of a bulk action that were refused: "1 not archived", with no reason.
  static func bulkNot(_ action: BulkAction, _ n: Int) -> String {
    switch action {
    case .archive: return "\(n) not archived"
    case .snooze: return "\(n) not snoozed"
    case .read: return "\(n) not marked read"
    case .unread: return "\(n) not marked unread"
    case .star: return "\(n) not starred"
    case .unstar: return "\(n) not unstarred"
    case .priorityAdd: return "\(n) not added"
    case .priorityRemove: return "\(n) not removed"
    }
  }

  /// `bulkToast`: "Archived 3 threads" ("Archived 3" on a phone), "Archived 2 of 3 threads" when some were refused
  /// with the first refusal's words, and how many wait for a computer that is away. Nil when nothing was made.
  /// A phone says the refused ones without the reason: "Archived 2 · 1 not archived".
  /// `heldOn`: the computers the held ones wait for. `refusal`: the first refusal's own words, if it has any.
  public static func bulk(_ action: BulkAction, made: Int, held: Int = 0, heldOn: [String] = [], refused: Int = 0, refusal: String? = nil, detail: String? = nil) -> ToastWords? {
    guard made > 0 else { return nil }
    let total = made + refused
    let counted = refused > 0 ? "\(count(made)) of \(plural(total, "thread"))" : plural(made, "thread")
    var parts: [String] = []
    if let detail { parts.append(detail) }
    if held > 0 {
      let names = Set(heldOn)
      parts.append(names.count == 1 ? "\(held) when \(heldOn[0]) is back" : "\(held) when their machines are back")
    }
    let shared = parts
    if refused > 0 { parts.append("\(refused) did not change: \(refusal.flatMap { $0.isEmpty ? nil : $0 } ?? "It didn’t go.")") }
    let mark: ToastWords.Mark = refused > 0 ? .warn : action == .archive ? .archive : action == .snooze ? .clock : action == .unread ? .unread : .check
    var words = ToastWords(mark: mark, lead: bulkLead(action, counted), phoneLead: bulkLead(action, String(made)), detail: parts.isEmpty ? nil : parts.joined(separator: " · "), wraps: refused > 0)
    if refused > 0 {
      let phone = shared + [bulkNot(action, refused)]
      words.phoneDetail = phone.joined(separator: " · ")
      words.speech = ([bulkLead(action, plural(made, "thread"))] + phone).joined(separator: ". ") + "."
    }
    return words
  }

  // MARK: Copy link (packages/inbox/rowMenu.ts `threadLink`)

  /// The thread's address as a device that is not the computer copies it: the address it reaches the computer by,
  /// plus `#thread=<id>`.
  public static func threadLink(_ thread: ThreadID, origin: String) -> String {
    "\(origin.hasSuffix("/") ? origin : "\(origin)/")#thread=\(thread.rawValue)"
  }

  /// The address this phone reaches the computer by, for a link: the tailnet's name first (it opens from anywhere
  /// on the tailnet), else the Wi-Fi address. Nil for a computer with no address (the stand-in).
  public static func origin(of computer: PairedComputer) -> String? {
    let tailnet = computer.addresses.first { if case .tailnet = $0 { return true }; return false }
    return (tailnet ?? computer.addresses.first).map { "https://\($0.hostPort)" }
  }
}
