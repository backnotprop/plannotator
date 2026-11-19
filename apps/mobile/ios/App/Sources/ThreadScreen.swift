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
  /// A card the page was sent to before it was built (far up a long thread): shown once its frame arrives.
  @ObservationIgnored var wanted: String?

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
  /// Room added under the last message so the page can rest on a block's start even when the thread ends sooner.
  @State private var room: CGFloat = 0
  /// The keyboard is up. Typing in a card, the foot's button steps aside so the card has the room.
  @State private var keyboard = false
  @Environment(\.dynamicTypeSize) private var typeSize
  private var fade: CGFloat { Composer.fade(typeSize) }
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
        // What came before the newest agent message is built as it scrolls: a long thread lays out, and says where
        // its lines are, only near the screen. Only that part: the newest message and what follows it, and the room
        // under them, are built whole, so a field opened there or the keyboard rising (which change their heights)
        // never makes the lazy part guess its rows' heights again and move what is on screen.
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(shown[..<landing], id: \.id) { message in
            MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts).id("m/\(message.id.rawValue)")
            Rule(key: message.id.rawValue).padding(.top, 14).padding(.bottom, message.id == shown[landing - 1].id ? 2 : 14)
          }
        }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(shown[landing...].enumerated()), id: \.element.id) { index, message in
            if index > 0 { Rule(key: shown[landing + index - 1].id.rawValue).padding(.vertical, 14) }
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
        Color.clear.frame(height: room)
      }
      .padding(.horizontal, 20)
      // The content ends above the reply field's fade, with air: the last card is never under it.
      .padding(.bottom, Self.clear)
      .coordinateSpace(.named(Self.content))
      .onPreferenceChange(CardFrames.self) { now in
        let before = cards
        // What is laid out now, whole: a line that closed (a reason field, a panel) leaves no frame behind.
        var next = now
        next[Self.landing] = cards[Self.landing]
        cards = next
        // Only the card the person just touched follows its own growth (a pick's line, a note field, a reason):
        // a card that changes on its own (another device's answer, a refusal's line) never moves the page.
        if let key = scroll.fresh(within: 1.5), let old = before[key], let frame = now[key], frame.height > old.height + 1 { reveal(key, proxy) }
        // The card a jump went for is built now: rest on it once the rows around it have their own heights and
        // the page has stopped correcting where it is (its card and its top still for a moment).
        if let key = scroll.wanted, before[key] == nil, now[key] != nil {
          Task {
            var last: (CGFloat, CGFloat)?
            for _ in 0..<20 {
              try? await Task.sleep(for: .milliseconds(50))
              guard scroll.wanted == key, let frame = cards[key] else { return }
              let seen = (frame.minY, scroll.top)
              if let last, abs(last.0 - seen.0) < 0.5, abs(last.1 - seen.1) < 0.5 { break }
              last = seen
            }
            guard scroll.wanted == key else { return }
            scroll.wanted = nil
            withAnimation { show(key, proxy) }
          }
        }
      }
      Color.clear.frame(height: 1).id(Self.end)
    }
    // Words fade out under the title bar: no line is cut through by a hard edge.
    .scrollEdgeEffectStyle(.soft, for: .top)
    .toolbarBackground(Token.background, for: .navigationBar)
    .toolbarBackgroundVisibility(.visible, for: .navigationBar)
    .scrollPosition($position)
    // The person moved the page themselves: it has landed, and the second landing never pulls it back.
    .onScrollPhaseChange { _, phase in
      guard phase == .interacting else { return }
      scroll.landed = true
      // And a card a jump still went for is no longer wanted: the person is reading somewhere else.
      scroll.wanted = nil
    }
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
    // The keyboard went (a mark made, a field left): the card the person was on rests whole again, its top
    // under the title bar, never cut where the keyboard had pushed it.
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
      if let key = scroll.fresh(within: 4) { reveal(key, proxy) }
    }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in keyboard = true }
    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in keyboard = false }
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
    // Rows above the newest message keep finding their own heights for a moment after the thread opens: until the
    // person touches or scrolls, and for its first 2 seconds, the page lands again whenever where it lands moved.
    .task {
      let until = Date().addingTimeInterval(2)
      try? await Task.sleep(for: .milliseconds(60))
      if !scroll.landed { land(waiting, proxy) }
      var landedAt = cards[Self.landing]?.minY
      while !scroll.landed, Date() < until {
        try? await Task.sleep(for: .milliseconds(100))
        guard !scroll.landed, let now = cards[Self.landing]?.minY else { continue }
        if landedAt.map({ abs($0 - now) > 0.5 }) ?? true {
          land(waiting, proxy)
          landedAt = now
        }
      }
      scroll.landed = true
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await session.refresh() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(session: session, id: id, thread: thread, words: $words, drafts: drafts, focused: $composing, items: items, inCard: keyboard && !composing) { card in
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

  /// Land on the newest agent message. When what it asks would end under the reply field, the page rests further
  /// down instead, with the card whole over the field.
  private func land(_ waiting: [(id: String, open: Bool)], _ proxy: ScrollViewProxy) {
    guard let start = cards[Self.landing], scroll.height > 0 else { return proxy.scrollTo(Self.landing, anchor: .top) }
    // The card the page lands for is the first that still wants an answer; one already marked or picked in the
    // draft only when nothing else waits.
    let after = waiting.filter { cards[$0.id].map { $0.minY >= start.minY } ?? false }
    var y = start.minY
    if let first = after.first(where: \.open) ?? after.first, let card = cards[first.id] {
      y = rest(for: card, prefer: start.minY)
    }
    settle(at: y, end: start.maxY + Self.clear)
  }

  /// Rest the page's top at `y`. A thread that ends too soon for that is given the room it lacks first, so the
  /// page is never pushed back to rest through the middle of a block.
  private func settle(at y: CGFloat, end: CGFloat) {
    let lacks = max(0, y + scroll.height - end)
    guard abs(lacks - room) > 0.5 else { return position.scrollTo(y: y) }
    room = lacks
    Task {
      try? await Task.sleep(for: .milliseconds(30))
      position.scrollTo(y: y)
    }
  }

  /// Where the page's top rests so that `card` is whole between the title bar and the reply field, as near to
  /// `prefer` as that allows (the nearest place that shows the most above it, when nothing is preferred). A card
  /// taller than the page starts at its own top.
  ///
  /// The page's two edges never cut a line: the top rests on the start of a block or in the air between two, and
  /// the bottom edge, where the reply field's fade begins, is kept off a line too whenever any resting place in
  /// reach allows it. `within`, a card taller than the page, may have its top under the bar (the part the person
  /// opened in it is what must show).
  private func rest(for card: CGRect, prefer: CGFloat? = nil, within: CGRect? = nil) -> CGFloat {
    let own = card.minY - Self.margin
    let need = card.maxY + Self.clear - scroll.height
    guard need <= own else { return own }
    return snap(prefer ?? need, low: need, high: own, within: within)
  }

  /// The resting place between `low` and `high` nearest to `prefer` whose top cuts nothing (and whose bottom cuts
  /// nothing, when one such is in reach).
  private func snap(_ prefer: CGFloat, low: CGFloat, high: CGFloat, within: CGRect?) -> CGFloat {
    let frames = cards.filter { $0.key != Self.landing && $0.key != CardFrames.part }
    let lines = frames.filter { $0.key.hasPrefix("b/") }.map(\.value)
    // A card is no wall: the page may rest inside a tall one, between two of its lines. Only its edges are: its
    // rounded top and foot are never cut (but those of the tall card the person is at work in).
    let edges = frames.filter { !$0.key.hasPrefix("b/") && !$0.key.hasPrefix("e/") }.map(\.value).filter { within == nil || $0 != within }
    // A paragraph that fits in half the page is read whole: the page opens in the middle of its sentences only
    // when no other resting place keeps every line out of the fade.
    let paragraphs = frames.filter { $0.key.hasPrefix("e/") && $0.value.height <= scroll.height / 2 }.map(\.value)
    // A line's box already holds its descent, so a line that ends at the edge is whole.
    func top(_ y: CGFloat, whole: Bool = true) -> Bool {
      if (lines + (whole ? paragraphs : [])).contains(where: { $0.minY < y - 0.5 && $0.maxY > y + 0.5 }) { return false }
      return !edges.contains { card in
        // A card that starts at the edge or just under it: the bar clips its corners. It keeps its air, or most of it.
        if card.minY >= y - 0.5 { return card.minY < y + Self.margin - 3.5 }
        // A card that ends at the edge or just under it, or whose rounded top the edge runs through.
        return (card.maxY > y - 2 && card.maxY < y + Self.corner) || y < card.minY + Self.corner
      }
    }
    // At the bottom, a line that reaches into the fade is cut, however little of it shows.
    let edge = scroll.height
    func clean(_ y: CGFloat) -> Bool {
      let fadeTop: CGFloat = y + edge
      let fadeEnd: CGFloat = fadeTop + fade
      return !lines.contains { line in line.minY < fadeEnd && line.maxY > fadeTop + 0.5 }
    }
    // And a card's top or foot is whole over the fade or past it out of sight: never half in it. A top that shows
    // keeps its air; a foot may touch the fade's first, still clear, points, and a top in its last, solid, point is
    // out of sight.
    func rims(_ y: CGFloat) -> Bool {
      let fadeTop: CGFloat = y + edge
      let fadeEnd: CGFloat = fadeTop + fade
      return !edges.contains { card in
        let top = card.minY < fadeEnd - 1.5 && card.minY + Self.corner > fadeTop - Self.air
        let foot = card.maxY > fadeTop + 2.5 && card.maxY - Self.corner < fadeEnd
        return top || foot
      }
    }
    func bottom(_ y: CGFloat) -> Bool { clean(y) && rims(y) }
    let clamped: CGFloat = min(max(prefer, low), high)
    var places: [CGFloat] = [clamped, low, high]
    // A card keeps its full air under the bar; a line may rest a little closer, or right at the edge when the line
    // above it is hidden whole.
    for (key, frame) in frames {
      places.append(frame.minY - Self.margin)
      places.append(frame.minY - Self.margin + 3)
      places.append(frame.maxY + 4)
      if key.hasPrefix("b/") {
        places.append(frame.minY - 4)
        places.append(frame.minY)
      }
    }
    // Or where the bottom edge falls between two lines: one ends over the fade, the next starts past it.
    for line in lines {
      places.append(line.maxY + 1 - edge)
      places.append(line.minY - fade - 1 - edge)
    }
    // Or where a card's top or foot ends up out of sight, or whole with its air.
    for card in edges {
      places.append(card.minY - fade - edge)
      places.append(card.minY + Self.corner + Self.air - edge)
      places.append(card.maxY + Self.air - edge)
      places.append(card.maxY - 2 - edge)
    }
    // The air over the fade may be given up for it, and the card's own empty foot may go into the fade when
    // nothing cleaner is in reach: no line of it may. When no place keeps both edges clean (large type, a tall
    // card), the top still opens on the start of a sentence and no card's rim shows half in the fade: a line may
    // run into it sooner than a rim may.
    let reach = low - Self.clear - fade
    places = places.filter { y in y >= reach - 0.5 && y <= high + 0.5 && top(y, whole: false) }
    let inside = places.filter { $0 >= low - 0.5 }
    let read = places.filter { top($0) }
    let readInside = inside.filter { top($0) }
    let tests: [(CGFloat) -> Bool] = [bottom, rims, clean]
    let tiers: [[CGFloat]] = tests.flatMap { test in [readInside.filter(test), read.filter(test)] }
      + tests.flatMap { test in [inside.filter(test), places.filter(test)] } + [readInside, read]
    let pool: [CGFloat] = tiers.first { !$0.isEmpty } ?? []
    // Nowhere clean in reach: the card's own top, which cuts nothing above it.
    return pool.min { abs($0 - clamped) < abs($1 - clamped) } ?? high
  }

  /// Bring a card on screen.
  private func show(_ key: String, _ proxy: ScrollViewProxy) {
    guard let card = cards[key], scroll.height > 0 else {
      // A card far up a long thread is not built yet: go to its message, and rest on the card when its frame
      // arrives (onPreferenceChange), however long the way there takes. The hop is not animated: the page could
      // not show the way there anyway, and an animation still running would carry the page past the card.
      let message = key.split(separator: "/").dropFirst().first.map { "m/\($0)" }
      scroll.wanted = key
      // A card that never appears (gone from the thread meanwhile) is not waited for past 2 seconds.
      Task {
        try? await Task.sleep(for: .seconds(2))
        if scroll.wanted == key, cards[key] == nil { scroll.wanted = nil }
      }
      var hop = Transaction()
      hop.disablesAnimations = true
      withTransaction(hop) { proxy.scrollTo(message ?? key, anchor: .top) }
      return
    }
    scroll.wanted = nil
    if let tail = cards[Self.landing] { settle(at: rest(for: card), end: tail.maxY + Self.clear) } else { position.scrollTo(y: rest(for: card)) }
  }

  /// The card the person is at work on, after it grew, the keyboard rose or went: it rests whole between the title
  /// bar and the reply field, its top in view, moving the page as little as that takes. A card taller than the
  /// page keeps the part the person opened (a field with its buttons) in view instead, and shows as much of
  /// itself above that part as fits, from the start of a line.
  private func reveal(_ key: String, _ proxy: ScrollViewProxy) {
    guard let whole = cards[key], scroll.height > 0 else { return }
    let fits = whole.height + Self.margin + Self.clear <= scroll.height
    let part = cards[CardFrames.part].flatMap { $0.intersects(whole) ? $0 : nil }
    let y: CGFloat
    if fits {
      y = rest(for: whole, prefer: scroll.top)
    } else if let part {
      y = rest(for: part, within: whole)
    } else {
      return
    }
    guard abs(y - scroll.top) > 0.5 else { return }
    withAnimation(.easeOut(duration: 0.2)) {
      if let tail = cards[Self.landing] { settle(at: y, end: tail.maxY + Self.clear) } else { position.scrollTo(y: y) }
    }
  }

  private static let end = "end"
  nonisolated private static let landing = "landing"
  nonisolated private static let content = "content"
  /// The air kept between a card and the reply field (or the title bar).
  static let margin: CGFloat = 12
  /// The air kept over the reply field's fade (the fade is part of the foot: the page's room ends where it
  /// begins), so a card resting there keeps its edge and corners.
  static let clear: CGFloat = 12
  /// A card's rounded corner: the part of its top or foot an edge never runs through.
  static let corner: CGFloat = 22
  /// The least air a card's edge keeps over the reply field's fade when it shows.
  static let air: CGFloat = 6
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
      // The cards say it themselves too, from their own actions and fields: VoiceOver and a keyboard make no tap.
      .environment(\.cardKey, key)
      .padding(.vertical, ThreadScreen.margin)
      .id(key)
      .padding(.vertical, -ThreadScreen.margin)
  }
}

