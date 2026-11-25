import Foundation
import InboxWire

/// One row of the reply box's `@` list (the window's `TagOption`, packages/inbox/tags.ts): a session the person can
/// tag, or, on an older Plannotator, one they cannot tag yet.
public struct TagOption: Hashable, Sendable, Identifiable {
  /// The session id: the tag's `session`.
  public var id: String
  public var host: String?
  /// Its readable label: the `@<label>` the reply's words carry.
  public var label: String
  /// The agent's own name ("Claude Code", an MCP agent's name).
  public var agent: String
  /// The row's second line: "api-server · working · since 9:14 AM".
  public var detail: String
  /// The group heading: the agent's name, or `TagRules.readersGroup`.
  public var group: String
  /// The session the reply goes to anyway.
  public var owner: Bool
  /// Its connection wakes it; false: an agent that reads the Inbox only.
  public var wakes: Bool
  /// False: a session on an older Plannotator ("Update Plannotator to tag this session").
  public var taggable: Bool
  public var project: String?
}

/// A tag the reply's draft holds: the session a pick named, and the label its `@` token reads.
public struct DraftTag: Codable, Hashable, Sendable {
  public var session: String
  public var host: String?
  public var label: String

  public init(session: String, host: String?, label: String) {
    self.session = session
    self.host = host
    self.label = label
  }
}

/// Where `@` stands under the caret, in UTF-16 offsets (the window's `MentionTrigger`).
public struct MentionTrigger: Hashable, Sendable {
  /// What was typed after the `@`, trimmed and lowercased for matching.
  public var query: String
  /// The `@` itself.
  public var from: Int
  /// Just past the typed query: the caret.
  public var to: Int
}

/// The window's rules for tagging agents with `@` in a reply (approval "inbox-tag-agents"): the list's rows
/// (`tagOptions`, packages/inbox/tags.ts), the mention grammar (packages/ui/utils/mentions.ts), who a Send tags
/// (`tagsToSend`) and who a sent reply's tags name (`tagName`). `vectors/writing.json` holds them to the window.
public enum TagRules {
  /// `TAG_LABEL_MAX`: the longest label a token carries; a longer one is cut in the middle.
  public static let labelMax = 40
  /// `TAG_READERS_GROUP`.
  public static let readersGroup = "Reads the Inbox, not woken"
  /// `TAG_UPDATE_WORDS`.
  public static let updateWords = "Update Plannotator to tag this session"

  /// `agentName`: an MCP agent's own name, else its host's, else "An agent". An agent that named itself by its
  /// host's id ("gemini") reads by its product's name ("Gemini CLI").
  public static func agentName(_ host: String?, _ name: String? = nil) -> String {
    if let name, !name.isEmpty { return knownAgentLabel(name) ?? name }
    if let host, !host.isEmpty { return Words.hosts[host] ?? knownAgentLabel(host) ?? host }
    return "An agent"
  }

  /// `knownAgentLabel`: the product name of a known agent id in any case ("gemini" → "Gemini CLI"), else nil.
  static func knownAgentLabel(_ id: String) -> String? {
    Words.agents[id.lowercased()]
  }

  // MARK: The mention grammar

  /// `sanitizeMentionLabel`: `[`, `]`, `|` and line breaks become spaces, runs of white space one space, trimmed.
  public static func sanitize(_ label: String) -> String {
    let swapped = String(label.map { "[]|\n\r".contains($0) ? " " : $0 })
    var out = ""
    var space = false
    for scalar in swapped.unicodeScalars {
      if jsWhitespace(scalar) {
        space = true
      } else {
        if space, !out.isEmpty { out.append(" ") }
        space = false
        out.unicodeScalars.append(scalar)
      }
    }
    return out
  }

  /// `shortLabel`: past `max` characters, the head and the tail with "…" between.
  public static func shortLabel(_ label: String, max: Int) -> String {
    let characters = Array(label)
    guard characters.count > max else { return label }
    let head = Int((Double(max - 1) / 2).rounded(.up))
    let tail = max - 1 - head
    let front = String(characters[0..<head]).replacing(/\s+$/, with: "")
    let back = String(characters[(characters.count - tail)...]).replacing(/^\s+/, with: "")
    return "\(front)…\(back)"
  }

