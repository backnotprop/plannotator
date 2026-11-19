import InboxCore
import InboxWire
import SwiftUI

/// Where the thread's scroll is, and what the person last touched. Its values are not observed: a scroll never
/// redraws the thread, and the scroll's own callbacks read them as they are now.
@MainActor
@Observable
final class ScrollBox {
  /// The part of the content on screen, in the content's own coordinates: under the title bar, over the reply field.
  @ObservationIgnored var top: CGFloat = 0
  @ObservationIgnored var bottom: CGFloat = 0
  var height: CGFloat { bottom - top }
  /// True once the thread has landed: it lands once, and never again under the person's eyes.
  @ObservationIgnored var landed = false
  /// The card the person last touched, and when. Only that card, and only for a moment after the touch, is
  /// brought back over the reply field when it grows or the keyboard rises.
  @ObservationIgnored var acted: String?
  @ObservationIgnored var actedAt = Date.distantPast

  func act(_ key: String) {
    acted = key
    actedAt = Date()
    landed = true
  }

  /// The card a reveal may still follow: the one touched within the last few seconds.
  func fresh(within seconds: TimeInterval) -> String? { Date().timeIntervalSince(actedAt) <= seconds ? acted : nil }
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
    // A permission prompt's message with no question left draws nothing, as in the window.
    let shown = thread.messages.filter { !said.contains($0.id) && !(SendPlan.isPermissionPrompt($0) && ($0.questions ?? []).isEmpty) }
    let items = OpenItems(thread)
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
          MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts).id("m/\(message.id.rawValue)")
          Divider().overlay(Token.border).padding(.top, 18).padding(.bottom, message.id == shown[landing - 1].id ? 6 : 18)
        }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(shown[landing...].enumerated()), id: \.element.id) { index, message in
            if index > 0 { Divider().overlay(Token.border).padding(.vertical, 18) }
            MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts).id("m/\(message.id.rawValue)")
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
        if now[CardFrames.part] == nil { cards[CardFrames.part] = nil }
        // Only the card the person just touched follows its own growth (a pick's line, a note field, a reason):
        // a card that changes on its own (another device's answer, a refusal's line) never moves the page.
        if let key = scroll.fresh(within: 1.5), let old = before[key], let frame = now[key], frame.height > old.height + 1 { reveal(key, proxy) }
      }
      Color.clear.frame(height: 1).id(Self.end)
    }
    // Words fade out under the title bar: no line is cut through by a hard edge.
    .scrollEdgeEffectStyle(.soft, for: .top)
    .toolbarBackground(Token.background, for: .navigationBar)
    .toolbarBackgroundVisibility(.visible, for: .navigationBar)
    .scrollPosition($position)
    // What is on screen, in the content's coordinates. The container's size is already what is left between the
    // title bar and the reply field (and the keyboard, when it is up).
    .onScrollGeometryChange(for: [CGFloat].self) { [$0.contentOffset.y + $0.contentInsets.top, $0.contentOffset.y + $0.contentInsets.top + $0.containerSize.height] } action: { _, now in
      scroll.top = now[0]
      scroll.bottom = now[1]
    }
    // The keyboard rose over the card the person just opened a field on: once it has settled, what they are
    // filling in is brought over the reply field.
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
      if let key = scroll.fresh(within: 3) { reveal(key, proxy) }
    }
    .environment(scroll)
    // The person's own Send is followed to the end. A message that arrives while they read moves nothing.
    .onChange(of: shown.count) { _, _ in
      if shown.last?.author.kind == .person { withAnimation { proxy.scrollTo(Self.end, anchor: .bottom) } }
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
      if !scroll.landed { land(waiting, proxy) }
      try? await Task.sleep(for: .milliseconds(700))
      if !scroll.landed { land(waiting, proxy) }
      scroll.landed = true
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await session.refresh() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(session: session, id: id, thread: thread, words: $words, drafts: drafts, focused: $composing, items: items) { card in
        scroll.landed = true
        withAnimation { show(card, proxy) }
      } jump: {
        // The next card that still waits, after the one last visited, then from the start.
        scroll.landed = true
        let open = waiting.map(\.id)
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

  /// The card the person is at work on, after it grew or the keyboard rose: if its end went under the reply
  /// field, it is brought back over it. A card taller than the page is left where it is: the system keeps the
  /// field being typed in on screen, and the card's end would push that field off the top.
  private func reveal(_ key: String, _ proxy: ScrollViewProxy) {
    guard let whole = cards[key], scroll.height > 0 else { return }
    // The part of the card the person just opened (a reason and its buttons), when it says where it is.
    let card = cards[CardFrames.part].flatMap { $0.intersects(whole) ? $0 : nil } ?? whole
    guard card.height + Self.margin * 2 <= scroll.height, card.maxY + Self.margin > scroll.bottom else { return }
    // By its own distance, not by name: a named scroll rests the card on the page's edge under the keyboard.
    withAnimation(.easeOut(duration: 0.2)) { position.scrollTo(y: scroll.top + card.maxY + Self.margin - scroll.bottom) }
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
  /// The part of a card the person is filling in: a field with its buttons.
  static let part = "part"
  static let defaultValue: [String: CGRect] = [:]
  static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) { value.merge(nextValue()) { $1 } }
}

/// A card the thread can scroll to and keep clear of the reply field: the name's frame reaches a margin past the
/// card on both sides, so a card brought to an edge keeps its air. A touch on it says which card the person is on.
struct CardPlace: ViewModifier {
  let key: String
  @Environment(ScrollBox.self) private var scroll

  func body(content: Content) -> some View {
    content
      .background { GeometryReader { geometry in Color.clear.preference(key: CardFrames.self, value: [key: geometry.frame(in: .named("content"))]) } }
      .simultaneousGesture(TapGesture().onEnded { scroll.act(key) })
      .padding(.vertical, ThreadScreen.margin)
      .id(key)
      .padding(.vertical, -ThreadScreen.margin)
  }
}

extension View {
  func card(_ key: String) -> some View { modifier(CardPlace(key: key)) }

  /// A field and its buttons, opened inside a card: when the keyboard rises it is this, whole, that stays over the
  /// reply field, even in a card taller than the page.
  func cardPart() -> some View {
    background { GeometryReader { geometry in Color.clear.preference(key: CardFrames.self, value: [CardFrames.part: geometry.frame(in: .named("content"))]) } }
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
            place: (index + 1, questions.count), drafts: drafts
          )
          .card(CardID.question(message.id, question.key))
        case .actions(let first, let count):
          ActionChecklist(session: session, thread: thread.threadId, message: message.id, actions: Array(todos[first..<min(first + count, todos.count)]), agent: name, readOnly: !SendPlan.live(message, in: thread), drafts: drafts)
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
  /// What still waits in the thread: the button at the foot says it, and a touch goes to the next one.
  let items: OpenItems
  /// Go to a card.
  let go: (String) -> Void
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
        let said = PhoneWords.notice(notice, computer: session.computer.name, agent: thread.messages.last { $0.author.kind == .agent }.map { Names.agent($0.author) })
        Label(words.isEmpty ? said : "\(said) \(PhoneWords.wordsBack)", systemImage: "exclamationmark.circle")
          .font(.footnote)
          .foregroundStyle(Token.destructive)
          .padding(.horizontal, 6)
      }
      if session.stopped.contains(id), let stale = session.stale[id], !stale.isEmpty {
        StaleGuard(session: session, id: id, thread: thread, stale: stale, words: $words, drafts: drafts, go: go)
      } else if items.shown {
        // The window's own pill: what still wants an answer, and a touch goes to the next one.
        Button(action: jump) {
          HStack(spacing: 6) {
            Image(systemName: "questionmark.circle")
            Text(PhoneWords.openItems(items))
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
    // What scrolls under the reply field fades into it: no card or line is cut through by a hard edge.
    .overlay(alignment: .top) {
      LinearGradient(colors: [Token.background.opacity(0), Token.background], startPoint: .top, endPoint: .bottom)
        .frame(height: 22)
        .offset(y: -22)
        .allowsHitTesting(false)
    }
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

/// A pick the person made was replaced before it went: nothing is sent until they choose (the window's stale
/// guard, packages/inbox/components/ReplacedQuestion.tsx). Answer the new question, send the rest, or keep editing.
struct StaleGuard: View {
  let session: InboxSession
  let id: ThreadID
  let thread: InboxThread
  let stale: [InboxSession.Stale]
  @Binding var words: String
  let drafts: ThreadDrafts
  let go: (String) -> Void

  private func question(_ ref: InboxSession.Stale) -> InboxQuestion? {
    thread.messages.first { $0.id == ref.message }?.questions?.first { $0.key == ref.key }
  }
  private func pick(_ answer: QuestionAnswer?) -> String? {
    guard let answer else { return nil }
    let parts = answer.selected + [answer.other, answer.text].compactMap { $0 }.filter { !$0.isEmpty }
    return parts.isEmpty ? nil : parts.joined(separator: ", ")
  }

  var body: some View {
    let asked = stale.compactMap(question)
    let typed = !words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let others = thread.messages.flatMap { $0.questions ?? [] }.filter { $0.kind != .action && $0.state == .picked }.count
    let first = asked.first?.supersededBy
    VStack(alignment: .leading, spacing: 8) {
      Label(PhoneWords.guardHeading(position: asked.first.map { Int($0.position) }, count: max(stale.count, 1)), systemImage: "exclamationmark.triangle")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Token.foreground)
        .accessibilityAddTraits(.isHeader)
      ForEach(asked, id: \.key) { question in
        if let by = question.supersededBy, let message = thread.messages.first(where: { $0.id == by.messageId }) {
          Text(MessageBody.attributed("\(PhoneWords.guardReplaced(agent: Names.agent(message.author), prompt: question.prompt, at: TimeWords().clock(message.createdAt), by: by.key != nil)) \(PhoneWords.guardPick(pick(question.answer)))"))
            .font(.subheadline)
            .foregroundStyle(Token.foreground)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Text(typed ? PhoneWords.guardWordsGo : others > 0 ? PhoneWords.guardRestGoes : PhoneWords.guardNothingElse)
        .font(.footnote)
        .foregroundStyle(Token.mutedForeground)
        .fixedSize(horizontal: false, vertical: true)
      VStack(spacing: 6) {
        if let first {
          WideButton(words: first.key != nil ? PhoneWords.guardAnswerNew : PhoneWords.guardReadWhy) {
            session.clearStale(id)
            go(first.key.map { CardID.question(first.messageId, $0) } ?? "m/\(first.messageId.rawValue)")
          }
        }
        if typed || others > 0 {
          Button(PhoneWords.guardSendRest(words: typed, picks: others)) {
            drafts.saveAll()
            let text = words
            words = ""
            Task { if !(await session.send(thread: id, words: text, pastGuard: true)), words.isEmpty { words = text } }
          }
          .font(.body.weight(.semibold))
          .foregroundStyle(Token.foreground)
          .frame(maxWidth: .infinity, minHeight: 48)
          .background(Token.foreground.opacity(0.1), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        Button(PhoneWords.guardKeepEditing) { session.clearStale(id) }
          .font(.body)
          .foregroundStyle(Token.foreground)
          .frame(maxWidth: .infinity, minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(ChoiceStyle())
    }
    .padding(14)
    .background(Token.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Token.warning.opacity(0.5)))
    .accessibilityElement(children: .contain)
  }
}
