import InboxCore
import InboxWire
import SwiftUI

/// Where the thread's scroll is, kept outside the views' state so a scroll never redraws the thread.
@MainActor
final class ScrollBox {
  /// The part of the content on screen, in the content's own coordinates: under the title bar, over the reply field.
  var top: CGFloat = 0
  var bottom: CGFloat = 0
  var height: CGFloat { bottom - top }
  /// The card that last grew under the person's hand: when the keyboard then rises, its end stays in view.
  var grown: String?
  /// The page's height with no keyboard, and whether the keyboard is over it now.
  var full: CGFloat = 0
  var covered = false
  /// True once the thread has landed. Kept here, not in the view's state: the scroll's own callbacks read it as it
  /// is now, not as it was when they were made.
  var landed = false
}

/// A thread: its messages oldest first, questions as cards in place, the composer at the bottom (FLOWS 4, mock 4).
struct ThreadScreen: View {
  let session: InboxSession
  let id: ThreadID
  @State private var words = ""
  @State private var drafts = ThreadDrafts()
  @State private var tail: CGFloat = 0
  /// Each card's place in the content, so the reply field never hides the part of a card the person is on.
  @State private var cards: [String: CGRect] = [:]
  @State private var scroll = ScrollBox()
  @State private var jumped: String?
  @State private var position = ScrollPosition()
  @FocusState private var composing: Bool

  private var model: ThreadModel? { session.thread(id) }
  private var title: String {
    guard let thread = model?.thread else { return session.list?.sections.flatMap(\.threads).first { $0.threadId == id }.flatMap { $0.threadName ?? $0.subject } ?? "" }
    return thread.threadName ?? thread.subject ?? thread.project.displayName ?? thread.project.name
  }
  private var subtitle: String {
    guard let thread = model?.thread else { return "" }
    let project = thread.project.displayName ?? thread.project.name
    guard let agent = thread.messages.last(where: { $0.author.kind == .agent }) else { return project }
    return "\(Names.agent(agent.author)) · \(project)"
  }

