import InboxCore
import InboxWire
import SwiftUI
import UIKit

/// What a thread's Take back is doing, shared by its messages and its reply box: the one being taken back, the line
/// under a message it was refused on, and the note over the box once it came back (packages/inbox/takeBack.ts).
@MainActor
@Observable
final class TakeBackState {
  var busy: MessageID?
  var refusal: (id: MessageID, line: String)?
  /// The line under a reply still waiting on the phone that was not taken back (it was already on its way).
  var heldRefusal: (id: String, line: String)?
  var note: String?

  /// Take back on a reply that waits on the phone: true when its words went back to the box.
  func takeHeld(_ session: InboxSession, write: String, name: String) -> Bool {
    guard busy == nil else { return false }
    refusal = nil
    heldRefusal = nil
    note = nil
    switch session.takeBackHeld(write, name: name) {
    case .taken?: return true
    case .refused(let line)?:
      heldRefusal = (write, line)
      AccessibilityNotification.Announcement(line).post()
      return false
    case nil: return false
    }
  }

  func take(_ session: InboxSession, thread: ThreadID, message: MessageID, name: String) {
    guard busy == nil else { return }
    busy = message
    refusal = nil
    heldRefusal = nil
    note = nil
    Task {
      let outcome = await session.takeBack(thread, message: message, name: name)
      busy = nil
      switch outcome {
      case .taken:
        let said = TakeBackRule.note(name)
        note = said
        AccessibilityNotification.Announcement(said).post()
      case .refused(let line):
        refusal = (message, line)
        AccessibilityNotification.Announcement(line).post()
      }
    }
  }
}

// MARK: @ in the reply box (TagPicker.tsx)

/// The agents `@` can tag, under the words typed after it: grouped by agent, the owner's first, then those that
/// read the Inbox and are not woken. A touch on a row tags it.
struct TagList: View {
  @Environment(\.dynamicTypeSize) private var typeSize
  let options: [TagOption]
  /// Nobody to offer at all (a bare `@`): the list says so.
  let empty: Bool
  let pick: (TagOption) -> Void

  private var groups: [(group: String, rows: [TagOption])] {
    var out: [(group: String, rows: [TagOption])] = []
    for option in options {
      if out.last?.group == option.group { out[out.count - 1].rows.append(option) } else { out.append((option.group, [option])) }
    }
    return out
  }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        if empty {
          Text(PhoneWords.noAgentToTag)
            .font(TextRole.secondary)
            .foregroundStyle(Token.mutedForeground)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.card)
            .padding(.vertical, Space.step)
        }
        ForEach(groups, id: \.group) { group in
          Text(group.group)
            .font(TextRole.captionStrong)
            .foregroundStyle(Token.mutedForeground)
            .padding(.horizontal, Space.card)
            .padding(.top, Space.close)
            .padding(.bottom, Space.tight)
            .accessibilityAddTraits(.isHeader)
          ForEach(group.rows) { option in row(option) }
        }
      }
      .padding(.bottom, Space.tight)
    }
    .scrollBounceBehavior(.basedOnSize)
    // A part of the foot, as its other lines are: it grows with the text to the bar's limit.
    .barSized()
    .frame(maxHeight: typeSize.isAccessibilitySize ? 300 : 248)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(PhoneWords.tagAnAgent)
    .accessibilityIdentifier("tag-list")
  }

  private func row(_ option: TagOption) -> some View {
    let reader = option.group == TagRules.readersGroup
    let badge = option.owner ? PhoneWords.ownsThisThread : !option.taggable ? PhoneWords.tagUpdate : reader ? PhoneWords.notWoken : nil
    let detail = option.taggable ? option.detail : TagRules.updateWords
    let words = VStack(alignment: .leading, spacing: Space.hair) {
      Text(option.label).font(TextRole.label).foregroundStyle(option.taggable ? Token.foreground : Token.mutedForeground)
      if !detail.isEmpty { Text(detail).font(TextRole.meta).foregroundStyle(Token.mutedForeground) }
    }
    .multilineTextAlignment(.leading)
    .fixedSize(horizontal: false, vertical: true)
    let mark = AgentMark(author: InboxAuthor(kind: .agent, host: option.host, session: option.id), size: 26)
    return Button { pick(option) } label: {
      Group {
        if typeSize.isAccessibilitySize {
          // Large words: the name has the row's width, and the badge goes under it.
          VStack(alignment: .leading, spacing: Space.tight) {
            HStack(alignment: .center, spacing: Space.close) { mark; Spacer(minLength: 0) }
            words
            if let badge { Text(badge).font(TextRole.caption).foregroundStyle(Token.mutedForeground) }
          }
        } else {
          HStack(alignment: .center, spacing: Space.step) {
            mark
            words
            Spacer(minLength: Space.close)
            if let badge { Text(badge).font(TextRole.caption).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.trailing) }
          }
        }
      }
      .padding(.horizontal, Space.card)
      .padding(.vertical, Space.close)
      .frame(maxWidth: .infinity, minHeight: Space.touch, alignment: .leading)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(gives: false))
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("tag-option/\(option.id)")
  }
}