  /// `\s` in a JavaScript pattern with the `u` flag.
  static func jsWhitespace(_ scalar: Unicode.Scalar) -> Bool {
    scalar.properties.isWhitespace || scalar.value == 0xFEFF
  }

  /// A character the query takes: `[\w .-]` (ASCII letters, digits, `_`, a space, `.` and `-`).
  private static func queryUnit(_ unit: UInt16) -> Bool {
    switch unit {
    case 0x30...0x39, 0x41...0x5A, 0x61...0x7A, 0x5F, 0x20, 0x2E, 0x2D: return true
    default: return false
    }
  }

  /// `mentionTrigger`: the `@` under the caret, or nil. The character before it must start a line or be white space,
  /// so `a@b.com` never opens the list. `caret` is a UTF-16 offset.
  public static func trigger(_ text: String, caret: Int) -> MentionTrigger? {
    let units = Array(text.utf16)
    let end = min(max(caret, 0), units.count)
    var from: Int?
    for index in 0..<end where units[index] == 0x40 {
      if units[(index + 1)..<end].allSatisfy(queryUnit) {
        from = index
        break
      }
    }
    guard let from else { return nil }
    if from > 0 {
      let prior = units[from - 1]
      guard !UTF16.isLeadSurrogate(prior), !UTF16.isTrailSurrogate(prior), let scalar = Unicode.Scalar(prior), jsWhitespace(scalar) else { return nil }
    }
    let typed = String(decoding: units[(from + 1)..<end], as: UTF16.self)
    return MentionTrigger(query: typed.trimmingCharacters(in: .whitespaces).lowercased(), from: from, to: end)
  }

  /// `applyMentionPick`: the typed `@query` becomes `@<label> `, and the caret lands after it (UTF-16 offsets).
  public static func pick(_ text: String, _ trigger: MentionTrigger, label: String) -> (text: String, caret: Int) {
    let units = Array(text.utf16)
    let insert = "@\(sanitize(label)) "
    let before = String(decoding: units[0..<min(trigger.from, units.count)], as: UTF16.self)
    let after = String(decoding: units[min(trigger.to, units.count)...], as: UTF16.self)
    return (before + insert + after, trigger.from + insert.utf16.count)
  }

  /// `survivingMentions`: the labels whose `@` token still stands in the words. A token that is only the start of a
  /// longer tagged token belongs to that one.
  public static func surviving(_ text: String, labels: [String]) -> [String] {
    let units = Array(text.utf16)
    let tokens = labels.map { Array("@\(sanitize($0))".utf16) }
    func starts(_ token: [UInt16], at index: Int) -> Bool {
      index + token.count <= units.count && Array(units[index..<(index + token.count)]) == token
    }
    return labels.indices.filter { index in
      let token = tokens[index]
      guard !token.isEmpty, units.count >= token.count else { return false }
      for at in 0...(units.count - token.count) where starts(token, at: at) {
        let longer = tokens.contains { other in other.count > token.count && Array(other.prefix(token.count)) == token && starts(other, at: at) }
        if !longer { return true }
      }
      return false
    }.map { labels[$0] }
  }

  /// The tags whose `@` token the words still hold (`survivingMentions`), in the order picked, each session once.
  public static func standing(_ tags: [DraftTag], words: String) -> [DraftTag] {
    var left = surviving(words, labels: tags.map(\.label))
    var seen: Set<String> = []
    return tags.filter { tag in
      guard let index = left.firstIndex(of: tag.label), seen.insert(tag.session).inserted else { return false }
      left.remove(at: index)
      return true
    }
  }

  /// `mentionMatches` for agents (`matchDetail: false`): never one already tagged, each once, the label holding the query.
  public static func matches(_ options: [TagOption], trigger: MentionTrigger, tagged: Set<String>) -> [TagOption] {
    var seen: Set<String> = []
    return options.filter { option in
      guard !tagged.contains(option.id), seen.insert(option.id).inserted else { return false }
      return trigger.query.isEmpty || option.label.lowercased().contains(trigger.query)
    }
  }

  // MARK: The list's rows

  private static func stateWords(_ session: DoorTaggableSession, time: (String) -> String) -> String {
    var parts: [String] = []
    if let project = session.project { parts.append(project.name) }
    if session.kind == .mcp {
      parts.append(session.wroteThread ? "wrote here at \(time(session.lastAt))" : "seen \(time(session.lastAt))")
      return parts.joined(separator: " · ")
    }
    if session.busy == true { parts.append("working") } else if session.busy == false { parts.append("idle") }
    if let started = session.startedAt { parts.append("since \(time(started))") }
    return parts.joined(separator: " · ")
  }

