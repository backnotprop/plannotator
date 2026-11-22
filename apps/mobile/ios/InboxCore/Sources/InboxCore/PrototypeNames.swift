import Foundation
import InboxWire

/// What names a prototype page's comments in the feedback (packages/inbox/prototypes.ts `prototypeNames`): a page
/// a question's option shows is filed under that option, `Prototype of "B · Total first"`, and a question's shared
/// page (or one file several of its options show) under the question, `Prototype for "Which checkout?"`. Only the
/// attached files' names: a running app's comments are not the phone's to send.
public enum PrototypeNames {
  /// What the names are read from in a message (`PrototypeMessage` and its questions, packages/inbox/prototypes.ts).
  public struct Message: Decodable, Sendable {
    public struct File: Decodable, Sendable {
      public var id: String
      public var path: String
      public var namedPath: String?
      public var name: String
      public var kind: String
      enum CodingKeys: String, CodingKey { case id, path, name, kind, namedPath = "named_path" }
    }
    public struct Question: Decodable, Sendable {
      public struct Target: Decodable, Sendable { public var target: String }
      public struct Choice: Decodable, Sendable {
        public var label: String
        public var prototype: Target?
      }
      public var kind: String?
      public var prompt: String
      public var prototype: Target?
      public var choices: [Choice]
    }
    public var attachments: [File]?
    public var basePath: String?
    public var questions: [Question]?
    enum CodingKeys: String, CodingKey { case attachments, questions, basePath = "base_path" }

    init(_ message: InboxMessageWire) {
      attachments = message.attachments?.map { File(id: $0.id, path: $0.path, namedPath: $0.namedPath, name: $0.name, kind: $0.kind.rawValue) }
      basePath = message.basePath
      questions = message.questions?.map { question in
        Question(kind: question.kind.rawValue, prompt: question.prompt, prototype: question.prototype.map { Question.Target(target: $0.target) },
          choices: question.choices.map { Question.Choice(label: $0.label, prototype: $0.prototype.map { Question.Target(target: $0.target) }) })
      }
    }
  }

  static func attachments(_ messages: [InboxMessageWire], root: String) -> [String: String] { attachments(messages.map(Message.init), root: root) }

  /// By attachment id. The first question and option to name a page names it.
  public static func attachments(_ messages: [Message], root: String) -> [String: String] {
    var names: [String: String] = [:]
    func name(_ id: String?, _ words: String) {
      guard let id, names[id] == nil else { return }
      names[id] = words
    }
    for message in messages {
      for question in message.questions ?? [] where question.kind != "action" {
        let pages = question.choices.map { page($0.prototype?.target, in: message, root: root) }
        let ids = pages.compactMap { $0 }
        for (index, choice) in question.choices.enumerated() {
          let id = pages[index]
          let shared = id.map { one in ids.filter { $0 == one }.count > 1 } ?? false
          name(id, shared ? "Prototype for \"\(question.prompt)\"" : "Prototype of \"\(choice.label)\"")
        }
        name(page(question.prototype?.target, in: message, root: root), "Prototype for \"\(question.prompt)\"")
      }
    }
    return names
  }

  /// The attached HTML file a `Prototype:` target names in its message (`prototypePageOf`, its file kind), or nil:
  /// a target with a scheme is an app, never a file.
  static func page(_ target: String?, in message: Message, root: String) -> String? {
    guard let target else { return nil }
    if FileFeedback.trim(target).firstMatch(of: /^[A-Za-z][A-Za-z0-9+.\-]*:/.matchingSemantics(.unicodeScalar)) != nil { return nil }
    guard let found = attachment(for: target, among: message.attachments ?? [], root: root, base: message.basePath), found.kind == "html" else { return nil }
    return found.id
  }

  // MARK: packages/inbox/links.ts `attachmentForLink`

  private static func isAbsolute(_ path: String) -> Bool {
    path.hasPrefix("/") || path.hasPrefix("\\") || path.firstMatch(of: /^[A-Za-z]:[\\\/]/.matchingSemantics(.unicodeScalar)) != nil
  }

  /// `normalizeLinkPath`: `a/b/../c/./d` as `a/c/d`, `\` read as `/`, a drive letter in lower case.
  static func normalize(_ path: String) -> String {
    let slashed = path.replacingOccurrences(of: "\\", with: "/")
    let drive = slashed.firstMatch(of: /^[A-Za-z]:/.matchingSemantics(.unicodeScalar)) != nil ? String(slashed.prefix(2)).lowercased() : ""
    let rest = drive.isEmpty ? slashed : String(slashed.dropFirst(2))
    let absolute = rest.hasPrefix("/")
    var out: [Substring] = []
    for segment in rest.split(separator: "/", omittingEmptySubsequences: false) {
      if segment.isEmpty || segment == "." { continue }
      if segment == ".." {
        if let last = out.last, last != ".." { out.removeLast() } else if !absolute { out.append("..") }
        continue
      }
      out.append(segment)
    }
    return "\(drive)\(absolute ? "/" : "")\(out.joined(separator: "/"))"
  }

  /// `linkCandidates`: the link without its query and fragment, and percent-decoded.
  private static func candidates(_ href: String) -> [String] {
    let trimmed = FileFeedback.trim(href)
    let stripped = trimmed.firstIndex(where: { $0 == "?" || $0 == "#" }).map { String(trimmed[..<$0]) } ?? trimmed
    guard !stripped.isEmpty else { return [] }
    var out = [stripped]
    if stripped.contains("%"), let decoded = stripped.removingPercentEncoding, decoded != stripped { out.append(decoded) }
    return out
  }

  static func attachment(for href: String, among attachments: [Message.File], root: String, base: String?) -> Message.File? {
    guard !attachments.isEmpty else { return nil }
    var known: [String: Message.File] = [:]
    for attachment in attachments {
      known[normalize(attachment.path)] = attachment
      if let named = attachment.namedPath, !named.isEmpty { known[normalize(named)] = attachment }
    }
    var dirs: [String] = []
    for dir in [base, root].compactMap({ $0 }) where !dir.isEmpty && !dirs.contains(dir) { dirs.append(dir) }
    let candidates = candidates(href)
    for candidate in candidates {
      let paths = isAbsolute(candidate) ? [normalize(candidate)] : dirs.map { normalize("\($0)/\(candidate)") }
      for path in paths { if let hit = known[path] { return hit } }
    }
    for candidate in candidates where !candidate.contains("/") && !candidate.contains("\\") {
      let named = attachments.filter { $0.name == candidate }
      if named.count == 1 { return named[0] }
    }
    return nil
  }
}
