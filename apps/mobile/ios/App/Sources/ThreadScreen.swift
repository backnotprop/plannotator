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

  /// Where the page rests once it has landed: how far its top is under the start of the newest message's block,
  /// and which message that is. Kept until the person moves the page or touches a card: while it is kept, rows
  /// above that measure themselves again never carry the page off what it landed on.
  @ObservationIgnored var rest: CGFloat?
  @ObservationIgnored var restFor: String?
  /// Where this view last sent the page, and when it last put the page back: a move to anywhere else, at any
  /// other time, is not its own.
  @ObservationIgnored var sentTo: CGFloat = -.infinity
  @ObservationIgnored var keptAt = Date.distantPast

  func act(_ key: String) {
    acted = key
    actedAt = Date()
    landed = true
    rest = nil
  }

  /// The card a reveal may still follow: the one touched within the last few seconds.
  func fresh(within seconds: TimeInterval) -> String? { Date().timeIntervalSince(actedAt) <= seconds ? acted : nil }
}

/// A thread: its messages oldest first, questions as cards in place, the composer at the bottom (FLOWS 4, mock 4).
struct ThreadScreen: View {
  let session: InboxSession
  let id: ThreadID
  /// What the person does to the thread itself (its More menu, the lines over it), and the toast that answers.
  let actions: RowActions
  @Environment(\.dismiss) private var dismiss
  /// How tall the foot is: the toast stands over it.
  @State private var foot: CGFloat = 0
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
  @State private var pageWidth: CGFloat = 0
  /// The file open over the thread.
  @State private var opened: FileOpen?
  /// The list of comments on files that wait for the Send.
  @State private var commentsOpen = false
  /// The toast after a comment is removed from the list, with Undo.
  @State private var commentToasts = CommentToast()
  /// The computer's draft the words in the box came from (sending them clears it there).
  @State private var clearDraft: String?
  /// What Take back is doing here: the message on its way back, a refusal's line, the note over the box.
  @State private var takeBack = TakeBackState()

