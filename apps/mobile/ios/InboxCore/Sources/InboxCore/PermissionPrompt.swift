import Foundation
import InboxWire

/// A started agent's permission prompt, read for its card. These are the window's rules, copied
/// (packages/core/inbox-permission.ts `readInboxPermissionBody` and `inboxPermissionCodeSpans`;
/// packages/inbox/components/PermissionCard.tsx) until the door sends the prompt in parts. Display only: the
/// decision is the question's own choice, and the computer makes it.
public struct PermissionPrompt: Hashable, Sendable {
  public struct Detail: Hashable, Sendable {
    public var text: String
    /// A path, a link or a query on one line; otherwise a command or the input, as a block.
    public var onLine: Bool
  }

  public struct Preview: Hashable, Sendable {
    /// `new`, `overwrite`, `write`, `diff`, `diff-all` or `cell`.
    public var kind: String
    public var text: String
    public var lines: [String] { text.components(separatedBy: "\n") }
    public var isDiff: Bool { kind == "diff" || kind == "diff-all" }
  }

  public var detail: Detail?
  public var preview: Preview?
  /// The input's keys the card does not draw in parts, as JSON.
  public var leftover: String?
  public var purpose: String?
  public var folder: String?
  public var unsandboxed = false
  public var linksTo: String?
  public var note: String?
  public var handoff: String?

  // TODO(contract): "permission vectors" (words rows for INBOX_PERMISSION_*). The fixed choices (packages/core/inbox-permission.ts).
  public static let allowOnce = "Allow once"
  public static let deny = "Deny"
  public static let auto = "Allow and switch to Auto mode"
  public static let full = "Allow and switch to Full permissions"
  public static let terminal = "Approve in Terminal"
  static let unsandboxedLine = "Runs outside the sandbox."
  static let previewKinds = ["new", "overwrite", "write", "diff", "diff-all", "cell", "input"]

  /// An opening fence: three or more backticks, then nothing or one of the card's own info words.
  static func openFence(_ line: String) -> (fence: String, info: String?)? {
    let ticks = line.prefix { $0 == "`" }
    guard ticks.count >= 3 else { return nil }
    let rest = String(line.dropFirst(ticks.count))
    if rest.isEmpty { return (String(ticks), nil) }
    return previewKinds.contains(rest) ? (String(ticks), rest) : nil
  }

  /// Inline code back to its text.
  static func uncode(_ text: String) -> String? {
    guard let match = text.wholeMatch(of: /(`+)(.*)\1/) else { return nil }
    let inner = String(match.2)
    return match.1.count > 1 && inner.hasPrefix(" ") && inner.hasSuffix(" ") && inner.count >= 2 ? String(inner.dropFirst().dropLast()) : inner
  }

  /// A line of the input that started `:::` was written with a zero-width space after the first colon: put it back.
  static func unbroken(_ text: String) -> String {
    text.components(separatedBy: "\n").map { line -> String in
      let lead = line.prefix { $0.isWhitespace }
      let rest = line.dropFirst(lead.count)
      return rest.hasPrefix(":\u{200B}::") ? lead + ":::" + rest.dropFirst(4) : line
    }.joined(separator: "\n")
  }

  /// Reads the body line by line, up to its own `:::question`, as the Inbox wrote it.
  public static func read(_ body: String) -> PermissionPrompt {
    let lines = body.components(separatedBy: "\n")
    let head = lines.firstIndex(of: ":::question").map { Array(lines[..<$0]) } ?? lines
    var out = PermissionPrompt()
    var i = 0
    while i < head.count {
      let line = head[i]
      if let open = openFence(line) {
        // A fence closes only on its own exact line.
        guard let close = head[(i + 1)...].firstIndex(of: open.fence) else { break }
        let text = unbroken(head[(i + 1)..<close].joined(separator: "\n"))
        if open.info == "input" { out.leftover = text } else if let kind = open.info { out.preview = Preview(kind: kind, text: text) } else { out.detail = Detail(text: text, onLine: false) }
        i = close
      } else if line == unsandboxedLine {
        out.unsandboxed = true
      } else if line.hasPrefix("in `") {
        out.folder = uncode(String(line.dropFirst(3)))
      } else if line.hasPrefix("Links to `") {
        out.linksTo = uncode(String(line.dropFirst("Links to ".count)))
      } else if line.hasPrefix("Purpose: ") {
        out.purpose = String(line.dropFirst("Purpose: ".count))
      } else if line.hasPrefix("Note: ") {
        out.note = String(line.dropFirst("Note: ".count))
      } else if line.hasPrefix("Then: ") {
        out.handoff = String(line.dropFirst("Then: ".count))
      } else if line.hasPrefix("`"), let text = uncode(line) {
        out.detail = Detail(text: text, onLine: true)
      }
      i += 1
    }
    return out
  }