  var body: some View {
    Group {
      if let thread = model?.thread {
        messages(thread)
      } else if session.missingThreads.contains(id) {
        Standing(symbol: "tray", words: PhoneWords.threadGone)
      } else if session.reach == .away {
        Standing(symbol: "wifi.slash", words: PhoneWords.awayNoCopy(session.computer.name), action: PhoneWords.tryAgain) { Task { await session.open(id) } }
      } else {
        ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    }
    .background(Token.background.ignoresSafeArea())
    .navigationTitle(title)
    .navigationSubtitle(subtitle)
    .navigationBarTitleDisplayMode(.inline)
    .task { await session.open(id) }
  }

  /// The cards the person can still act on, in thread order: what the thread lands on and what the jump visits.
  private func waiting(_ thread: InboxThread, shown: [InboxMessageWire]) -> [(id: String, open: Bool)] {
    shown.filter { $0.author.kind == .agent }.flatMap { message -> [(String, Bool)] in
      if SendPlan.isPermissionPrompt(message) {
        return (message.questions ?? []).prefix(1).filter { PermissionPrompt.outcome($0) == nil }.map { _ in (CardID.permission(message.id), true) }
      }
      let todos = ActionMarks.items(of: message)
      // In the order the agent wrote them (an action item before a question when it was written first).
      return MessageBody.blocks(message.body, questions: MessageView.questions(of: message).count, actions: todos.count).flatMap { block -> [(String, Bool)] in
        switch block {
        case .question(let index):
          let question = MessageView.questions(of: message)[index]
          guard question.state == .openValue || question.state == .picked else { return [] }
          return [(CardID.question(message.id, question.key), question.state == .openValue)]
        case .actions(let first, let count):
          let run = todos[first..<min(first + count, todos.count)]
          guard run.contains(where: { [.open, .pending].contains(ActionMarks.state($0)) }) else { return [] }
          return [(CardID.actions(message.id, first), run.contains { ActionMarks.state($0) == .open })]
        default: return []
        }
      }
    }
  }

  private func messages(_ thread: InboxThread) -> some View {
    // A reply that only carried a permission prompt's answer is said by the prompt's own card.
    let said = PermissionPrompt.saidByCards(in: thread)
    let shown = thread.messages.filter { !said.contains($0.id) }
    let lastPerson = shown.last { $0.author.kind == .person }?.id
    // Where the thread lands: the newest agent message, at the top of the page, with what follows it. A message
    // is never cut in half by the title bar: it starts whole, as a page does.
    let landing = shown.lastIndex { $0.author.kind == .agent } ?? 0
    let waiting = waiting(thread, shown: shown)
    let held = session.heldReplies(id)
    return ScrollViewReader { proxy in
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(shown[..<landing], id: \.id) { message in
          MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts)
          Divider().overlay(Token.border).padding(.top, 18).padding(.bottom, message.id == shown[landing - 1].id ? 6 : 18)
        }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(shown[landing...].enumerated()), id: \.element.id) { index, message in
            if index > 0 { Divider().overlay(Token.border).padding(.vertical, 18) }
            MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts)
          }
          // A reply that waits for the computer is the person's own message already, said to be waiting.
          ForEach(held) { write in
            Divider().overlay(Token.border).padding(.vertical, 18)
            HeldReply(words: write.words ?? "", to: MessageView.addressee(of: write.message.map { MessageID($0) }, in: thread), computer: session.computer.name)
          }
        }
        .padding(.top, 12)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tail = $0 }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.content)) } action: { cards[Self.landing] = $0 }
        .id(Self.landing)
        // Room under a short last message, so it can still start at the top.
        Color.clear.containerRelativeFrame(.vertical) { length, _ in max(0, length - tail) }
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 20)
      .coordinateSpace(.named(Self.content))
      .onPreferenceChange(CardFrames.self) { now in
        let before = cards
        cards.merge(now) { $1 }
        // A card that grew under the person's hand (a pick's line, a note field, a reason) stays whole on screen.
        for (key, frame) in now where key != Self.landing {
          if let old = before[key], frame.height > old.height + 1 {
            scroll.grown = key
            // The person is already at work on the page: it does not land again under their hand.
            scroll.landed = true
            reveal(key, proxy)
          }
        }
      }
      Color.clear.frame(height: 1).id(Self.end)
    }
    // The title bar is a hard edge: no message runs under the title or the status bar.
    .scrollEdgeEffectStyle(.hard, for: .top)
    .toolbarBackground(Token.background, for: .navigationBar)
    .toolbarBackgroundVisibility(.visible, for: .navigationBar)
    .scrollPosition($position)
    // What is on screen, in the content's coordinates. The container's size is already what is left between the
    // title bar and the reply field (and the keyboard, when it is up).
    .onScrollGeometryChange(for: [CGFloat].self) { [$0.contentOffset.y + $0.contentInsets.top, $0.contentOffset.y + $0.contentInsets.top + $0.containerSize.height] } action: { _, now in
      scroll.top = now[0]
      scroll.bottom = now[1]
      let covered = scroll.height < scroll.full - 80
      if !covered { scroll.full = max(scroll.full, scroll.height) }
      let rose = covered && !scroll.covered
      scroll.covered = covered
      // The keyboard rose over a card the person just opened a field on: what they are filling in stays in view.
      if rose, let key = scroll.grown { reveal(key, proxy) }
    }
    // A new message from an agent lands the same way; the person's own Send is followed to the end.
    .onChange(of: shown.count) { _, _ in
      withAnimation {
        if shown.last?.author.kind == .person { proxy.scrollTo(Self.end, anchor: .bottom) } else { land(waiting, proxy) }
      }
    }
    .onChange(of: held.count) { _, now in if now > 0 { withAnimation { proxy.scrollTo(Self.end, anchor: .bottom) } } }
    // Land once the page is measured (a thread already on the phone is laid out before it is on screen).
    .onChange(of: tail) { _, _ in
      guard !scroll.landed else { return }
      // After the room under the last message is laid out, not before.
      Task {
        try? await Task.sleep(for: .milliseconds(40))
        if !scroll.landed { land(waiting, proxy) }
      }
    }
    .task {
      try? await Task.sleep(for: .milliseconds(60))
      land(waiting, proxy)
      try? await Task.sleep(for: .milliseconds(700))
      if !scroll.landed { land(waiting, proxy) }
      scroll.landed = true
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await session.refresh() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(session: session, id: id, thread: thread, words: $words, drafts: drafts, focused: $composing, waiting: waiting.count > 1 ? waiting.filter(\.open).count : 0, counts: counts(thread)) {
        // The next card that still wants an answer, after the one last visited, then from the start.
        let open = waiting.filter(\.open).map(\.id)
        guard !open.isEmpty else { return }
        let next = jumped.flatMap { open.firstIndex(of: $0) }.map { open[($0 + 1) % open.count] } ?? open[0]
        jumped = next
        withAnimation { show(next, proxy) }
      }
    }
    // A Send the computer refused: the person's words come back to the box, never lost.
    .onChange(of: session.returned[id], initial: true) { _, back in
      guard back != nil, let text = session.takeReturnedWords(id) else { return }
      words = words.isEmpty ? text : "\(text)\n\n\(words)"
    }
    }
  }

  private func counts(_ thread: InboxThread) -> (questions: Int, actions: Int) {
    let agents = thread.messages.filter { $0.author.kind == .agent && !SendPlan.isPermissionPrompt($0) }
    return (
      agents.flatMap { MessageView.questions(of: $0) }.filter { $0.state == .openValue }.count,
      agents.flatMap { ActionMarks.items(of: $0) }.filter { ActionMarks.state($0) == .open }.count
    )
  }

  /// Land on the newest agent message. When what it asks would end under the reply field, land on the card
  /// instead: whole and resting on the reply field when it fits, from its top when it is taller than the page.
  private func land(_ waiting: [(id: String, open: Bool)], _ proxy: ScrollViewProxy) {
    proxy.scrollTo(Self.landing, anchor: .top)
    guard let start = cards[Self.landing], scroll.height > 0 else { return }
    guard let first = waiting.first(where: { cards[$0.id].map { $0.minY >= start.minY } ?? false }), let card = cards[first.id] else { return }
    if card.maxY + Self.margin <= start.minY + scroll.height { return }
    show(first.id, proxy)
  }

  /// Bring a card on screen: all of it when it fits over the reply field, else its top.
  private func show(_ key: String, _ proxy: ScrollViewProxy) {
    guard let card = cards[key] else { return proxy.scrollTo(key, anchor: .top) }
    proxy.scrollTo(key, anchor: card.height + Self.margin * 2 <= scroll.height ? .bottom : .top)
  }

  /// After a card grows, or the keyboard rises over it: if its end went under the reply field, bring it back
  /// over it. A card taller than the page shows its end too: what just opened (a note, a reason, its buttons) is
  /// there. Done now and once more when the keyboard has settled, which moves the page on its own.
  private func reveal(_ key: String, _ proxy: ScrollViewProxy) {
    Task {
      for wait in [0, 420] {
        try? await Task.sleep(for: .milliseconds(wait))
        guard let card = cards[key], scroll.height > 0, card.maxY + Self.margin > scroll.bottom else { continue }
        // By its own distance, not by name: a named scroll rests the card on the page's edge under the keyboard.
        withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(y: scroll.top + card.maxY + Self.margin - scroll.bottom) }
      }
    }
  }

  private static let end = "end"
  nonisolated private static let landing = "landing"
  nonisolated private static let content = "content"
  /// The air kept between a card and the reply field (or the title bar).
  static let margin: CGFloat = 12
}