  init(session: InboxSession, id: ThreadID, actions: RowActions) {
    self.session = session
    self.id = id
    self.actions = actions
    // The words this phone kept for the thread are in the box at once: never an empty box first.
    _words = State(initialValue: session.draft(id)?.words ?? "")
  }

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
    // The thread's row, found once for everything this draw asks of it.
    let row = session.row(id)
    return Group {
      if let thread = model?.thread {
        messages(thread, row: row)
      } else if session.missingThreads.contains(id) {
        Standing(symbol: "tray", words: PhoneWords.threadGone)
      } else if session.reach == .away {
        Standing(symbol: "wifi.slash", words: PhoneWords.awayNoCopy(session.computer.name), action: PhoneWords.tryAgain) { Task { await session.open(id) } }
      } else {
        Waiting()
      }
    }
    .background(Token.background.ignoresSafeArea())
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
    // The title starts beside the way back, as the window's does: one line the size of a message's name, and who
    // and where under it a step quieter. The bar's own title would set both centred and as heavy as a heading.
    // The bar centres what it is given, so the title is given the whole room between the way back and its mirror
    // on the right, and starts at that room's left edge whatever its length.
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pageWidth = $0 }
    .toolbar {
      ToolbarItem(placement: .principal) {
        VStack(alignment: .leading, spacing: Space.hair) {
          Text(title).font(TextRole.name).foregroundStyle(Token.foreground).lineLimit(1).truncationMode(.tail)
          if !subtitle.isEmpty { Text(subtitle).font(TextRole.caption).foregroundStyle(Token.mutedForeground).lineLimit(1).truncationMode(.tail) }
        }
        // Until the page's width is known (the first frame), the title keeps its own.
        .frame(width: pageWidth > 2 * Size.barSide ? pageWidth - 2 * Size.barSide : nil, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        // The bar does not grow with the text: a long press shows the title large, as the system's own does.
        .accessibilityShowsLargeContentViewer { Text(title) }
      }
      // More: what a row's menu offers, for the open thread (the window's ⋯ sheet).
      if let row {
        ToolbarItem(placement: .topBarTrailing) {
          Menu {
            ThreadMenuItems(row: row, drawn: RowOffers.backIn(row), starred: row.pinnedAt != nil, actions: actions, place: .thread)
          } label: {
            Image(systemName: "ellipsis")
          }
          .accessibilityLabel(PhoneWords.more)
        }
      }
    }
    // A file opens over the thread, full screen; closed, the thread is where it was.
    .environment(\.openFile) { item in opened = FileOpen(thread: id, file: item.id) }
    .fullScreenCover(item: $opened) { open in FileCover(session: session, thread: open.thread, start: open.file, seek: open.seek, edits: open.edits) }
    // A comment in the list opens its file, at the comment.
    .sheet(isPresented: $commentsOpen) {
      CommentsSheet(session: session, thread: id, toasts: commentToasts) { comment in
        opened = FileOpen(thread: id, file: comment.attachment, seek: comment)
      } edit: { comment in
        opened = FileOpen(thread: id, file: comment.attachment, seek: comment, edits: true)
      }
    }
    .toastHost(actions, lift: foot)
    .commentToast(commentToasts, lift: foot)
    // Mark unread closes the thread: left open, its next look would read it again.
    .onChange(of: actions.closes) { _, _ in dismiss() }
    // Every change of the words is kept on the phone at once: leaving the thread, the app going to the background or
    // being closed loses nothing.
    .onChange(of: words) { _, now in session.keepDraft(id, words: now) }
    // ↩ on a message (the window's rule): an older one is quoted in the reply and the reply goes to its agent; the
    // newest is a plain Reply, and a quote already in the box goes.
    .environment(\.replyTo) { message in
      session.replyArrow(id, at: message)
      composing = true
    }
    .task {
      let kept = words
      await session.open(id)
      // The computer's draft (the window's), beside the words this phone kept: the newer is in the box and the other
      // follows it, so neither is lost. Only while the person has not typed meanwhile.
      let opening = await session.openDraft(id)
      clearDraft = opening.clearDraft
      if words == kept {
        let merged = [opening.words, opening.otherWords ?? ""].filter { !$0.isEmpty }.joined(separator: "\n\n")
        if merged != words { words = merged }
      }
      // Who `@` can tag in the reply, so the list is there at the first `@`.
      await session.readTaggable(id)
      await session.uploadWaiting(.thread(id))
      // How each of the thread's files stands on the computer now (changed since sent, gone).
      if model?.thread.messages.contains(where: { !($0.attachments ?? []).isEmpty }) == true { await session.readAttachments(id) }
    }
  }

  /// The agent the thread's lines name: the last one to write in it. In a thread a script started, the one the
  /// person's reply goes to, as the window's row names it (`ActionWords.rowRecipient`): the session that took it over,
  /// even when the script posted again after it.
  static func agentName(_ thread: InboxThread, row: InboxListRow?) -> String {
    if let row, Names.isScript(row.author) { return ActionWords.rowRecipient(row) }
    return thread.messages.last { $0.author.kind == .agent }.map { Names.agent($0.author) } ?? PhoneWords.anAgent
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

  private func messages(_ thread: InboxThread, row: InboxListRow?) -> some View {
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
    // A sent reply's quote line goes to the message it quotes.
    let jump: @MainActor (MessageID) -> Void = { to in withAnimation(Motion.fade.animation(still: false)) { proxy.scrollTo("m/\(to.rawValue)", anchor: .top) } }
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        // What came before the newest agent message is built as it scrolls: a long thread lays out, and says where
        // its lines are, only near the screen. Only that part: the newest message and what follows it, and the room
        // under them, are built whole, so a field opened there or the keyboard rising (which change their heights)
        // never makes the lazy part guess its rows' heights again and move what is on screen.
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(shown[..<landing], id: \.id) { message in
            MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts).environment(\.jumpTo, jump).id("m/\(message.id.rawValue)")
            Rule(key: message.id.rawValue).padding(.top, Space.snug).padding(.bottom, message.id == shown[landing - 1].id ? Space.hair : Space.snug)
          }
        }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(shown[landing...].enumerated()), id: \.element.id) { index, message in
            if index > 0 { Rule(key: shown[landing + index - 1].id.rawValue).padding(.vertical, Space.snug) }
            MessageView(session: session, thread: thread, message: message, showsDelivery: message.id == lastPerson, drafts: drafts).environment(\.jumpTo, jump).id("m/\(message.id.rawValue)")
          }
          // A reply that waits for the computer is the person's own message already, said to be waiting.
          ForEach(held) { write in
            Divider().overlay(Token.border).padding(.vertical, Space.card)
            // A reply that is only comments on files says how many it carries; under its words, a line for each.
            let lines = HeldReply.lines(session.heldCommentList(write), files: session.attachments(thread.threadId))
            let to = MessageView.addressee(of: write.message.map { MessageID($0) }, in: thread)
            HeldReply(words: (write.words ?? "").isEmpty && lines.isEmpty ? CountWords.comments(session.heldComments(write)) : write.words ?? "", to: to, computer: session.computer.name, comments: lines, refusal: takeBack.heldRefusal?.id == write.id ? takeBack.heldRefusal?.line : nil) {
              // Nothing has left the phone: Take back puts its words, files, quote and tags back in the box. One on its
              // way to the computer now says so under it, as a refused Take back does.
              if takeBack.takeHeld(session, write: write.id, name: to ?? PhoneWords.anAgent) { composing = true }
            }
          }
        }
        .padding(.top, Space.step)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tail = $0 }
        .onGeometryChange(for: CGRect.self) { $0.frame(in: .named(Self.content)) } action: { now in
          let before = cards[Self.landing]
          cards[Self.landing] = now
          // The block moved after the page had landed, and not by the person's hand: rows above it were measured
          // again (they are built as they scroll, and VoiceOver or a search of the page builds them all). The page
          // stays on what it landed on. A newer message of the agent's is another block: it moves nothing.
          guard scroll.rest != nil, let before, abs(now.minY - before.minY) > 0.5 else { return }
          guard shown.indices.contains(landing), scroll.restFor == shown[landing].id.rawValue else { return scroll.rest = nil }
          scroll.keptAt = Date()
          keepPlace()
        }
        .id(Self.landing)
        // Room under a short last message, so it can still start at the top.
        Color.clear.containerRelativeFrame(.vertical) { length, _ in max(0, length - tail) }
        Color.clear.frame(height: room)
      }
      .padding(.horizontal, Space.page)
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
      // Any scroll that is not the page's own landing is someone moving the page (a finger, a tap on the status
      // bar, VoiceOver's three-finger scroll): the kept place is theirs to take. The page's own landings set its
      // place without animation and never leave idle.
      if phase != .idle { scroll.rest = nil }
      guard phase == .interacting else { return }
      scroll.landed = true
      // And a card a jump still went for is no longer wanted: the person is reading somewhere else.
      scroll.wanted = nil
    }
    // What is on screen, in the content's coordinates. The container's size is already what is left between the
    // title bar and the reply field (and the keyboard, when it is up).
    .onScrollGeometryChange(for: [CGFloat].self) { [$0.contentOffset.y + $0.contentInsets.top, $0.contentOffset.y + $0.contentInsets.top + $0.containerSize.height, $0.contentSize.height] } action: { before, now in
      // The page moved while nothing in it changed size, and not to a place this view sent it: something moved
      // it that has no scroll phase (VoiceOver bringing what it reads into view). The kept place is let go.
      if scroll.rest != nil, abs(now[2] - before[2]) < 0.5, abs(now[0] - before[0]) > 0.5, abs(now[0] - scroll.sentTo) > 1, Date().timeIntervalSince(scroll.keptAt) > Self.landingStill { scroll.rest = nil }
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
      if shown.last?.author.kind == .person {
        scroll.rest = nil
        withAnimation { proxy.scrollTo(Self.end, anchor: .bottom) }
      }
    }
    .onChange(of: held.count) { _, now in
      if now > 0 {
        scroll.rest = nil
        withAnimation { proxy.scrollTo(Self.end, anchor: .bottom) }
      }
    }
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
    // person touches or scrolls, the page lands again whenever what it lands on moved. What it lands on is two
    // things that reach this view by different roads (the newest message's place, measured here; the card's, sent
    // up from the card), so after the rows above measure themselves again one can be new while the other is still
    // old, and a landing made between the two rests in the wrong place. Both are watched: the landing is made
    // again when either moved. It goes on for 2 seconds, and past them while the place is still moving (a late
    // measuring is followed to its end, never left half way), for 2 seconds more at most.
    .task {
      let until = Date().addingTimeInterval(Self.landingTime)
      guard (try? await Task.sleep(for: .milliseconds(60))) != nil else { return }
      if !scroll.landed { land(waiting, proxy) }
      var landedOn = landingMarks(waiting)
      var movedAt = Date()
      while !scroll.landed {
        let now = Date()
        if now >= until.addingTimeInterval(Self.landingTime) { break }
        if now >= until, now.timeIntervalSince(movedAt) >= Self.landingStill { break }
        // The person left the thread: the task is cancelled, and a cancelled sleep returns at once.
        guard (try? await Task.sleep(for: .milliseconds(100))) != nil else { return }
        guard !scroll.landed else { break }
        let marks = landingMarks(waiting)
        if marks != landedOn {
          land(waiting, proxy)
          landedOn = marks
          movedAt = Date()
        }
      }
      // Landed by itself, not by the person's hand: from here the page keeps its place on this message.
      if !scroll.landed, let block = cards[Self.landing], shown.indices.contains(landing) {
        scroll.rest = scroll.top - block.minY
        scroll.restFor = shown[landing].id.rawValue
      }
      scroll.landed = true
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await session.refresh() }
    // Where the thread stands, said under the title bar: snoozed, read, back from a snooze.
    .safeAreaInset(edge: .top, spacing: 0) {
      // The scroll view keeps what is on screen in place under the taller top: nothing is covered when a line
      // comes (a thread rests with its newest message's name row under the title bar, which says the same).
      if let row { ThreadLines(row: row, agent: Self.agentName(thread, row: row), actions: actions) }
    }
    .safeAreaInset(edge: .bottom, spacing: 0) { foot(thread, row: row, items: items, waiting: waiting, proxy: proxy) }
    // A Send the computer refused: the person's words come back to the box, never lost.
    .onChange(of: session.returned[id], initial: true) { _, back in
      guard back != nil, let text = session.takeReturnedWords(id) else { return }
      words = words.isEmpty ? text : "\(text)\n\n\(words)"
    }
    // Take back: the reply's words are the box's now (the computer joined them with its draft), and sending them
    // clears that draft there.
    .onChange(of: session.refilled[id], initial: true) { _, back in
      guard back != nil, let text = session.takeRefilledWords(id) else { return }
      clearDraft = session.computerDraft(id)?.updatedAt
      words = text
      composing = true
    }
    .environment(takeBack)
    }
  }

  /// The thread's foot: the archived line, or the reply box.
  @ViewBuilder private func foot(_ thread: InboxThread, row: InboxListRow?, items: OpenItems, waiting: [(id: String, open: Bool)], proxy: ScrollViewProxy) -> some View {
      if let row, ListRules.archived(row) {
        ArchivedFoot(row: row, agent: Self.agentName(thread, row: row), actions: actions)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { foot = $0 }
      } else {
      Composer(session: session, id: id, thread: thread, words: $words, drafts: drafts, focused: $composing, items: items, inCard: keyboard && !composing, clearDraft: clearDraft, takeBack: takeBack, tell: { actions.tell(ActionWords.failed($0)) }) { card in
        scroll.rest = nil
        scroll.landed = true
        withAnimation { show(card, proxy) }
      } jump: {
        // The next card that still waits, after the one last visited, then from the start.
        scroll.rest = nil
        scroll.landed = true
        let open = waiting.map(\.id)
        guard !open.isEmpty else { return }
        let next = jumped.flatMap { open.firstIndex(of: $0) }.map { open[($0 + 1) % open.count] } ?? open[0]
        jumped = next
        withAnimation { show(next, proxy) }
      } comments: {
        commentsOpen = true
      }
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { foot = $0 }
      }
      }

  /// Where the things a landing reads are now, to the point: the newest message's block, then each card that
  /// waits (-1 for one not laid out yet). A landing is made again when any of them moved.
  private func landingMarks(_ waiting: [(id: String, open: Bool)]) -> [Int] {
    ([cards[Self.landing]] + waiting.map { cards[$0.id] }).flatMap { frame -> [Int] in
      guard let frame else { return [-1, -1] }
      return [Int(frame.minY.rounded()), Int(frame.height.rounded())]
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

  /// Put the page back where it rested on the newest message, after rows above it were measured again. The scroll
  /// view settles its own place over a few frames when its content changes height, so the place is checked a few
  /// times and set again while it is off.
  private func keepPlace() {
    Task {
      for _ in 0..<4 {
        guard (try? await Task.sleep(for: .milliseconds(40))) != nil else { return }
        guard let rest = scroll.rest, let block = cards[Self.landing] else { return }
        let y = block.minY + rest
        scroll.keptAt = Date()
        if abs(scroll.top - y) > 0.5 { settle(at: y, end: block.maxY + Self.clear) }
      }
    }
  }

  /// Rest the page's top at `y`. A thread that ends too soon for that is given the room it lacks first, so the
  /// page is never pushed back to rest through the middle of a block.
  private func settle(at y: CGFloat, end: CGFloat) {
    scroll.sentTo = y
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
    withAnimation(Motion.fade.animation(still: false)) {
      if let tail = cards[Self.landing] { settle(at: y, end: tail.maxY + Self.clear) } else { position.scrollTo(y: y) }
    }
  }

  /// How long the page lands again after a thread opens, and how long its place must have been still before
  /// the landing is taken as final once that time is up.
  private static let landingTime: TimeInterval = 2
  private static let landingStill: TimeInterval = 0.3
  private static let end = "end"
  nonisolated private static let landing = "landing"
  nonisolated private static let content = "content"
  /// The air kept between a card and the reply field (or the title bar).
  static let margin: CGFloat = 12
  /// The air kept over the reply field's fade (the fade is part of the foot: the page's room ends where it
  /// begins), so a card resting there keeps its edge and corners.
  static let clear: CGFloat = 12
  /// A card's rounded corner: the part of its top or foot an edge never runs through.
  static let corner: CGFloat = Radius.card
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
    Divider().overlay(Token.border).padding(.vertical, Space.tight).blockEdge("rule/\(key)")
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
  @Environment(\.replyTo) private var replyTo
  @Environment(\.jumpTo) private var jumpTo
  @Environment(TakeBackState.self) private var takeBack: TakeBackState?

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
    // A quoting reply opens with the lead the Inbox wrote for the agent: drawn as the quote line instead.
    let words = message.author.kind == .person && message.quote != nil ? ReplyQuoteRules.withoutLead(message.body) : message.body
    let blocks = MessageBody.blocks(words, questions: questions.count, actions: todos.count)
    return VStack(alignment: .leading, spacing: Space.step) {
      // Who, then to whom, then when at the line's end: the name is the one strong word.
      HStack(alignment: .center, spacing: 0) {
        HStack(alignment: .center, spacing: Space.close) {
          if message.author.kind == .agent { AgentMark(author: message.author, size: 24) }
          Text(name).font(TextRole.name).foregroundStyle(Token.foreground)
          if message.author.kind == .person, let names = tagNames {
            Text(PhoneWords.toTagged(Self.addressee(of: message, in: thread), names)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
          } else if message.author.kind == .person, let to = Self.addressee(of: message, in: thread) {
            Text(PhoneWords.to(to)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).lineLimit(1)
          }
          Spacer(minLength: Space.close)
          Text(TimeWords().when(message.createdAt)).font(TextRole.meta).monospacedDigit().foregroundStyle(Token.mutedForeground).lineLimit(1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        if let replyTo, SendPlan.live(message, in: thread), !SendPlan.needsComputer(thread) {
          Button { replyTo(message.id) } label: {
            Image(systemName: "arrowshape.turn.up.left").font(TextRole.meta).foregroundStyle(Token.mutedForeground).frame(minWidth: Space.touch, minHeight: Space.touch, alignment: .trailing).contentShape(Rectangle())
          }
          .buttonStyle(PressStyle())
          .accessibilityLabel(PhoneWords.reply)
          .accessibilityIdentifier("reply-to/\(message.id.rawValue)")
        }
      }
      .frame(minHeight: Space.touch)
      .padding(.vertical, -Space.close)
      .blockEdge("\(message.id.rawValue)/head")
      if message.author.kind == .person, let quote = message.quote {
        SentQuoteLine(thread: thread, quote: quote) { jumpTo?($0) }
      }
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
      // The files the message carries, under its words (flow check thread-08).
      let files = session.attachments(of: message, in: thread.threadId)
      if !files.isEmpty { FileTiles(session: session, items: files, thread: thread.threadId).blockEdge("\(message.id.rawValue)/files") }
      if message.author.kind == .agent, let ack = message.ack {
        AckLine(ack: ack, agent: name, wakes: message.wakes == true)
      }
      if showsDelivery { delivery }
      if let refusal = takeBack?.refusal, refusal.id == message.id {
        Text(refusal.line).font(TextRole.meta).foregroundStyle(Token.destructive).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("take-back-refused")
      }
    }
  }

  /// The tags a sent reply carries, as the head names them; nil when it tagged no one.
  private var sentTags: [InboxTag] { message.author.kind == .person ? (message.tags ?? []).filter { $0.handedAway != true } : [] }
  private var owner: (host: String?, session: String?) {
    if let to = message.to { return (to.host, to.session) }
    let asked = message.replyTo.flatMap { reply in thread.messages.first { $0.id.rawValue == reply } }
    return asked?.author.kind == .agent ? (asked?.author.host, asked?.author.session) : (nil, nil)
  }
  private var tagNames: String? {
    let tags = sentTags
    guard !tags.isEmpty else { return nil }
    return tags.map { TagRules.name($0, ownerHost: owner.host, ownerSession: owner.session) }.joined(separator: ", ")
  }

  /// The reply's line, then one for each agent it tagged; Take back beside the first while no agent has it.
  @ViewBuilder private var delivery: some View {
    let offered = takeBack != nil && session.takeBackOffered(thread.threadId, message)
    let first = deliveryLine ?? (offered ? "" : nil)
    if let first {
      ViewThatFits(in: .horizontal) {
        HStack(alignment: .center, spacing: Space.close) {
          if !first.isEmpty { Text(first).font(TextRole.meta).foregroundStyle(Token.mutedForeground).lineLimit(1) }
          // Alone on its line (the Inbox has no line for a reply no agent has yet), its words keep the text's edge.
          if offered { takeBackButton.padding(.leading, first.isEmpty ? -Space.close : 0) }
        }
        VStack(alignment: .leading, spacing: 0) {
          if !first.isEmpty { Text(first).font(TextRole.meta).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true) }
          if offered { takeBackButton.padding(.leading, -Space.close) }
        }
      }
      .padding(.vertical, offered ? -Space.close : 0)
    }
    ForEach(sentTags, id: \.session) { tag in
      let line = TagRules.line(tag, name: TagRules.name(tag, ownerHost: owner.host, ownerSession: owner.session)) { TimeWords().when($0) }
      HStack(alignment: .firstTextBaseline, spacing: Space.close) {
        AgentMark(author: InboxAuthor(kind: .agent, host: tag.host, session: tag.session), size: 16).alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 4 }
        Text(line.text).font(TextRole.meta).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
      }
      .accessibilityElement(children: .combine)
      .accessibilityIdentifier("tag-line/\(tag.session)")
    }
  }

  private var takeBackButton: some View {
    TakeBackButton(busy: takeBack?.busy == message.id) {
      takeBack?.take(session, thread: thread.threadId, message: message.id, name: Self.addressee(of: message, in: thread) ?? PhoneWords.anAgent)
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
  /// One line for each comment on a file it carries: the file's name, then what the comment is on.
  var comments: [(file: String, on: String)] = []
  /// The "Will send when … is back." line. Off where the away banner right above already says it (a new message
  /// waiting in the list).
  var saysWhen = true
  /// Why Take back did not take it back (it was already on its way to the computer).
  var refusal: String?
  /// Take back: nothing has left the phone yet (nil where it cannot be).
  var takeBack: (() -> Void)?

  private var whenLine: some View {
    Label(PhoneWords.willSendWhenBack(computer), systemImage: "clock").font(TextRole.meta).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
  }

  /// The lines for the comments, as the list of comments says them: the file, then the line or the quote.
  static func lines(_ comments: [FileComment], files: [AttachmentItem]) -> [(file: String, on: String)] {
    comments.map { comment in
      let file = files.first { $0.id == comment.attachment }
      let on = comment.codeRange.map { range in "\(range.lineStart == range.lineEnd ? "\(range.lineStart)" : "\(range.lineStart)–\(range.lineEnd)")  \(comment.quote)" }
        ?? (comment.blockId == "image" ? "" : CommentFoot.label(comment, page: file?.kind == .html))
      return (file?.name ?? "", on)
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: Space.step) {
      HStack(spacing: Space.near) {
        Text(PhoneWords.you).font(TextRole.name).foregroundStyle(Token.foreground)
        if let to { Text(PhoneWords.to(to)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).lineLimit(1) }
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      if !words.isEmpty {
        Text(words).font(TextRole.body).foregroundStyle(Token.foreground.opacity(0.75)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
      }
      ForEach(Array(comments.enumerated()), id: \.offset) { _, line in
        HStack(alignment: .firstTextBaseline, spacing: Space.close) {
          Image(systemName: "text.bubble").font(TextRole.meta).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
          (Text(line.file).foregroundStyle(Token.foreground.opacity(0.75)) + Text(line.on.isEmpty ? "" : "  \(line.on)").foregroundStyle(Token.mutedForeground))
            .font(TextRole.secondary)
            .lineLimit(1)
            .truncationMode(.tail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("held-comment")
      }
      if saysWhen {
        ViewThatFits(in: .horizontal) {
          HStack(spacing: Space.close) { whenLine; if let takeBack { TakeBackButton(busy: false, press: takeBack) } }
          VStack(alignment: .leading, spacing: 0) { whenLine; if let takeBack { TakeBackButton(busy: false, press: takeBack).padding(.leading, -Space.close) } }
        }
        .padding(.vertical, takeBack == nil ? 0 : -Space.close)
      }
      if let refusal {
        Text(refusal).font(TextRole.meta).foregroundStyle(Token.destructive).fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("take-back-refused")
      }
    }
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
    VStack(alignment: .leading, spacing: Space.close) {
      Label(PhoneWords.guardHeading(position: asked.first.map { Int($0.position) }, count: max(stale.count, 1)), systemImage: "exclamationmark.triangle")
        .font(TextRole.name)
        .foregroundStyle(Token.foreground)
        .accessibilityAddTraits(.isHeader)
      ForEach(asked, id: \.key) { question in
        if let by = question.supersededBy, let message = thread.messages.first(where: { $0.id == by.messageId }) {
          Text(MessageBody.attributed("\(PhoneWords.guardReplaced(agent: Names.agent(message.author), prompt: question.prompt, at: TimeWords().when(message.createdAt), by: by.key != nil)) \(PhoneWords.guardPick(pick(question.answer)))"))
            .font(TextRole.secondary)
            .foregroundStyle(Token.foreground)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Text(typed ? PhoneWords.guardWordsGo : others > 0 ? PhoneWords.guardRestGoes : PhoneWords.guardNothingElse)
        .font(TextRole.meta)
        .foregroundStyle(Token.mutedForeground)
        .fixedSize(horizontal: false, vertical: true)
      VStack(spacing: Space.trim) {
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
          .actionGround(.neutral)
        }
        Button(PhoneWords.guardKeepEditing) { session.clearStale(id) }.actionGround(.bare, height: Space.touch)
      }
      .buttonStyle(PressStyle())
    }
    .padding([.top, .horizontal], Space.snug)
    // Keep editing's touch area already holds air under its words: the words end as far from the edge as the
    // heading starts.
    .padding(.bottom, Space.tight)
    .background(Token.card, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
    // Amber: this holds the Send up until the person chooses.
    .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Role.hold.ink.opacity(0.5)))
    .accessibilityElement(children: .contain)
  }
}

private struct JumpToKey: EnvironmentKey { static let defaultValue: (@MainActor (MessageID) -> Void)? = nil }
extension EnvironmentValues {
  /// Bring a message of the open thread on screen (a sent reply's quote line).
  var jumpTo: (@MainActor (MessageID) -> Void)? {
    get { self[JumpToKey.self] }
    set { self[JumpToKey.self] = newValue }
  }
}

private struct ReplyToKey: EnvironmentKey { static let defaultValue: (@MainActor (MessageID) -> Void)? = nil }
extension EnvironmentValues {
  /// ↩ on a message of the open thread (nil where there is no reply box).
  var replyTo: (@MainActor (MessageID) -> Void)? {
    get { self[ReplyToKey.self] }
    set { self[ReplyToKey.self] = newValue }
  }
}
