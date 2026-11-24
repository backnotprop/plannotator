import Foundation
import InboxWire

/// 👍 Looks good and its tray (approval "inbox-acknowledge", "inbox-reaction-tray"; packages/inbox/components/
/// ReactionTray.tsx, parts/AckPill.tsx, thread/ackLine.ts): a reaction on the agent's latest message. It marks the
/// thread read at once and goes to the agent once its ten seconds pass; until then a tap on the pressed button takes
/// it back. `vectors/writing.json` holds the line under it to the window.
public enum Reactions {
  /// `INBOX_ACK_LABEL`.
  public static let looksGood = Words.labelAck
  public static let thumbsUp = "👍"

  /// `isInboxNote` (packages/core/inbox-types.ts): a line the Inbox writes in the person's name (set aside, moved,
  /// reopened, a 👍's note, a tidy), which is not something they wrote back.
  static func isNote(_ message: InboxMessageWire) -> Bool {
    guard message.author.kind == .person else { return false }
    if !(message.setAside ?? []).isEmpty || message.movedNote != nil || !(message.reopened ?? []).isEmpty || message.tidy != nil { return true }
    if let note = message.ackOf, !note.isEmpty { return true }
    if let run = message.scheduledRun, run.unknownFields["run"] == nil, run.run == nil { return true }
    return false
  }

  /// The message a 👍 is offered on, or nil (Thread.tsx `ackOffered`): the agent's latest message, while the thread
  /// is not archived, no question or action item waits (open or picked), the person did not write back after it,
  /// and its reaction was not sent yet. `kept`: the reply box holds something, or picks, comments or marks wait for a
  /// Send; the button is not drawn then.
  public static func target(_ thread: InboxThread, kept: Bool) -> InboxMessageWire? {
    let agents = thread.messages.filter { $0.author.kind == .agent }
    guard !kept, thread.resolvedAt == nil, let latest = agents.last else { return nil }
    let waits = agents.contains { message in ((message.questions ?? []) + (message.actions ?? [])).contains { $0.state == .openValue || $0.state == .picked } }
    if waits { return nil }
    if thread.messages.last(where: { !isNote($0) })?.author.kind == .person { return nil }
    if latest.ack?.settledSeq != nil { return nil }
    return latest
  }

  /// Where a 👍 is on its way (`AckPillState`).
  public enum LineState: String, Hashable, Sendable { case pending, queued, sending, saved, delivered, notSent = "not-sent" }

  /// `ackPillLine`, with the session's connection not known (the phone reads none): the line under the message.
  public static func line(_ ack: InboxAck, agent: String, wakes: Bool, time: (String) -> String) -> (state: LineState, text: String) {
    if let delivered = ack.deliveredAt {
      var auto = ""
      if ack.deliverNowBy == .auto, let now = ack.deliverNowAt, let started = ack.waitStartedAt {
        if ack.deliveredIntoTurn == false {
          auto = " · \(Words.deliveryTurnEnded)"
        } else if let from = SnoozeRules.date(started), let to = SnoozeRules.date(now) {
          auto = " · \(Words.deliveryAutoAfter(minutes: max(0, Int((to.timeIntervalSince(from) / 60).rounded()))))"
        }
      }
      return (.delivered, "Delivered to \(agent), \(time(delivered))\(auto)")
    }
    if ack.notSent == .replied { return (.notSent, "not sent: you replied") }
    if ack.notSent == .wroteAgain { return (.notSent, "not sent: \(agent) wrote again") }
    let you = "You, \(time(ack.at)) · "
    if ack.settledSeq == nil { return (.pending, "\(you)goes to \(agent) in a few seconds") }
    if wakes, let note = ack.noteId, !note.isEmpty {
      return (ack.deliverNowAt != nil ? .sending : .queued, "\(you)\(ack.deliverNowAt != nil ? "Sending to \(agent) now…" : Words.deliverySentQueued(name: agent))")
    }
    return (.saved, "\(you)\(Words.deliverySentSaved(name: agent))")
  }

  /// What the chip beside the line shows: the emoji, then its name or "Looks good". A reaction with no name shows the
  /// emoji alone (VoiceOver reads `speech`).
  public static func chip(_ ack: InboxAck) -> (emoji: String, words: String?) {
    guard let reaction = ack.reaction else { return (thumbsUp, ack.label) }
    return (reaction.emoji, reaction.label.flatMap { $0.isEmpty ? nil : $0 })
  }