/// The names the thread scrolls to.
enum CardID {
  static func question(_ message: MessageID, _ key: String) -> String { "q/\(message.rawValue)/\(key)" }
  static func actions(_ message: MessageID, _ first: Int) -> String { "a/\(message.rawValue)/\(first)" }
  static func permission(_ message: MessageID) -> String { "p/\(message.rawValue)" }
}

/// Where each card is in the thread's content.
struct CardFrames: PreferenceKey {
  static let defaultValue: [String: CGRect] = [:]
  static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}

extension View {
  /// A card the thread can scroll to and keep clear of the reply field: the name's frame reaches a margin past
  /// the card on both sides, so a card brought to an edge keeps its air.
  func card(_ key: String) -> some View {
    self
      .background { GeometryReader { geometry in Color.clear.preference(key: CardFrames.self, value: [key: geometry.frame(in: .named("content"))]) } }
      .padding(.vertical, ThreadScreen.margin)
      .id(key)
      .padding(.vertical, -ThreadScreen.margin)
  }
}

/// One message: plain text on the page, never a bubble; the person's own in the same column.
struct MessageView: View {
  let session: InboxSession
  let thread: InboxThread
  let message: InboxMessageWire
  let showsDelivery: Bool
  let drafts: ThreadDrafts

  /// A message's questions, without its action items, in the agent's order.
  static func questions(of message: InboxMessageWire) -> [InboxQuestion] {
    (message.questions ?? []).filter { $0.kind != .action }.sorted { $0.position < $1.position }
  }

