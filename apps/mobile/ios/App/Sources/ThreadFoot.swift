import InboxCore
import InboxWire
import SwiftUI

/// The composer: the words, and Send. Send posts every saved pick in the thread with whatever words are here.
struct Composer: View {
  let session: InboxSession
  let id: ThreadID
  let thread: InboxThread
  @Binding var words: String
  let drafts: ThreadDrafts
  var focused: FocusState<Bool>.Binding
  /// What still waits in the thread: the button at the foot says it, and a touch goes to the next one.
  let items: OpenItems
  /// The person types in a card: the foot steps aside until the keyboard goes, all but its fade, so the card has
  /// the room over the keyboard and one field only stands there, the one they type in.
  var inCard = false
  /// The computer's draft the words came from: sending them clears it there too.
  var clearDraft: String?
  /// What Take back is doing in this thread: its note stands over the box until the next Send.
  var takeBack: TakeBackState?
  /// The window's error toast (a 👍 the Inbox refused, in its own words).
  var tell: (String) -> Void = { _ in }
  /// Go to a card.
  let go: (String) -> Void
  let jump: () -> Void
  /// Open the list of comments on files that wait for this Send.
  var comments: () -> Void = {}
  /// Where the caret is in the words: `@` opens the list of agents to tag right before it.
  @State private var selection: TextSelection?
  /// The list of agents is open: it opens when the person types an `@`, never when they delete back to one.
  @State private var tagging = false
  /// Any emoji's sheet, from 👍's tray, and the emoji picked in it.
  @State private var anyEmoji = false
  @State private var emoji: String?

  /// The fade over the reply field, at the top of the foot: what scrolls under it fades into it. It grows with the
  /// text (14 points at the default size, up to 24), so a line cut at the foot fades out rather than being sliced.
  static func fade(_ size: DynamicTypeSize) -> CGFloat {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
    return min(24, UIFontMetrics(forTextStyle: .body).scaledValue(for: 14, compatibleWith: traits).rounded())
  }
  private var fade: CGFloat { Self.fade(typeSize) }

