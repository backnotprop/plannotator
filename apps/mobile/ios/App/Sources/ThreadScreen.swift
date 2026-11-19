import InboxCore
import InboxWire
import SwiftUI

/// A thread: its messages oldest first, questions as cards in place, the composer at the bottom (FLOWS 4, mock 4).
struct ThreadScreen: View {
  let session: InboxSession
  let id: ThreadID
  @State private var words = ""
  @State private var drafts = ThreadDrafts()
  @State private var tail: CGFloat = 0
  @State private var landed = false
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

  private func messages(_ thread: InboxThread) -> some View {
    let lastPerson = thread.messages.last { $0.author.kind == .person }?.id
    // Where the thread lands: the newest agent message, at the top of the page, with what follows it. A message
    // is never cut in half by the title bar: it starts whole, as a page does.
    let landing = thread.messages.lastIndex { $0.author.kind == .agent } ?? 0
    let replyTime = { (reply: String) in thread.messages.first { $0.id.rawValue == reply }?.createdAt }
    return ScrollViewReader { proxy in
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(thread.messages[..<landing], id: \.id) { message in
          MessageView(session: session, thread: id, message: message, showsDelivery: message.id == lastPerson, drafts: drafts, replyTime: replyTime)
          Divider().overlay(Token.border).padding(.top, 18).padding(.bottom, message.id == thread.messages[landing - 1].id ? 6 : 18)
        }
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(thread.messages[landing...].enumerated()), id: \.element.id) { index, message in
            if index > 0 { Divider().overlay(Token.border).padding(.vertical, 18) }
            MessageView(session: session, thread: id, message: message, showsDelivery: message.id == lastPerson, drafts: drafts, replyTime: replyTime)
          }
        }
        .padding(.top, 12)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { tail = $0 }
        .id(Self.landing)
        // Room under a short last message, so it can still start at the top.
        Color.clear.containerRelativeFrame(.vertical) { length, _ in max(0, length - tail) }
      }
      .padding(.horizontal, 20)
      .padding(.bottom, 20)
      Color.clear.frame(height: 1).id(Self.end)
    }
    // The title bar is a hard edge: no message runs under the title or the status bar.
    .scrollEdgeEffectStyle(.hard, for: .top)
    .toolbarBackground(Token.background, for: .navigationBar)
    .toolbarBackgroundVisibility(.visible, for: .navigationBar)
    // A new message from an agent lands the same way; the person's own Send is followed to the end.
    .onChange(of: thread.messages.count) { _, _ in
      withAnimation {
        if thread.messages.last?.author.kind == .person { proxy.scrollTo(Self.end, anchor: .bottom) } else { proxy.scrollTo(Self.landing, anchor: .top) }
      }
    }
    // Land once the page is measured (a thread already on the phone is laid out before it is on screen).
    .onChange(of: tail) { _, _ in
      guard !landed else { return }
      // After the room under the last message is laid out, not before.
      Task {
        try? await Task.sleep(for: .milliseconds(40))
        if !landed { proxy.scrollTo(Self.landing, anchor: .top) }
      }
    }
    .task {
      try? await Task.sleep(for: .milliseconds(60))
      proxy.scrollTo(Self.landing, anchor: .top)
      try? await Task.sleep(for: .milliseconds(700))
      proxy.scrollTo(Self.landing, anchor: .top)
      landed = true
    }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await session.refresh() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(session: session, id: id, thread: thread, words: $words, drafts: drafts, focused: $composing)
    }
    // A Send the computer refused: the person's words come back to the box, never lost.
    .onChange(of: session.returned[id], initial: true) { _, back in
      guard back != nil, let text = session.takeReturnedWords(id) else { return }
      words = words.isEmpty ? text : "\(text)\n\n\(words)"
    }
    }
  }

  private static let end = "end"
  private static let landing = "landing"
}

/// One message: plain text on the page, never a bubble; the person's own in the same column.
struct MessageView: View {
  let session: InboxSession
  let thread: ThreadID
  let message: InboxMessageWire
  let showsDelivery: Bool
  let drafts: ThreadDrafts
  /// When a reply was written, by its id.
  var replyTime: (String) -> String? = { _ in nil }

  private var actions: [InboxQuestion] { (message.actions ?? (message.questions ?? []).filter { $0.kind == .action }).sorted { $0.position < $1.position } }
  private var questions: [InboxQuestion] { (message.questions ?? []).filter { $0.kind != .action }.sorted { $0.position < $1.position } }

  var body: some View {
    let name = Names.agent(message.author)
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        if message.author.kind == .agent { AgentMark(author: message.author, size: 28) }
        Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(Token.foreground)
        Text(TimeWords().when(message.createdAt)).font(.subheadline).foregroundStyle(Token.mutedForeground)
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      MessageBodyView(text: message.body, hasCards: !(message.questions ?? []).isEmpty || !(message.actions ?? []).isEmpty)
      ForEach(questions, id: \.key) { question in
        QuestionCard(session: session, thread: thread, message: message.id, question: question, sentAt: question.sentReplyId.flatMap(replyTime), drafts: drafts)
      }
      // Action items are shown; marking one Done or Can't do it is on the computer in this slice.
      ForEach(actions, id: \.key) { action in
        VStack(alignment: .leading, spacing: 6) {
          Text(Words.labelActionItem).font(.subheadline).foregroundStyle(Token.mutedForeground)
          Text(action.prompt).font(.body.weight(.semibold)).foregroundStyle(Token.foreground).fixedSize(horizontal: false, vertical: true)
          Label(PhoneWords.markOnComputer, systemImage: "desktopcomputer").font(.subheadline).foregroundStyle(Token.mutedForeground)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Token.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .accessibilityElement(children: .combine)
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

/// The composer: the words, and Send. Send posts every saved pick in the thread with whatever words are here.
struct Composer: View {
  let session: InboxSession
  let id: ThreadID
  let thread: InboxThread
  @Binding var words: String
  let drafts: ThreadDrafts
  var focused: FocusState<Bool>.Binding

  private var hasPicks: Bool { thread.messages.contains { ($0.questions ?? []).contains { $0.state == .picked } } }
  /// The words of Sends that wait for the computer, so the person sees what will go.
  private var heldWords: [String] { session.held.filter { $0.kind == .reply && $0.thread == id.rawValue }.compactMap(\.words).filter { !$0.isEmpty } }
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
      if session.reach == .away {
        // The thread says it too: what is done here waits on the phone.
        Label(PhoneWords.away(session.computer.name), systemImage: "moon.fill")
          .font(.footnote)
          .foregroundStyle(Token.mutedForeground)
          .padding(.horizontal, 6)
      }
      if let notice = session.notices[id] {
        Label("\(PhoneWords.notice(notice, computer: session.computer.name)) \(PhoneWords.wordsBack)", systemImage: "exclamationmark.circle")
          .font(.footnote)
          .foregroundStyle(Token.destructive)
          .padding(.horizontal, 6)
      }
      if session.hasHeldReply(id) {
        VStack(alignment: .leading, spacing: 4) {
          Label(PhoneWords.willSendWhenBack(session.computer.name), systemImage: "clock")
            .font(.footnote)
            .foregroundStyle(Token.mutedForeground)
          ForEach(heldWords, id: \.self) { text in
            Label { Text(text).font(.subheadline).foregroundStyle(Token.foreground).lineLimit(3) } icon: { Image(systemName: "clock").hidden() }.font(.footnote)
          }
        }
        .padding(.horizontal, 6)
        .accessibilityElement(children: .combine)
      }
      if SendPlan.needsComputer(thread) {
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