  /// `tagOptions`: the owner's agent first, its live sessions owner first; then the other agents' live sessions as
  /// they come; then the agents that read the Inbox only. Labels are unique among the rows offered.
  public static func options(_ model: DoorTaggableAnswer?, owner ownerSession: String?, project threadProject: String?, time: (String) -> String) -> [TagOption] {
    guard let model else { return [] }
    let owner = ownerSession ?? model.owner?.session
    let live = model.sessions.filter { $0.kind == .live }
    let readers = model.sessions.filter { $0.kind == .mcp }
    let ownerRow = model.sessions.first { $0.session == owner }
    func groupOf(_ s: DoorTaggableSession) -> String { s.kind == .mcp ? readersGroup : agentName(s.host) }
    var order: [String] = []
    if let ownerRow, ownerRow.kind == .live { order.append(groupOf(ownerRow)) }
    for s in live where !order.contains(groupOf(s)) { order.append(groupOf(s)) }
    func ownerFirst(_ rows: [DoorTaggableSession]) -> [DoorTaggableSession] { rows.filter { $0.session == owner } + rows.filter { $0.session != owner } }
    let sorted = order.flatMap { group in ownerFirst(live.filter { groupOf($0) == group }) } + ownerFirst(readers)
    func agentOf(_ s: DoorTaggableSession) -> String { agentName(s.host, s.kind == .mcp ? s.name : nil) }
    func named(_ s: DoorTaggableSession) -> String? {
      guard s.kind == .live, let label = s.label else { return nil }
      let cut = shortLabel(sanitize(label), max: labelMax)
      return cut.isEmpty ? nil : cut
    }
    func unnamedLabel(_ s: DoorTaggableSession, _ agent: String) -> String {
      let sameAgent = sorted.filter { ($0.taggable || $0 == s) && agentOf($0) == agent }
      if s.session == owner || sameAgent.count < 2 { return agent }
      let here = s.project == nil || s.project?.id == threadProject
      return here ? "\(agent) (another session)" : "\(agent) (\(s.project!.name))"
    }
    let plainLabels = Set(sorted.filter { $0.taggable && named($0) == nil }.map { unnamedLabel($0, agentOf($0)) })
    var used: [String: Int] = [:]
    return sorted.map { s in
      let agent = agentOf(s)
      let own = named(s)
      var label = own ?? unnamedLabel(s, agent)
      if let own, plainLabels.contains(own) || sorted.contains(where: { $0 != s && $0.taggable && named($0) == own }) { label = "\(own) (\(agent))" }
      let seen = used[label] ?? 0
      used[label] = seen + 1
      if seen > 0, let own {
        label = "\(own) (\(agent) \(seen + 1))"
      } else if seen > 0 {
        if label.hasSuffix(")"), let open = label.lastIndex(of: "(") {
          let inner = String(label[label.index(after: open)..<label.index(before: label.endIndex)])
          label = inner == "another session" ? "\(agent) (another session \(seen + 1))" : "\(agent) (\(inner), another session)"
        } else {
          label = "\(agent) (another session)"
        }
      }
      return TagOption(
        id: s.session, host: s.host, label: label, agent: agent, detail: stateWords(s, time: time), group: groupOf(s), owner: s.session == owner, wakes: s.kind == .live,
        taggable: s.taggable, project: s.project?.name)
    }
  }

  /// `tagPickedWords`: what VoiceOver says when a row is picked.
  public static func picked(_ option: TagOption) -> String {
    if option.owner { return "Tagged \(option.label). It owns this thread; it gets your reply anyway." }
    if !option.wakes { return "Tagged \(option.label). It can't be woken; it sees your reply the next time it reads this thread." }
    return "Tagged \(option.label). It doesn't own this thread; it gets your reply and a pointer to this thread."
  }

  /// `tagsToSend` (an Ask: no mode): the tags in the order typed, each once, never the session the reply goes to.
  public static func toSend(_ tags: [DraftTag], owner: String?) -> [DoorReplyBodyTagsItem] {
    var out: [DoorReplyBodyTagsItem] = []
    for tag in tags where tag.session != owner && !out.contains(where: { $0.session == tag.session }) {
      out.append(DoorReplyBodyTagsItem(host: tag.host, session: tag.session, label: tag.label))
    }
    return out
  }