  private var hasPicks: Bool { thread.messages.contains { ($0.questions ?? []).contains { $0.state == .picked } } }
  private var canSend: Bool {
    // While a Send waits, its picks are already on their way: only new words make another Send.
    if session.hasHeldReply(id), words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, files.isEmpty { return false }
    if guarded || pressed { return false }
    return session.canSend(thread: id, words: words, files: files) && !session.sending.contains(id)
  }
  /// Send was pressed and its Send has not run yet: a second press in between sends nothing.
  @State private var pressed = false
  @Environment(\.dynamicTypeSize) private var typeSize
  /// One line of the reply field at this text size: the controls beside the words are centred on it, and stay
  /// at the foot of the field when the words run to more lines.
  @ScaledMetric(relativeTo: .body) private var textLine: CGFloat = Size.mark
  private var oneLine: CGFloat { max(Size.replyRow, textLine + 2 * Space.step) }
  private var hint: String { hasPicks ? PhoneWords.noteOrSend : PhoneWords.reply }
  /// The files in the reply's draft, and the message it quotes.
  private var files: [DraftFile] { session.files(.thread(id)) }
  private var quote: DraftQuote? { session.draft(id)?.quote }
  /// The stale guard is up: it stands in place of the reply's own actions, as in the window.
  private var guarded: Bool { session.stopped.contains(id) && !(session.stale[id] ?? []).isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.close) {
      // Something to stand on even when empty: the fade and the solid ground under the keyboard stay.
      if inCard { Color.clear.frame(maxWidth: .infinity, maxHeight: 0) } else { foot }
    }
    .padding(.horizontal, Space.step)
    .padding(.vertical, inCard ? 0 : Space.close)
    // What scrolls under the reply field fades into it: no card or line is cut through by a hard edge. The fade
    // is part of the foot, so the page's room ends where it begins and nothing rests under it.
    .padding(.top, fade)
    .sheet(isPresented: $anyEmoji) {
      AnyEmojiSheet { picked in
        anyEmoji = false
        emoji = picked
      }
    }
    .background {
      VStack(spacing: 0) {
        LinearGradient(colors: [Token.background.opacity(0), Token.background], startPoint: .top, endPoint: .bottom)
          .frame(height: fade)
        // Solid down to the screen's edge, under the keyboard too: nothing of the page shows below the field.
        Token.background
      }
      .ignoresSafeArea(.all, edges: .bottom)
      .allowsHitTesting(false)
    }
  }

  @ViewBuilder private var foot: some View {
    if session.reach == .away, session.standing == .ok {
      // The thread says it too: what is done here waits on the phone.
      Label(PhoneWords.away(session.computer.name), systemImage: "moon.fill")
        .font(TextRole.meta)
        .foregroundStyle(Token.mutedForeground)
        // In line with the page's words and icons above it (the page's margin is 20, the foot's 12).
        .padding(.horizontal, Space.close)
    }
    // Comments the person sent while their drawing could not reach the computer: they go by themselves once it can.
    let needNetwork = session.commentsNeedingNetwork(id).count
    if needNetwork > 0 {
      Label(PhoneWords.commentsNeedNetwork(needNetwork), systemImage: "wifi")
        .font(TextRole.meta)
        .foregroundStyle(Token.mutedForeground)
        .padding(.horizontal, Space.close)
        .accessibilityIdentifier("thread-needs-network")
    }
    // Under the guard only the guard speaks: the refusal behind it names keys.
    if let notice = session.notices[id], !guarded {
      let said = PhoneWords.notice(notice, computer: session.computer.name, agent: thread.messages.last { $0.author.kind == .agent }.map { Names.agent($0.author) })
      Label(words.isEmpty ? said : "\(said) \(PhoneWords.wordsBack)", systemImage: "exclamationmark.circle")
        .font(TextRole.meta)
        .foregroundStyle(Token.destructive)
        .padding(.horizontal, Space.close)
    }
    if let note = takeBack?.note {
      Label(note, systemImage: "arrow.uturn.backward")
        .font(TextRole.meta)
        .foregroundStyle(Token.mutedForeground)
        .padding(.horizontal, Space.close)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(note)
        .accessibilityIdentifier("take-back-note")
    }
    if guarded, let stale = session.stale[id] {
      // As wide as the cards above it.
      StaleGuard(session: session, id: id, thread: thread, stale: stale, words: $words, drafts: drafts, go: go).padding(.horizontal, Space.close)
    }
    let jumps = !guarded && items.shown
    if session.standing == .appNeedsUpdate {
      if jumps { jumpPill }
      Label(PhoneWords.updateToAnswer, systemImage: "arrow.down.app")
        .font(TextRole.secondary)
        .foregroundStyle(Token.mutedForeground)
        .frame(maxWidth: .infinity, minHeight: Space.touch)
    } else if SendPlan.needsComputer(thread) {
      if jumps { jumpPill }
      Label(PhoneWords.replyOnComputer, systemImage: "desktopcomputer")
        .font(TextRole.secondary)
        .foregroundStyle(Token.mutedForeground)
        .frame(maxWidth: .infinity, minHeight: Space.touch)
    } else {
      box(jumps: jumps)
    }
  }

  /// The window's own words for what still waits. A number never parts from its noun when the words are large
  /// and wrap. Nil when every question is answered in the draft: the control is its mark alone then.
  private var waits: String? { PhoneWords.openItems(items).map { $0.replacing(#/(\d) /#) { "\($0.1)\u{00A0}" } } }

  /// What still wants an answer, and a touch goes to the next one: one line across the top of the reply field,
  /// so the foot is one thing with two parts and not two things that happen to be near each other.
  private var jumpStrip: some View {
    Button(action: jump) {
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        Image(systemName: "questionmark.circle").foregroundStyle(Token.mutedForeground)
        if let waits { Text(waits).foregroundStyle(Token.foreground).multilineTextAlignment(.leading) }
        Spacer(minLength: Space.close)
        Image(systemName: "chevron.down").font(TextRole.glyph).foregroundStyle(Token.mutedForeground)
      }
      .font(TextRole.link)
      .padding(.horizontal, Space.card)
      .padding(.vertical, Space.close)
      .frame(minHeight: Space.touch)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(gives: false))
    // A line of the foot, as a bar's is: it grows with the text to a limit, so the page keeps the screen at the
    // largest sizes. The cards and the words above grow all the way.
    .barSized()
    .accessibilityLabel(PhoneWords.openItems(items) ?? PhoneWords.allAnswered)
  }

  /// The same control with no words to say (every question answered in the draft): its mark alone, at the start
  /// of the reply field's own line.
  private var jumpMark: some View {
    Button(action: jump) {
      HStack(spacing: Space.tight) {
        Image(systemName: "questionmark.circle")
        Image(systemName: "chevron.down").font(TextRole.glyph)
      }
      .font(TextRole.link)
      .foregroundStyle(Token.mutedForeground)
      .padding(.leading, Space.card)
      .touchTarget()
    }
    .buttonStyle(PressStyle())
    .barSized()
    .accessibilityLabel(PhoneWords.openItems(items) ?? PhoneWords.allAnswered)
  }

  /// Where there is no reply field to carry it (the app needs an update, the reply is the computer's): on its own.
  private var jumpPill: some View {
    Group { if waits == nil { jumpMark.padding(.trailing, Space.step) } else { jumpStrip } }
      .glassEffect(.regular, in: .rect(cornerRadius: Radius.foot))
  }

  /// The comments on files that ride this Send: one line across the top of the reply field; a touch lists them.
  private func commentStrip(_ count: Int) -> some View {
    Button(action: comments) {
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        Image(systemName: "text.bubble").foregroundStyle(Token.mutedForeground)
        Text(CountWords.comments(count).replacing(#/(\d) /#) { "\($0.1)\u{00A0}" }).foregroundStyle(Token.foreground)
        Spacer(minLength: Space.close)
        Image(systemName: "chevron.up").font(TextRole.glyph).foregroundStyle(Token.mutedForeground)
      }
      .font(TextRole.link)
      .padding(.horizontal, Space.card)
      .padding(.vertical, Space.close)
      .frame(minHeight: Space.touch)
      .contentShape(Rectangle())
    }
    .buttonStyle(PressStyle(gives: false))
    .barSized()
    .accessibilityLabel(CountWords.comments(count))
    .accessibilityIdentifier("thread-comments")
  }

  /// 👍 Looks good stands beside the field only while the box is empty, as beside the window's Reply.
  private var ackTarget: InboxMessageWire? {
    guard words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, files.isEmpty, quote == nil, !guarded else { return nil }
    return session.ackTarget(id)
  }

  /// Where the caret is, in UTF-16 units as the window counts; at the end when the field has no caret.
  private var caret: Int {
    if case .selection(let range)? = selection?.indices, range.upperBound <= words.endIndex { return words.utf16.distance(from: words.utf16.startIndex, to: range.upperBound) }
    return words.utf16.count
  }

  private var trigger: MentionTrigger? { session.tagsOffered(id) ? TagRules.trigger(words, caret: caret) : nil }

  /// The rows `@` offers for what was typed after it, or nil while the list is closed. A query nobody matches
  /// closes it (prose after a tag); a bare `@` with nobody at all says so.
  private var tagShown: (rows: [TagOption], empty: Bool)? {
    guard tagging, !inCard, let trigger else { return nil }
    let options = session.tagOptions(id) { TimeWords().when($0) }
    if options.isEmpty { return trigger.query.isEmpty ? ([], true) : nil }
    let tagged = Set(session.standingTags(id, words: words).map(\.session))
    let rows = TagRules.matches(options, trigger: trigger, tagged: tagged)
    return rows.isEmpty ? nil : (rows, false)
  }

  /// The words changed: an `@` typed (or a name after it) opens the list, a deletion never does; one already open
  /// stays while its `@` does.
  private func typed(_ before: String, _ now: String) {
    let grew = now.utf16.count > before.utf16.count
    guard let found = TagRules.trigger(now, caret: grew && now.hasPrefix(before) ? now.utf16.count : caret) else { return tagging = false }
    if grew { tagging = true }
    // Who can be tagged is read when an `@` is typed (it stands ten seconds).
    if found.query.isEmpty { Task { await session.readTaggable(id) } }
  }

  private func pickTag(_ option: TagOption) {
    guard let trigger else { return }
    // A session on an older Plannotator: nothing goes in, and it says why.
    guard option.taggable else { return AccessibilityNotification.Announcement(PhoneWords.tagBlocked(option.label)).post() }
    let made = TagRules.pick(words, trigger, label: option.label)
    session.pickTag(id, words: made.text, option: option)
    tagging = false
    words = made.text
    selection = TextSelection(insertionPoint: String.Index(utf16Offset: min(made.caret, made.text.utf16.count), in: made.text))
    AccessibilityNotification.Announcement(TagRules.picked(option)).post()
  }

  private func box(jumps: Bool) -> some View {
    // What the Send carries and what waits for the computer's network; the strip stays while any comment waits, so
    // the list says why one does not go.
    let riding = session.commentsCounted(id).count
    let waiting = !session.comments(id).isEmpty
    return VStack(spacing: 0) {
      if let shown = tagShown {
        TagList(options: shown.rows, empty: shown.empty, pick: pickTag)
        Hairline().padding(.horizontal, Space.card)
      }
      if jumps, waits != nil {
        jumpStrip
        Hairline().padding(.horizontal, Space.card)
      }
      if waiting {
        commentStrip(riding)
        Hairline().padding(.horizontal, Space.card)
      }
      if let quote {
        QuoteLine(thread: thread, quote: quote) {
          withAnimation(Motion.fade.animation(still: false)) { session.setQuote(id, nil) }
          AccessibilityNotification.Announcement(PhoneWords.quoteRemoved).post()
        }
        Hairline().padding(.horizontal, Space.card)
      }
      if !files.isEmpty {
        DraftTiles(session: session, place: .thread(id))
        Hairline().padding(.horizontal, Space.card)
      }
      HStack(alignment: .bottom, spacing: 0) {
        if jumps, waits == nil { jumpMark.frame(minHeight: oneLine) }
        AttachButton(session: session, place: .thread(id)).frame(minHeight: oneLine).padding(.leading, jumps && waits == nil ? 0 : Space.tight)
        TextField("", text: $words, selection: $selection, axis: .vertical)
          .lineLimit(1...6)
          .font(TextRole.body)
          .focused(focused)
          .padding(.leading, Space.tight)
          .padding(.vertical, Space.step)
          // The hint whole, never cut: the long one when it fits on the line, else the short one.
          .overlay(alignment: .topLeading) {
            if words.isEmpty {
              ViewThatFits(in: .horizontal) {
                Text(hint).lineLimit(1)
                Text(PhoneWords.reply).lineLimit(1)
              }
              .font(TextRole.body)
              .foregroundStyle(Color(uiColor: .placeholderText))
              .padding(.leading, Space.tight)
              .padding(.vertical, Space.step)
              .allowsHitTesting(false)
              .accessibilityHidden(true)
            }
          }
          .frame(minHeight: Size.replyRow)
          .accessibilityLabel(hint)
          .onChange(of: words) { before, now in typed(before, now) }
          // Taken back: the caret at the end of the words that came back.
          .onChange(of: takeBack?.note) { _, now in if now != nil { selection = TextSelection(insertionPoint: words.endIndex) } }
        if let target = ackTarget {
          LooksGoodButton(session: session, id: id, message: target, tell: tell, anyEmoji: $anyEmoji, picked: $emoji).frame(minHeight: oneLine)
            // The bar's limit, without the Large Content Viewer: a hold on it opens the tray.
            .dynamicTypeSize(...Size.barText)
        }
        Button {
          guard !pressed else { return }
          pressed = true
          takeBack?.note = nil
          tagging = false
          // Words typed on a card and not saved yet are saved first: what is on screen is what is sent.
          drafts.saveAll()
          let text = words
          let files = files
          let quote = quote
          words = ""
          Task {
            // A Send that could not be made at all gives the words straight back.
            if !(await session.send(thread: id, words: text, clearDraft: clearDraft, files: files, quote: quote)), words.isEmpty { words = text }
            pressed = false
          }
        } label: {
          SendDisc(ready: canSend)
        }
        .buttonStyle(PressStyle())
        .disabled(!canSend)
        .accessibilityLabel(PhoneWords.send)
        // What holds the Send: a file that waits for the computer's own network says so, not "uploading".
        .accessibilityHint(DraftFiles.holdSend(files) ? (session.filesNeedNetwork(files) ? PhoneWords.needsNetwork : PhoneWords.waitForFiles) : "")
        // Send is a control of the foot's bar: it grows with the text to the bar's limit.
        .barSized()
        .frame(minHeight: oneLine)
      }
    }
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.foot))
  }
}

/// Send: a disc that keeps the reply field's own centre, 6 points in from its edge all round. It takes the accent
/// the moment there is something to send, and only then. The disc and its arrow follow the person's text size
/// (to the bar's limit, which the foot sets with `barSized()`); what answers a touch is never under 44 points.
struct SendDisc: View {
  let ready: Bool
  /// The arrow sends; a tick keeps a comment for the next Send.
  var symbol = "arrow.up"
  @ScaledMetric(relativeTo: .body) private var disc: CGFloat = Size.sendDisc

  var body: some View {
    Image(systemName: symbol)
      .font(TextRole.secondary.weight(.bold))
      .foregroundStyle(ready ? Token.primaryForeground : Token.mutedForeground)
      .frame(width: disc, height: disc)
      .background(ready ? Token.primary : Token.foreground.opacity(0.08), in: Circle())
      .motion(.fade, value: ready)
      .padding(Space.trim)
      .touchTarget()
  }
}