  // MARK: A label's inline code

  public struct Span: Hashable, Sendable {
    public var text: String
    public var code: Bool
  }

  /// A label's text and inline code, read the way Markdown reads it: a run of N backticks opens a span that only
  /// a run of exactly N closes; a span that starts and ends with a space loses one of each.
  public static func spans(_ label: String) -> [Span] {
    let text = Array(label)
    var out: [Span] = []
    func push(_ part: ArraySlice<Character>, _ code: Bool) {
      push(String(part), code)
    }
    func push(_ part: String, _ code: Bool) {
      guard !part.isEmpty else { return }
      if let last = out.last, !last.code, !code { out[out.count - 1].text += part } else { out.append(Span(text: part, code: code)) }
    }
    var i = 0
    var plainFrom = 0
    while i < text.count {
      guard text[i] == "`" else {
        i += 1
        continue
      }
      var n = 0
      while i + n < text.count, text[i + n] == "`" { n += 1 }
      var j = i + n
      var close = -1
      while j < text.count {
        guard text[j] == "`" else {
          j += 1
          continue
        }
        var m = 0
        while j + m < text.count, text[j + m] == "`" { m += 1 }
        if m == n {
          close = j
          break
        }
        j += m
      }
      if close < 0 {
        i += n
        continue
      }
      push(text[plainFrom..<i], false)
      var inner = String(text[(i + n)..<close])
      if inner.count > 1, inner.hasPrefix(" "), inner.hasSuffix(" "), !QuestionAnswers.jsTrim(inner).isEmpty { inner = String(inner.dropFirst().dropLast()) }
      push(inner, true)
      i = close + n
      plainFrom = i
    }
    push(text[plainFrom...], false)
    return out
  }

  // MARK: The card

  public enum Kind: Hashable, Sendable { case bash, file, fetch, search, other }
  public enum Outcome: Hashable, Sendable { case once, session, auto, full, deny, terminal, withdrawn, closed }

  /// "Claude Code wants to write a file" → "write a file".
  public static func wants(_ prompt: String) -> String {
    guard let cut = prompt.range(of: " wants to ") else { return prompt }
    return String(prompt[cut.upperBound...])
  }

  /// The card's title: what is wanted, its first letter raised (inline code first stays as it is).
  public static func title(_ prompt: String) -> String {
    let text = wants(prompt)
    return text.hasPrefix("`") ? text : text.prefix(1).uppercased() + text.dropFirst()
  }

  public static func kind(_ prompt: String) -> Kind {
    let text = wants(prompt)
    if text == "run a command" { return .bash }
    if ["write a file", "create a file", "overwrite a file", "edit a file", "read a file", "edit a notebook"].contains(text) { return .file }
    if text == "open a web page" { return .fetch }
    if text == "search the web" { return .search }
    return .other
  }

  /// The session choice: the one label that is none of the fixed ones.
  public static func sessionLabel(_ labels: [String]) -> String? {
    labels.first { ![allowOnce, deny, auto, full, terminal].contains($0) }
  }

  /// What came of the prompt, once it no longer waits; nil while it does.
  public static func outcome(_ question: InboxQuestion) -> Outcome? {
    if question.state == .superseded { return .withdrawn }
    if question.state == .closed { return .closed }
    guard question.state == .sent else { return nil }
    let answer = question.answer
    let picked = answer.flatMap { $0.skipped != true && $0.selected.count == 1 ? $0.selected[0] : nil }
    switch picked {
    case allowOnce?: return .once
    case auto?: return .auto
    case full?: return .full
    case terminal?: return .terminal
    case let label? where label == sessionLabel(question.choices.map(\.label)): return .session
    default: return .deny
    }
  }

  public static func allowed(_ outcome: Outcome) -> Bool { [.once, .session, .auto, .full].contains(outcome) }

  /// A path inside the session's folder, as the folder sees it.
  public static func relative(_ path: String, to folder: String?) -> String {
    guard let folder, !folder.isEmpty, path.hasPrefix("\(folder)/") else { return path }
    return String(path.dropFirst(folder.count + 1))
  }

  /// The request in one line, for the answered record: the command's first line, the path, the link.
  public func what(title: String) -> String {
    guard let detail else { return title }
    if detail.onLine { return Self.relative(detail.text, to: folder) }
    return detail.text.components(separatedBy: "\n").first ?? title
  }

