import Foundation
import InboxWire

/// One reply of a Send: the agent message it answers and the saved picks it sends.
public struct SendTarget: Hashable, Sendable {
  public var message: MessageID
  public var questions: [DoorQuestionPick]
}

/// The replies one Send makes: one per agent session it answers, in thread order, the person's words riding the
/// last one, which goes to the agent that wrote most recently. This is the window's rule (`sendTargetsOf`,
/// packages/inbox/sendTargets.ts), without its hand-off and took-over cases; the door's one-call Send (brief F4)
/// replaces it.
public enum SendPlan {
  static func group(of message: InboxMessageWire) -> String {
    if let session = message.author.session, !session.isEmpty { return "session:\(message.author.host ?? "")/\(session)" }
    return "message:\(message.id.rawValue)"
  }

  public static func targets(in thread: InboxThread) -> [SendTarget] {
    struct Group { var message: InboxMessageWire; var picks: [(MessageID, InboxQuestion)] }
    var groups: [String: Group] = [:]
    var order: [String] = []
    let agents = thread.messages.filter { $0.author.kind == .agent }
    for message in agents {
      let picked = (message.questions ?? []).filter { $0.state == .picked }
      if picked.isEmpty { continue }
      let key = group(of: message)
      if groups[key] == nil { order.append(key) }
      var entry = groups[key] ?? Group(message: message, picks: [])
      entry.picks.append(contentsOf: picked.map { (message.id, $0) })
      // The reply answers the latest message of the session it touches.
      entry.message = message
      groups[key] = entry
    }
    let position = Dictionary(uniqueKeysWithValues: thread.messages.enumerated().map { ($1.id, $0) })
    var targets = order.compactMap { groups[$0] }
      .sorted { (position[$0.message.id] ?? 0) < (position[$1.message.id] ?? 0) }
      .map { entry in
        SendTarget(
          message: entry.message.id,
          // An answer on the reply's own message names no message (the route's default).
          questions: entry.picks.map { DoorQuestionPick(messageId: $0.0 == entry.message.id ? nil : $0.0, key: $0.1.key, revision: $0.1.revision) })
      }
    guard let latest = agents.last else { return [] }
    if let own = groups[group(of: latest)], let index = targets.firstIndex(where: { $0.message == own.message.id }) {
      targets.append(targets.remove(at: index))
    } else {
      targets.append(SendTarget(message: latest.id, questions: []))
    }
    return targets
  }

  /// Whether a Send has anything to carry: words, or at least one saved pick.
  public static func hasSomethingToSend(thread: InboxThread, words: String) -> Bool {
    if !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
    return targets(in: thread).contains { !$0.questions.isEmpty }
  }
}