  /// The button's words (ReactionTray.tsx): the pick's name, "Reacted" for one with no name, or "Looks good".
  public static func buttonWords(_ ack: InboxAck?) -> String {
    guard let ack else { return looksGood }
    guard let reaction = ack.reaction else { return looksGood }
    return reaction.label.flatMap { $0.isEmpty ? nil : $0 } ?? "Reacted"
  }

  /// Each emoji's name as the window says it (`emojiRow`), from the window's own list (`Words.emojiNameLines`).
  static let names: [String: String] = {
    var out: [String: String] = [:]
    for line in Words.emojiNameLines.split(separator: "\n") {
      guard let tab = line.firstIndex(of: "\t") else { continue }
      let emoji = String(line[..<tab])
      if out[emoji] == nil { out[emoji] = String(line[line.index(after: tab)...]) }
    }
    return out
  }()

  /// `emojiName`: an emoji's own name ("unicorn face"); one the window's list does not have is "emoji".
  public static func name(_ emoji: String) -> String { names[emoji] ?? "emoji" }

  /// `reactionSpeech`: "Reacted with <the emoji's name>", for a reaction that shows its emoji alone.
  public static func speech(_ emoji: String) -> String { "Reacted with \(name(emoji))" }

  /// The reaction a tray pick sends: 👍 is Looks good (null), another emoji itself.
  public static func reaction(for emoji: String) -> DoorAckBodyReaction? {
    emoji == thumbsUp ? nil : DoorAckBodyReaction(emoji: emoji)
  }

  /// One emoji, as the Inbox takes a reaction (`isInboxReactionEmoji`): a single character that is drawn as an emoji.
  public static func isEmoji(_ text: String) -> Bool {
    guard text.count == 1, let first = text.unicodeScalars.first else { return false }
    return first.properties.isEmojiPresentation || text.unicodeScalars.count > 1 && first.properties.isEmoji
  }
}

/// What came of a press of 👍 or a pick in its tray.
public enum ReactOutcome: Hashable, Sendable {
  case done
  /// The Inbox's own words for its refusal (the window shows them as its error toast).
  case refused(String)
  /// No answer: nothing changed.
  case failed
}

extension InboxSession {
  // MARK: 👍 Looks good

  /// The message the thread's 👍 is offered on now, or nil.
  public func ackTarget(_ id: ThreadID) -> InboxMessageWire? {
    guard standing == .ok, offers(DoorRoutes.postMessageAck) || skew == nil, let model = thread(id) else { return nil }
    let draft = draftBook.local[id]
    let kept = !(draft?.words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true) || !(draft?.files ?? []).isEmpty || draft?.quote != nil
    let waiting = hasHeldReply(id) || !commentsToSend(id).isEmpty || model.thread.messages.contains { ($0.questions ?? []).contains { $0.state == .picked && $0.kind != .action } || ActionMarks.items(of: $0).contains(where: SendPlan.actionInDraft) }
    return Reactions.target(model.thread, kept: kept || waiting)
  }

  /// React to the agent's latest message (`POST messages/:id/ack`): `on` false takes the reaction back. `reaction`:
  /// nil is 👍 Looks good. The thread is read again from the computer, so the line and the list say what it holds.
  public func react(_ id: ThreadID, message: MessageID, on: Bool, reaction: DoorAckBodyReaction? = nil) async -> ReactOutcome {
    if client == nil { _ = await connect() }
    guard let client else { return .failed }
    var body = DoorAckBody(idempotencyKey: UUID().uuidString, ack: on)
    // The tray always says which emoji: null is 👍 Looks good (api.ts `ack`).
    if on { body.reaction = reaction ?? nil; body.unknownFields["reaction"] = reaction == nil ? .null : nil }
    do {
      _ = try await client.post(Door.postMessageAck(message: message), body, as: DoorAckAnswer.self)
      await readThread(id)
      await readList()
      return .done
    } catch let failure as DoorFailure {
      note(failure)
      if case .refused(_, let error) = failure {
        await readThread(id)
        return .refused(error.error)
      }
      return .failed
    } catch {
      return .failed
    }
  }
}