/// The lines of a laid out paragraph, in the thread's content coordinates.
enum TextLines {
  static func frames(_ key: String, _ layouts: [Text.LayoutKey.AnchoredLayout], _ geometry: GeometryProxy) -> [String: CGRect] {
    let place = geometry.frame(in: .named("content")).origin
    var frames: [String: CGRect] = [:]
    for (n, anchored) in layouts.enumerated() {
      let origin = geometry[anchored.origin]
      for (index, line) in anchored.layout.enumerated() {
        let bounds = line.typographicBounds.rect
        frames["b/\(key)/\(n)/\(index)"] = CGRect(x: place.x + origin.x + bounds.minX, y: place.y + origin.y + bounds.minY, width: bounds.width, height: bounds.height)
      }
    }
    return frames
  }
}

/// A line inside a card, named after the card it is in.
private struct Rule: View {
  let key: String

  var body: some View {
    Divider().overlay(Token.border).padding(.vertical, 4).blockEdge("rule/\(key)")
  }
}

private struct LineEdge: ViewModifier {
  let name: String
  @Environment(\.cardKey) private var cardKey

  func body(content: Content) -> some View {
    content.background {
      GeometryReader { geometry in Color.clear.preference(key: CardFrames.self, value: ["b/\(cardKey ?? "")/\(name)": geometry.frame(in: .named("content"))]) }
    }
  }
}

