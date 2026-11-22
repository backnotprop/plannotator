import Foundation
import InboxWire

/// One reply of a Send: the agent message it answers, the saved picks it sends, and the action items whose mark
/// waits in the draft.
public struct SendTarget: Hashable, Sendable {
  public var message: MessageID
  public var questions: [DoorQuestionPick]
  public var actions: [DoorReplyBodyActionsItem] = []
}

/// The replies one Send makes: one per agent session it answers, in thread order, the person's words riding the
/// last one. This is the window's rule (`sendTargetsOf` and `wordsMessage`, packages/inbox/sendTargets.ts:86-157),
/// kept here only until the door's one-call Send (brief F4) makes the computer decide it.
///
/// Two of the window's cases are not copied: a thread handed to another session (`activeHandoff`,
/// packages/inbox/tags.ts:221) and one a session took over (`tookOverReply`, sendTargets.ts:124). For those
/// `needsComputer` is true and the phone does not send.
public enum SendPlan {
  /// `INBOX_PERMISSION_SESSION_PREFIX` (packages/core/inbox-permission.ts:23): a permission prompt's own session.
  static let permissionSessionPrefix = "perm:"

  public static func isPermissionPrompt(_ message: InboxMessageWire) -> Bool {
    message.author.kind == .agent && (message.author.session ?? "").hasPrefix(permissionSessionPrefix)
  }

  /// `liveMessage` (packages/inbox/components/Thread.tsx): in an archived thread, only what an agent wrote after
  /// the archive line is still live (its action items can be marked); everything before it is read only.
  public static func live(_ message: InboxMessageWire, in thread: InboxThread) -> Bool {
    guard thread.resolvedAt != nil else { return true }
    guard let line = thread.archiveSeq else { return false }
    return (message.seq ?? 0) > line
  }

  static func group(of message: InboxMessageWire) -> String {
    if let session = message.author.session, !session.isEmpty { return "session:\(message.author.host ?? "")\u{0}\(session)" }
    return "message:\(message.id.rawValue)"
  }

  /// `inboxActionInDraft` (packages/core/inbox-types.ts:1607): an action item whose Done or Can't do it waits in
  /// the reply draft and goes with the next Send.
  static func actionInDraft(_ action: InboxQuestion) -> Bool {
    guard action.kind == .action, let result = action.actionResult else { return false }
    if result.by == .person { return result.staged == true && action.state == .picked }
    let note = QuestionAnswers.jsTrim(result.person?.note ?? "")
    return !note.isEmpty && action.state == .closed && !(action.revision > 0 && action.sentRevision == action.revision)
  }

  /// A hand-off that still stands (`activeHandoff`, packages/inbox/tags.ts:221-229): the latest reply that handed
  /// the thread on and was not undone, unless a later reply took over from a session that ended.
  static func activeHandoff(_ thread: InboxThread) -> Bool {
    for message in thread.messages.reversed() {
      if message.author.kind == .person, let handoff = message.handoff, handoff.undoneAt == nil, message.to != nil { return true }
      if message.tookOver == true { return false }
    }
    return false
  }

  /// A reply that took over from a session that ended still holds the thread, until an agent writes again
  /// (`tookOverReply`, packages/inbox/sendTargets.ts:124-136).
  static func tookOver(_ thread: InboxThread) -> Bool {
    for message in thread.messages.reversed() {
      if message.author.kind == .agent, !(message.author.session ?? "").hasPrefix(permissionSessionPrefix), message.scheduledChange == nil { return false }
      if message.tookOver == true, message.to != nil { return true }
    }
    return false
  }

  /// While either stands, the window addresses the reply by rules this slice does not carry: it is made on the
  /// computer. Once it no longer stands, the phone sends as usual.
  public static func needsComputer(_ thread: InboxThread) -> Bool { activeHandoff(thread) || tookOver(thread) }