  /// `tagName`: who a sent reply's tag names. Its label when it kept one; else its agent, "(another session)" when
  /// that is the owner's agent in another session.
  public static func name(_ tag: InboxTag, ownerHost: String?, ownerSession: String?) -> String {
    if let label = tag.label, !label.isEmpty { return label }
    let name = agentName(tag.host, tag.name)
    if tag.session != ownerSession, let ownerHost, !ownerHost.isEmpty, let host = tag.host, !host.isEmpty, agentName(ownerHost) == name { return "\(name) (another session)" }
    return name
  }

  /// `tagDeliveryLine`, with the session's connection not known (the phone reads none): the line under a sent reply
  /// for one agent it tagged. Its state is the line's (`queued`, `sending`, `saved`, `delivered`).
  public static func line(_ tag: InboxTag, name: String, time: (String) -> String) -> (state: String, text: String) {
    if !tag.wakes, tag.delivery == nil, let read = tag.readAt { return ("delivered", "\(name) read this thread, \(time(read))") }
    if !tag.wakes, tag.delivery == nil { return ("saved", "Saved for \(name). It sees it the next time it reads this thread.") }
    if let delivery = tag.delivery, !delivery.at.isEmpty { return ("delivered", "Delivered to \(name), \(time(delivery.at))") }
    if tag.deliverNowAt != nil { return ("sending", "Sending to \(name) now…") }
    return ("queued", Words.deliverySentQueued(name: name))
  }
}

extension InboxSession {
  // MARK: Tagging agents with @

  /// How long a read of who can be tagged stands before `@` reads it again (the window polls every 10 s while the
  /// box is open).
  static let taggableFresh: TimeInterval = 10

  /// Read who the thread's reply can tag (`GET threads/:id/taggable`), unless a read of the last ten seconds stands.
  public func readTaggable(_ id: ThreadID, now: Date = Date()) async {
    if let last = draftBook.taggable[id], now.timeIntervalSince(last.at) < Self.taggableFresh { return }
    if client == nil { _ = await connect() }
    guard let client, offers(DoorRoutes.getThreadTaggable) else { return }
    do {
      let answer = try await client.get(Door.getThreadTaggable(thread: id), as: DoorTaggableAnswer.self)
      draftBook.taggable[id] = (now, answer)
    } catch let failure as DoorFailure {
      note(failure)
    } catch {}
  }

  /// Whether `@` opens the list in this thread's reply: only once the computer said who can be tagged (until then
  /// `@` is plain text, as in the window).
  public func tagsOffered(_ id: ThreadID) -> Bool { draftBook.taggable[id] != nil }

  /// The session the reply's words go to: it gets them anyway, so it is never a tag.
  func replyOwner(_ id: ThreadID) -> String? {
    guard let model = thread(id) else { return draftBook.taggable[id]?.answer.owner?.session }
    let target = SendPlan.targets(in: model.thread, aim: draftBook.local[id]?.aim).last?.message
    let session = model.thread.messages.first { $0.id == target }?.author.session
    return session.flatMap { $0.isEmpty ? nil : $0 } ?? draftBook.taggable[id]?.answer.owner?.session
  }

  /// The `@` list's rows for this thread's reply, as last read.
  public func tagOptions(_ id: ThreadID, time: (String) -> String) -> [TagOption] {
    TagRules.options(draftBook.taggable[id]?.answer, owner: replyOwner(id), project: thread(id)?.thread.project.id, time: time)
  }

  /// The tags the reply's words still hold, in the order picked, each once.
  public func standingTags(_ id: ThreadID, words: String) -> [DraftTag] { TagRules.standing(draftBook.local[id]?.tags ?? [], words: words) }

  /// A pick in the `@` list: the words with its token in them, and the tag kept with the draft, in one change.
  public func pickTag(_ id: ThreadID, words: String, option: TagOption) {
    changeDraft(id, typing: true) { draft in
      draft.words = words
      draft.tags = (draft.tags ?? []).filter { $0.session != option.id } + [DraftTag(session: option.id, host: option.host, label: option.label)]
    }
  }
}