// MARK: 👍 Looks good (ReactionTray.tsx, AckPill.tsx)

/// 👍 Looks good beside the reply field, as beside the window's Reply: a touch marks the agent's message, a touch
/// on the pressed button takes it back while it waits. A hold opens the tray: 👍, or any emoji once.
struct LooksGoodButton: View {
  let session: InboxSession
  let id: ThreadID
  let message: InboxMessageWire
  /// The window's error toast, with the Inbox's own words.
  let tell: (String) -> Void
  /// Any emoji's sheet, which the reply box shows (a sheet asked for from inside the hold's menu never shows), and
  /// the emoji picked in it.
  @Binding var anyEmoji: Bool
  @Binding var picked: String?
  @State private var busy = false
  @Environment(\.dynamicTypeSize) private var typeSize

  private var agent: String { Names.agent(message.author) }
  private var on: Bool { message.ack != nil }
  private var current: InboxReaction? { message.ack?.reaction ?? nil }
  private var emoji: String { on ? (current?.emoji ?? Reactions.thumbsUp) : Reactions.thumbsUp }

  /// A pick in the tray: the emoji the message already carries takes the mark back, another changes it.
  private func send(_ pick: DoorAckBodyReaction?) {
    guard !busy else { return }
    react(back: on && (pick?.emoji ?? Reactions.thumbsUp) == emoji, pick)
  }

  private func react(back: Bool, _ pick: DoorAckBodyReaction?) {
    guard !busy else { return }
    busy = true
    Task {
      let outcome = await session.react(id, message: message.id, on: !back, reaction: back ? nil : pick)
      busy = false
      switch outcome {
      case .done: break
      case .refused(let words): tell(words)
      // No answer: the window's toast for an Inbox that did not answer.
      case .failed: tell(ActionWords.unreachable)
      }
    }
  }

  var body: some View {
    // A touch on the pressed button takes the mark back, whichever emoji it is.
    Button { react(back: on, nil) } label: {
      HStack(spacing: Space.trim) {
        Text(emoji).accessibilityHidden(true)
        // At the largest sizes the emoji alone, so the reply field keeps its room; VoiceOver still says its words.
        if !typeSize.isAccessibilitySize { Text(on ? Reactions.buttonWords(message.ack) : Reactions.looksGood).lineLimit(1) }
      }
      .font(TextRole.link)
      .foregroundStyle(on ? Token.primary : Token.foreground)
      .padding(.horizontal, Space.step)
      .frame(minHeight: Size.capsule)
      .background(on ? Token.primary.opacity(0.14) : Token.foreground.opacity(0.07), in: Capsule())
      .padding(.vertical, Space.trim)
      .touchTarget()
    }
    .buttonStyle(PressStyle())
    .disabled(busy)
    .contextMenu {
      Button(PhoneWords.thumbsLooksGood) { send(Reactions.reaction(for: Reactions.thumbsUp)) }
      Button(PhoneWords.anyEmoji) { anyEmoji = true }
    }
    .accessibilityLabel(on && current != nil && (current?.label ?? "").isEmpty ? Reactions.speech(emoji) : on ? Reactions.buttonWords(message.ack) : Reactions.looksGood)
    .accessibilityHint(on ? PhoneWords.takeBackReaction(current) : PhoneWords.looksGoodHint(agent))
    .accessibilityAddTraits(on ? .isSelected : [])
    .accessibilityAction(named: PhoneWords.moreReactions(agent)) { anyEmoji = true }
    .accessibilityIdentifier("looks-good")
    .onChange(of: picked) { _, now in
      guard let now else { return }
      picked = nil
      send(DoorAckBodyReaction(emoji: now))
    }
  }
}