  /// The message the person's words answer: the latest agent message that is not a permission prompt's and not
  /// a routine's change line (`wordsMessage`, sendTargets.ts:147). A script's post (no session, no host, no name:
  /// `inboxSessionlessSend` and `inboxWordsDefault`, packages/core/inbox-delivery.ts) does not take the words from the latest agent
  /// message that has a session, unless the Send answers its own questions or action items.
  static func wordsMessage(_ thread: InboxThread) -> InboxMessageWire? {
    let agents = thread.messages.filter { $0.author.kind == .agent && !($0.author.session ?? "").hasPrefix(permissionSessionPrefix) && $0.scheduledChange == nil }
    guard let latest = agents.last else { return thread.messages.first }
    let sessionless = (latest.author.session ?? "").isEmpty && (latest.author.host ?? "").isEmpty && (latest.author.name ?? "").isEmpty
    let answered = (latest.questions ?? []).contains { $0.state == .picked && $0.kind != .action } || ActionMarks.items(of: latest).contains(where: actionInDraft)
    guard sessionless, !answered else { return latest }
    return agents.last { !($0.author.session ?? "").isEmpty } ?? latest
  }

  /// The message a reply to the agent that wrote `message` answers now: that agent session's latest message in the
  /// thread (not a permission prompt's, not a routine's change line), as a Send to that agent would; `message` itself
  /// when it has no session. Nil when the thread no longer has `message`.
  static func latest(sessionOf message: MessageID, in thread: InboxThread) -> MessageID? {
    guard let wrote = thread.messages.first(where: { $0.id == message }) else { return nil }
    let own = group(of: wrote)
    let latest = thread.messages.last { $0.author.kind == .agent && group(of: $0) == own && !isPermissionPrompt($0) && $0.scheduledChange == nil }
    return latest?.id ?? wrote.id
  }

  public static func targets(in thread: InboxThread) -> [SendTarget] {
    struct Group { var message: InboxMessageWire; var picks: [(MessageID, InboxQuestion)]; var actions: [(MessageID, InboxQuestion)] }
    var groups: [String: Group] = [:]
    var order: [String] = []
    for message in thread.messages where message.author.kind == .agent {
      let picked = (message.questions ?? []).filter { $0.state == .picked && $0.kind != .action }
      let drafted = ActionMarks.items(of: message).filter(actionInDraft)
      if picked.isEmpty && drafted.isEmpty { continue }
      let key = group(of: message)
      if groups[key] == nil { order.append(key) }
      var entry = groups[key] ?? Group(message: message, picks: [], actions: [])
      entry.picks.append(contentsOf: picked.map { (message.id, $0) })
      entry.actions.append(contentsOf: drafted.map { (message.id, $0) })
      // The reply answers the latest message of the session it touches.
      entry.message = message
      groups[key] = entry
    }
    let position = Dictionary(thread.messages.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
    var targets = order.compactMap { groups[$0] }
      .sorted { (position[$0.message.id] ?? 0) < (position[$1.message.id] ?? 0) }
      .map { entry in
        SendTarget(
          message: entry.message.id,
          // An answer on the reply's own message names no message (the route's default).
          questions: entry.picks.map { DoorQuestionPick(messageId: $0.0 == entry.message.id ? nil : $0.0, key: $0.1.key, revision: $0.1.revision) },
          actions: entry.actions.map { DoorReplyBodyActionsItem(messageId: $0.0 == entry.message.id ? nil : $0.0, key: $0.1.key) })
      }
    guard let latest = wordsMessage(thread) else { return targets }
    if let index = targets.firstIndex(where: { $0.message == latest.id }) ?? groups[group(of: latest)].flatMap({ own in targets.firstIndex { $0.message == own.message.id } }), latest.author.kind == .agent {
      targets.append(targets.remove(at: index))
    } else {
      targets.append(SendTarget(message: latest.id, questions: []))
    }
    return targets
  }

  /// Whether a Send has anything to carry: words, a saved pick, or a drafted action item.
  public static func hasSomethingToSend(thread: InboxThread, words: String) -> Bool {
    if !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
    return targets(in: thread).contains { !$0.questions.isEmpty || !$0.actions.isEmpty }
  }
}