  /// Who a reply went to: the agent it is addressed to, else the one whose message it answers.
  static func addressee(of message: InboxMessageWire, in thread: InboxThread) -> String? {
    if let host = message.to?.host ?? message.delivery?.host, !host.isEmpty { return Words.agents[host] ?? host }
    return addressee(of: message.replyTo.map { MessageID($0) }, in: thread)
  }

  static func addressee(of asked: MessageID?, in thread: InboxThread) -> String? {
    guard let asked, let author = thread.messages.first(where: { $0.id == asked })?.author, author.kind == .agent else { return nil }
    return Names.agent(author)
  }

  var body: some View {
    if SendPlan.isPermissionPrompt(message) {
      // Its own framed card and nothing else, as in the window: the card names who asks and when.
      PermissionCard(session: session, thread: thread, message: message).card(CardID.permission(message.id))
    } else {
      plain
    }
  }

  private var plain: some View {
    let name = Names.agent(message.author)
    let questions = Self.questions(of: message)
    let todos = ActionMarks.items(of: message)
    let blocks = MessageBody.blocks(message.body, questions: questions.count, actions: todos.count)
    return VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        if message.author.kind == .agent { AgentMark(author: message.author, size: 28) }
        Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(Token.foreground)
        if message.author.kind == .person, let to = Self.addressee(of: message, in: thread) {
          Text(PhoneWords.to(to)).font(.subheadline).foregroundStyle(Token.mutedForeground).lineLimit(1)
        }
        Text(TimeWords().when(message.createdAt)).font(.subheadline).monospacedDigit().foregroundStyle(Token.mutedForeground)
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
        switch block {
        case .question(let index):
          let question = questions[index]
          QuestionCard(
            session: session, thread: thread.threadId, message: message.id, question: question,
            sentAt: question.sentReplyId.flatMap { reply in thread.messages.first { $0.id.rawValue == reply }?.createdAt },
            place: questions.count > 1 ? (index + 1, questions.count) : nil, drafts: drafts
          )
          .card(CardID.question(message.id, question.key))
        case .actions(let first, let count):
          ActionChecklist(session: session, thread: thread.threadId, message: message.id, actions: Array(todos[first..<min(first + count, todos.count)]), agent: name, readOnly: thread.resolvedAt != nil, drafts: drafts)
            .card(CardID.actions(message.id, first))
        default:
          MessageWords(block: block)
        }
      }
      if showsDelivery, let line = deliveryLine {
        Text(line).font(.footnote).foregroundStyle(Token.mutedForeground)
      }
    }
  }

  /// The delivery line, for the two states whose words the contract generates today. The rest of the window's
  /// delivery lines arrive as the computer's own `line` (brief F4).
  private var deliveryLine: String? {
    guard let delivery = message.delivery else { return nil }
    let name = Words.agents[delivery.host] ?? delivery.host
    switch InboxDeliveryState(rawValue: delivery.state) {
    case .queued: return Words.deliverySentQueued(name: name)
    case .saved: return Words.deliverySentSaved(name: name)
    default: return nil
    }
  }
}

/// A reply the computer does not have yet, drawn as the person's own message, a little quieter, with what it
/// waits for.
struct HeldReply: View {
  let words: String
  let to: String?
  let computer: String

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 10) {
        Text(PhoneWords.you).font(.subheadline.weight(.semibold)).foregroundStyle(Token.foreground)
        if let to { Text(PhoneWords.to(to)).font(.subheadline).foregroundStyle(Token.mutedForeground).lineLimit(1) }
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      Text(words).font(.body).foregroundStyle(Token.foreground.opacity(0.75)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
      Label(PhoneWords.willSendWhenBack(computer), systemImage: "clock").font(.footnote).foregroundStyle(Token.mutedForeground)
    }
  }
}