  /// The reason the person gave with a Deny.
  public static func reason(_ question: InboxQuestion) -> String? {
    for words in [question.answer?.other, question.answer?.note] {
      let text = QuestionAnswers.jsTrim(words ?? "")
      if !text.isEmpty { return text }
    }
    return nil
  }

  /// TODO(contract): "permission vectors" (the host computed in core with `new URL`, and vectors for it). A link's
  /// origin and host for the card (PermissionCard.tsx `Link`), which the window reads with the browser's own
  /// `new URL`. The phone has no such reader, and a second one written by hand is how a card comes to name the
  /// wrong host. So the phone names a host only for an address so plain that every reader agrees on it: `http` or
  /// `https` in lower case, `://`, a host of lower-case ASCII letters, digits, hyphens and dots (or a dotted
  /// quad), an optional port, then a path, query or fragment, with nothing odd anywhere in the text. Foundation
  /// must read the same host and port. For anything else (a name before `@`, a percent sign or a space or a tab in
  /// the host, upper case, another alphabet, odd slashes, number shorthands, IPv6) it stresses nothing and names
  /// nothing: the card shows the address whole and unstyled, never a host that could be the wrong one.
  /// `origin` is given when the text starts with it (the card stresses it); with a default port in the text the
  /// text does not start with what a browser opens, so only `host` is given and the card names it on its own line.
  public static func link(_ text: String) -> (origin: String?, host: String?) {
    // A browser drops tabs and line breaks anywhere, and spaces at the ends: such an address is not plain.
    guard text.unicodeScalars.allSatisfy({ $0.value > 0x20 && $0.value != 0x7F && $0.value != 0x5C }) else { return (nil, nil) }
    guard let match = text.wholeMatch(of: /(https?):\/\/([a-z0-9](?:[a-z0-9\-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]*[a-z0-9])?)*)(?::([1-9][0-9]{0,4}))?(?:[\/?#].*)?/) else { return (nil, nil) }
    let scheme = String(match.1), host = String(match.2)
    let port = match.3.flatMap { Int($0) }
    if let port, port > 65535 { return (nil, nil) }
    // A last label of digits (or `0x…`) is a number to a browser: only a plain dotted quad is read the same by all.
    let labels = host.split(separator: ".")
    if let last = labels.last, last.allSatisfy(\.isNumber) || last.hasPrefix("0x") {
      guard labels.count == 4, labels.allSatisfy({ $0.allSatisfy(\.isNumber) && ($0 == "0" || !$0.hasPrefix("0")) && (Int($0) ?? 256) <= 255 }) else { return (nil, nil) }
    }
    // Punycode is another alphabet in disguise; the card shows it as it is, unstressed.
    if labels.contains(where: { $0.hasPrefix("xn--") }) { return (nil, nil) }
    guard let read = URLComponents(string: text), read.host == host, read.port == port, read.user == nil, read.password == nil else { return (nil, nil) }
    if let port, port != (scheme == "https" ? 443 : 80) {
      return ("\(scheme)://\(host):\(port)", "\(host):\(port)")
    }
    return (port == nil ? "\(scheme)://\(host)" : nil, host)
  }

  /// The session already switched to Full permissions from an earlier prompt in the thread: no confirmation again
  /// (`permFullUsed`, packages/inbox/components/Thread.tsx; the Inbox's own rule too).
  public static func fullUsed(in thread: InboxThread, before message: InboxMessageWire) -> Bool {
    thread.messages.contains { other in
      other.id != message.id && SendPlan.isPermissionPrompt(other) && other.author.session == message.author.session
        && (other.questions ?? []).contains { $0.state == .sent && $0.answer?.selected.contains(full) == true }
    }
  }

  /// The follow-up that withdrew the prompt ("Answered in Terminal."), when there is one.
  public static func followUp(in thread: InboxThread, of message: InboxMessageWire) -> String? {
    guard let by = message.questions?.first?.supersededBy?.messageId else { return nil }
    return thread.messages.first { $0.id == by }.map { $0.body.trimmingCharacters(in: .whitespacesAndNewlines) }
  }

  /// The replies that only carried a permission prompt's answer, and the follow-ups that withdrew one: the card
  /// says both, so the thread does not show them again.
  public static func saidByCards(in thread: InboxThread) -> Set<MessageID> {
    var out: Set<MessageID> = []
    for message in thread.messages where SendPlan.isPermissionPrompt(message) {
      for question in message.questions ?? [] {
        if let reply = question.sentReplyId { out.insert(MessageID(reply)) }
        if let by = question.supersededBy?.messageId, let follow = thread.messages.first(where: { $0.id == by }), (follow.questions ?? []).isEmpty { out.insert(by) }
      }
    }
    return out
  }
}