/// Any emoji, once: the keyboard's own emoji, the first one typed goes.
struct AnyEmojiSheet: View {
  let pick: (String) -> Void
  @State private var typed = ""

  var body: some View {
    VStack(alignment: .leading, spacing: Space.step) {
      Text(PhoneWords.anyEmojiSpeech).font(TextRole.name).foregroundStyle(Token.foreground).accessibilityAddTraits(.isHeader)
      EmojiField(text: $typed)
        .frame(height: Size.replyRow)
        .padding(.horizontal, Space.step)
        .background(Token.foreground.opacity(0.06), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
    }
    .padding(Space.page)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(Token.background)
    .presentationDetents([.height(160), .medium])
    .onChange(of: typed) { _, now in
      guard let last = now.last.map(String.init), Reactions.isEmoji(last) else { if !now.isEmpty { typed = "" }; return }
      pick(last)
    }
  }
}

/// A field that opens on the emoji keyboard.
private struct EmojiField: UIViewRepresentable {
  @Binding var text: String

  final class Field: UITextField {
    override var textInputMode: UITextInputMode? { UITextInputMode.activeInputModes.first { $0.primaryLanguage == "emoji" } ?? super.textInputMode }
  }

  func makeUIView(context: Context) -> Field {
    let field = Field()
    // The field itself is what VoiceOver and a UI test reach.
    field.accessibilityIdentifier = "any-emoji"
    field.accessibilityLabel = PhoneWords.anyEmoji
    field.font = .preferredFont(forTextStyle: .title2)
    field.adjustsFontForContentSizeCategory = true
    field.addTarget(context.coordinator, action: #selector(Coordinator.changed(_:)), for: .editingChanged)
    DispatchQueue.main.async { field.becomeFirstResponder() }
    return field
  }

  func updateUIView(_ field: Field, context: Context) { if field.text != text { field.text = text } }

  func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

  final class Coordinator: NSObject {
    let text: Binding<String>
    init(text: Binding<String>) { self.text = text }
    @MainActor @objc func changed(_ field: UITextField) { text.wrappedValue = field.text ?? "" }
  }
}

/// Under the agent's message the person marked: the emoji and its name, then where it is on its way.
struct AckLine: View {
  let ack: InboxAck
  let agent: String
  let wakes: Bool

  var body: some View {
    let chip = Reactions.chip(ack)
    let line = Reactions.line(ack, agent: agent, wakes: wakes) { TimeWords().when($0) }
    HStack(alignment: .firstTextBaseline, spacing: Space.close) {
      HStack(spacing: Space.tight) {
        Text(chip.emoji).accessibilityHidden(true)
        if let words = chip.words { Text(words).foregroundStyle(Token.foreground) }
      }
      .font(TextRole.metaStrong)
      .padding(.horizontal, Space.close)
      .padding(.vertical, Space.hair)
      .background(Token.foreground.opacity(0.07), in: Capsule())
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(chip.words ?? Reactions.speech(chip.emoji))
      Text(line.text).font(TextRole.meta).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityIdentifier("ack-line")
  }
}

// MARK: Take back (Undelivered.tsx TakeBackButton)

/// Take back, beside the line that says the reply is on its way.
struct TakeBackButton: View {
  let busy: Bool
  let press: () -> Void

  var body: some View {
    Button(action: press) {
      Text(TakeBackRule.label)
        .font(TextRole.link)
        .foregroundStyle(Token.primary)
        .padding(.horizontal, Space.close)
        .touchTarget()
    }
    .buttonStyle(PressStyle())
    .disabled(busy)
    .accessibilityHint(PhoneWords.takeBackHint)
    .accessibilityIdentifier("take-back")
  }
}
