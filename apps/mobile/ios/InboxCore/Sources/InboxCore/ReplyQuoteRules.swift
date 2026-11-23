import Foundation
import InboxWire

/// A reply that quotes a message (approval "inbox-reply-quote"), the window's rules
/// (packages/core/inbox-reply-quote.ts, packages/inbox/replyQuote.ts), held to them by vectors/quote.json.
///
/// The Inbox writes a lead the agent reads in front of the person's words ("Replying to your message from 10:04 AM
/// (msg_…):" and the quoted text as `> ` lines, then a blank line). The phone draws the quote as one quiet line
/// instead and leaves the lead out of the reply's words, as the window does.
public enum ReplyQuoteRules {
  /// ↩ with nothing selected quotes the message only when an agent wrote after it; on the newest agent message (or
  /// the person's own newest) it is a plain Reply (`arrowQuotesWhole`).
  public static func quotesWhole(_ messages: [InboxMessageWire], _ id: MessageID) -> Bool {
    guard let at = messages.firstIndex(where: { $0.id == id }) else { return false }
    return messages[(at + 1)...].contains { $0.author.kind == .agent }
  }

  /// What ↩ on a message does to the reply box (the window's `arrowReply`, packages/inbox/replyQuote.ts).
  public struct Arrow: Hashable, Sendable {
    /// The quote the box holds after it; nil inside: none (a quote there is dropped).
    public var quote: DraftQuote??
    /// The agent session the reply is aimed at, when the message is an agent's.
    public var aim: String?
  }

  /// With words selected in the message, those words; else the whole message when an agent wrote after it; else a
  /// plain Reply, and a quote already in the box is dropped. `quoted`: whether the box quotes a message now.
  public static func arrow(_ messages: [InboxMessageWire], at id: MessageID, words: String?, quoted: Bool) -> Arrow {
    let message = messages.first { $0.id == id }
    let aim = message.flatMap { $0.author.kind == .agent ? $0.author.session : nil }
    if let words, !words.isEmpty { return Arrow(quote: .some(DraftQuote(of: id, words: words)), aim: aim) }
    if quotesWhole(messages, id) { return Arrow(quote: .some(DraftQuote(of: id)), aim: aim) }
    return Arrow(quote: quoted ? .some(nil) : nil, aim: aim)
  }

  /// A person's reply body without the lead the Inbox wrote: at its start, or right after the store's first line
  /// ("Answered 1 question.", "Did 1 action item."). The body as it is when there is none (`withoutInboxReplyQuoteLead`).
  public static func withoutLead(_ body: String) -> String {
    if let rest = afterLead(body) { return rest }
    guard let sentence = body.prefixMatch(of: firstSentence) else { return body }
    let head = String(body[sentence.range])
    guard let rest = afterLead(String(body[sentence.range.upperBound...])) else { return body }
    return head + rest
  }

  /// Whose message a lead names, as the agent reading the reply is told.
  public enum Whose: Sendable, Equatable {
    case yours, mine
    case theirs(String)
  }

  /// The lead the Inbox writes (`inboxReplyQuoteLead`); the stand-in computer writes it as the Inbox does.
  public static func lead(whose: Whose, id: String, time: String?, text: String, selected: Bool) -> String {
    let named: String
    switch whose {
    case .yours: named = "your message"
    case .mine: named = "my message"
    case .theirs(let name):
      let one = oneLine(name, max: 60)
      named = "\(one.isEmpty ? "another agent" : one)'s message"
    }
    let at = leadTime(time)
    let head = ["Replying to", selected ? "these words in" : nil, named, at.isEmpty ? nil : "from \(at)", "(\(id))"].compactMap { $0 }.joined(separator: " ")
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? "\(head)." : "\(head):\n\(quoteLines(trimmed))"
  }

  /// A time a lead may print: one short line of letters, digits, spaces and , : . (else "").
  public static func leadTime(_ value: String?) -> String {
    guard let value else { return "" }
    let line = value.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
      .split(whereSeparator: \.isWhitespace).joined(separator: " ")
    guard !line.isEmpty, line.utf16.count <= 40 else { return "" }
    return line.unicodeScalars.allSatisfy { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) || " ,:.".unicodeScalars.contains($0) } ? line : ""
  }

  private static func oneLine(_ value: String, max: Int) -> String {
    let flat = value.unicodeScalars.filter { $0.properties.generalCategory != .format }
      .map { CharacterSet.controlCharacters.contains($0) || $0.properties.generalCategory == .lineSeparator || $0.properties.generalCategory == .paragraphSeparator ? " " : String($0) }
      .joined().split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return flat.count > max ? String(flat.prefix(max)).trimmingCharacters(in: .whitespaces) + "…" : flat
  }

  private static func quoteLines(_ text: String) -> String {
    let cut = text.count > 2000 ? String(text.prefix(2000)).replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression) + "…" : text
    return cut.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
      .split(separator: "\n", omittingEmptySubsequences: false)
      .map { line -> String in
        var kept = String(line.unicodeScalars.map { CharacterSet.controlCharacters.contains($0) ? " " : String($0) }.joined())
        while kept.last?.isWhitespace == true { kept.removeLast() }
        return kept.isEmpty ? ">" : "> \(kept)"
      }
      .joined(separator: "\n")
  }

  /// The words after a lead at the very start, its blank lines dropped; nil when the body opens with none.
  static func afterLead(_ text: String) -> String? {
    guard let match = text.prefixMatch(of: leadHead) else { return nil }
    var rest = text[match.range.upperBound...]
    while rest.first == "\n" { rest = rest.dropFirst() }
    return String(rest)
  }

  // The lead's words (INBOX_REPLY_QUOTE_LEAD): "Replying to", "these words in", "your message", "my message",
  // "<name>'s message", "from".
  nonisolated(unsafe) private static let leadHead: Regex<AnyRegexOutput> = {
    let theirs = "[^\\n]{1,64}'s message"
    let whose = "(?:your message|my message|\(theirs))"
    let pattern = "Replying to (?:these words in )?\(whose)(?: from [^\\n]{1,40})? \\((msg_[A-Za-z0-9]+)\\)(?::\\n(?:>[^\\n]*(?:\\n|$))+|\\.(?:\\n|$))"
    // A literal pattern: it compiles.
    return try! Regex(pattern)
  }()

  nonisolated(unsafe) private static let firstSentence: Regex<AnyRegexOutput> = try! Regex("^(?:Answered|Skipped|Did|Couldn't do) \\d+ [^\\n]*\\.\\n\\n")
}