private struct CardKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
  /// The name of the card a view is in, so its own actions can say the person is on it.
  var cardKey: String? {
    get { self[CardKey.self] }
    set { self[CardKey.self] = newValue }
  }
}

extension View {
  func card(_ key: String) -> some View { modifier(CardPlace(key: key)) }

  /// The start of a block of words: a place the page's top may rest on. A block whose lines say where they are
  /// (`textLines`) is no wall itself: the page's edge may rest between two of its lines.
  func blockEdge(_ key: String, lined: Bool = false) -> some View {
    background { GeometryReader { geometry in Color.clear.preference(key: CardFrames.self, value: ["\(lined ? "e" : "b")/\(key)": geometry.frame(in: .named("content"))]) } }
  }

  /// Each line of a paragraph, so the page's edges can rest between two lines of it and never through one.
  func textLines(_ key: String) -> some View {
    overlayPreferenceValue(Text.LayoutKey.self) { layouts in
      GeometryReader { geometry in
        Color.clear.preference(key: CardFrames.self, value: TextLines.frames(key, layouts, geometry))
      }
    }
  }

  /// A line (or a row, a field, a code box) inside a card: the page's edges never rest through it.
  func lineEdge(_ name: String) -> some View { modifier(LineEdge(name: name)) }

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
      PermissionCard(session: session, thread: thread, message: message, drafts: drafts).card(CardID.permission(message.id))
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
      .blockEdge("\(message.id.rawValue)/head")
      ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
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
        case .text:
          MessageWords(block: block).textLines("\(message.id.rawValue)/\(index)").blockEdge("\(message.id.rawValue)/\(index)", lined: true)
        default:
          MessageWords(block: block).blockEdge("\(message.id.rawValue)/\(index)")
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
  /// The person types in a card: the foot steps aside until the keyboard goes, all but its fade, so the card has
  /// the room over the keyboard and one field only stands there, the one they type in.
  var inCard = false
  /// Go to a card.
  let go: (String) -> Void
  let jump: () -> Void

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
    if session.hasHeldReply(id), words.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return false }
    if guarded { return false }
    return session.canSend(thread: id, words: words) && !session.sending.contains(id)
  }
  @Environment(\.dynamicTypeSize) private var typeSize
  private var hint: String { hasPicks ? PhoneWords.noteOrSend : PhoneWords.reply }
  /// The stale guard is up: it stands in place of the reply's own actions, as in the window.
  private var guarded: Bool { session.stopped.contains(id) && !(session.stale[id] ?? []).isEmpty }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      // Something to stand on even when empty: the fade and the solid ground under the keyboard stay.
      if inCard { Color.clear.frame(maxWidth: .infinity, maxHeight: 0) } else { foot }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, inCard ? 0 : 8)
    // What scrolls under the reply field fades into it: no card or line is cut through by a hard edge. The fade
    // is part of the foot, so the page's room ends where it begins and nothing rests under it.
    .padding(.top, fade)
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
        .font(.footnote)
        .foregroundStyle(Token.mutedForeground)
        // In line with the page's words and icons above it (the page's margin is 20, the foot's 12).
        .padding(.horizontal, 8)
    }
    // Under the guard only the guard speaks: the refusal behind it names keys.
    if let notice = session.notices[id], !guarded {
      let said = PhoneWords.notice(notice, computer: session.computer.name, agent: thread.messages.last { $0.author.kind == .agent }.map { Names.agent($0.author) })
      Label(words.isEmpty ? said : "\(said) \(PhoneWords.wordsBack)", systemImage: "exclamationmark.circle")
        .font(.footnote)
        .foregroundStyle(Token.destructive)
        .padding(.horizontal, 8)
    }
    if guarded, let stale = session.stale[id] {
      // As wide as the cards above it.
      StaleGuard(session: session, id: id, thread: thread, stale: stale, words: $words, drafts: drafts, go: go).padding(.horizontal, 8)
    } else if items.shown {
      // The window's own pill: what still wants an answer, and a touch goes to the next one.
      Button(action: jump) {
        HStack(spacing: 6) {
          Image(systemName: "questionmark.circle")
          // A number never parts from its noun when the words are large and wrap.
          if let words = PhoneWords.openItems(items) { Text(words.replacing(#/(\d) /#) { "\($0.1)\u{00A0}" }).multilineTextAlignment(.leading) }
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
      .accessibilityLabel(PhoneWords.openItems(items) ?? PhoneWords.allAnswered)
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

  private var box: some View {
    HStack(alignment: .bottom, spacing: 8) {
      TextField("", text: $words, axis: .vertical)
        .lineLimit(1...6)
        .font(.body)
        .focused(focused)
        .padding(.leading, 16)
        .padding(.vertical, 12)
        // The hint whole, never cut: the long one when it fits on the line, else the short one.
        .overlay(alignment: .topLeading) {
          if words.isEmpty {
            ViewThatFits(in: .horizontal) {
              Text(hint).lineLimit(1)
              Text(PhoneWords.reply).lineLimit(1)
            }
            .font(.body)
            .foregroundStyle(Color(uiColor: .placeholderText))
            .padding(.leading, 16)
            .padding(.vertical, 12)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
          }
        }
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
    if answer.skipped == true { return PhoneWords.skipped }
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
          Text(MessageBody.attributed("\(PhoneWords.guardReplaced(agent: Names.agent(message.author), prompt: question.prompt, at: TimeWords().when(message.createdAt), by: by.key != nil)) \(PhoneWords.guardPick(pick(question.answer)))"))
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
          .font(.body.weight(.medium))
          .foregroundStyle(Token.primary)
          .frame(maxWidth: .infinity, minHeight: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(ChoiceStyle())
    }
    .padding([.top, .horizontal], 14)
    // Keep editing's touch area already holds air under its words: the words end as far from the edge as the
    // heading starts.
    .padding(.bottom, 4)
    .background(Token.card, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Token.warning.opacity(0.5)))
    .accessibilityElement(children: .contain)
  }
}
