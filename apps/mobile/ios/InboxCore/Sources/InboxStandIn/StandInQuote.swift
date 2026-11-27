import Foundation
import InboxCore
import InboxWire

/// A reply's quote on the stand-in computer, as the Inbox's store plans it (packages/shared/inbox/store.ts
/// `planQuote`): checked before anything is written; none on a reply that carries no words of the person's; whose
/// message it is ("your" for the session the reply goes to, "my" for the person's, else the other agent named by
/// its host, or "another agent"); the whole message quoted as its excerpt, or its first question when it has none;
/// the time as the phone said it, else the message's own.
extension StandInDoor {
  enum QuotePlan {
    case none
    case refused(DoorAnswerBytes)
    case lead(InboxReplyQuote, String)
  }

  /// The most characters of selected words a quote may hold (`INBOX_MESSAGE_COMMENT_QUOTE_MAX`).
  static let quoteWordsMax = 20_000

  func quoteLead(_ raw: JSONValue?, thread t: Int, to asked: InboxMessageWire, words: String) -> QuotePlan {
    guard let raw, raw != .null else { return .none }
    guard case .object(let quote) = raw else { return .refused(refuse(422, "validation_error", "quote: { of, words? }.", field: "quote")) }
    guard case .string(let of)? = quote["of"], of.hasPrefix("msg_") else { return .refused(refuse(422, "validation_error", "quote.of: a message id.", field: "quote.of")) }
    guard let target = threads[t].messages.first(where: { $0.id.rawValue == of }), !(target.author.kind == .person && !(target.ackOf ?? "").isEmpty) else {
      return .refused(refuse(422, "validation_error", "quote.of: a message of this thread.", field: "quote.of"))
    }
    var selected: String?
    if let given = quote["words"] {
      guard case .string(let text) = given, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, text.utf16.count <= Self.quoteWordsMax else {
        return .refused(refuse(422, "validation_error", "quote.words: the words selected, at most \(Self.quoteWordsMax) characters.", field: "quote.words"))
      }
      selected = text
    }
    if words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return .none }
    let session = asked.author.kind == .agent ? asked.author.session : nil
    let whose: ReplyQuoteRules.Whose =
      target.author.kind == .person ? .mine
      : session != nil && target.author.session == session ? .yours
      : .theirs(target.author.host.flatMap { Words.hosts[$0] } ?? "another agent")
    let excerpt = selected
      ?? ReplyQuoteRules.excerpt(person: target.author.kind == .person, body: target.body).nonEmpty
      ?? (target.questions ?? []).first?.prompt ?? ""
    var time: String?
    if case .string(let said)? = quote["time"] { time = said }
    let at = ReplyQuoteRules.leadTime(time).nonEmpty ?? TimeWords().when(target.createdAt)
    let lead = ReplyQuoteRules.lead(whose: whose, id: of, time: at, text: excerpt, selected: selected != nil)
    return .lead(InboxReplyQuote(of: of, words: selected), lead)
  }
}

extension String {
  fileprivate var nonEmpty: String? { isEmpty ? nil : self }
}