/// The composer: the words, and Send. Send posts every saved pick in the thread with whatever words are here.
struct Composer: View {
  let session: InboxSession
  let id: ThreadID
  let thread: InboxThread
  @Binding var words: String
  let drafts: ThreadDrafts
  var focused: FocusState<Bool>.Binding
  /// How many cards still want an answer, when the thread has more than one: the jump is offered.
  let waiting: Int
  let counts: (questions: Int, actions: Int)
  let jump: () -> Void

  private var hasPicks: Bool { thread.messages.contains { ($0.questions ?? []).contains { $0.state == .picked } } }
  private var canSend: Bool {
    // While a Send waits, its picks are already on their way: only new words make another Send.
    if session.hasHeldReply(id), words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
    return session.canSend(thread: id, words: words) && !session.sending.contains(id)
  }
  @Environment(\.dynamicTypeSize) private var typeSize
  /// At the largest text sizes the longer hint would be cut: the short one says enough.
  private var hint: String { hasPicks && !typeSize.isAccessibilitySize ? PhoneWords.noteOrSend : PhoneWords.reply }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if session.reach == .away, session.standing == .ok {
        // The thread says it too: what is done here waits on the phone.
        Label(PhoneWords.away(session.computer.name), systemImage: "moon.fill")
          .font(.footnote)
          .foregroundStyle(Token.mutedForeground)
          .padding(.horizontal, 6)
      }
      if let notice = session.notices[id] {
        let said = PhoneWords.notice(notice, computer: session.computer.name)
        Label(words.isEmpty ? said : "\(said) \(PhoneWords.wordsBack)", systemImage: "exclamationmark.circle")
          .font(.footnote)
          .foregroundStyle(Token.destructive)
          .padding(.horizontal, 6)
      }
      if waiting > 0 {
        // The window's own pill: what still wants an answer, and a touch goes to the next one.
        Button(action: jump) {
          HStack(spacing: 6) {
            Image(systemName: "questionmark.circle")
            Text(counts.actions == 0 ? PhoneWords.openQuestions(counts.questions) : CountWords.waiting(open: counts.questions + counts.actions, actions: counts.actions))
            Image(systemName: "chevron.down").font(.caption.weight(.bold))
          }
          .font(.subheadline.weight(.medium))
          .foregroundStyle(Token.foreground)
          .padding(.horizontal, 14)
          .frame(minHeight: 36)
          .background(Token.muted, in: Capsule())
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(ChoiceStyle())
      }
      if session.standing == .appNeedsUpdate {
        Label(PhoneWords.updateToAnswer, systemImage: "arrow.down.app")
          .font(.subheadline)
          .foregroundStyle(Token.mutedForeground)
          .frame(maxWidth: .infinity, minHeight: 44)
      } else if SendPlan.needsComputer(thread) {
        Label(PhoneWords.replyOnComputer, systemImage: "desktopcomputer")
          .font(.subheadline)
          .foregroundStyle(Token.mutedForeground)
          .frame(maxWidth: .infinity, minHeight: 44)
      } else {
        box
      }
    }
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 8)
    .background(Token.background)
  }

  private var box: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField(hint, text: $words, axis: .vertical)
        .lineLimit(1...6)
        .font(.body)
        .focused(focused)
        .padding(.leading, 16)
        .padding(.vertical, 12)
        .accessibilityLabel(hint)
      Button {
        // Words typed on a card and not saved yet are saved first: what is on screen is what is sent.
        drafts.saveAll()
        let text = words
        words = ""
        Task {
          // A Send that could not be made at all gives the words straight back.
          if !(await session.send(thread: id, words: text)), words.isEmpty { words = text }
        }
      } label: {
        Image(systemName: "arrow.up")
          .font(.body.weight(.bold))
          .foregroundStyle(canSend ? Token.primaryForeground : Token.mutedForeground)
          .frame(width: 44, height: 44)
          .background(canSend ? Token.primary : Token.muted, in: Circle())
      }
      .disabled(!canSend)
      .accessibilityLabel(PhoneWords.send)
      .padding(4)
    }
    .glassEffect(.regular, in: .rect(cornerRadius: 26))
  }
}
