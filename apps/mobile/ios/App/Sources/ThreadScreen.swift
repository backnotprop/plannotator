import InboxCore
import InboxWire
import SwiftUI

/// A thread: its messages oldest first, questions as cards in place, the composer at the bottom (FLOWS 4, mock 4).
struct ThreadScreen: View {
  let session: InboxSession
  let id: ThreadID
  @State private var words = ""
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
    return ScrollViewReader { proxy in
    ScrollView {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(thread.messages.enumerated()), id: \.element.id) { index, message in
          if index > 0 { Divider().overlay(Token.border).padding(.vertical, 18) }
          MessageView(session: session, thread: id, message: message, showsDelivery: message.id == lastPerson)
        }
      }
      .padding(.horizontal, 20)
      .padding(.top, 12)
      .padding(.bottom, 20)
      Color.clear.frame(height: 1).id(Self.end)
    }
    .defaultScrollAnchor(.bottom)
    // Land at the newest message, and follow a new one in.
    .onChange(of: thread.messages.count, initial: true) { _, _ in proxy.scrollTo(Self.end, anchor: .bottom) }
    .scrollDismissesKeyboard(.interactively)
    .refreshable { await session.refresh() }
    .safeAreaInset(edge: .bottom, spacing: 0) {
      Composer(session: session, id: id, thread: thread, words: $words, focused: $composing)
    }
    }
  }

  private static let end = "end"
}

/// One message: plain text on the page, never a bubble; the person's own in the same column.
struct MessageView: View {
  let session: InboxSession
  let thread: ThreadID
  let message: InboxMessageWire
  let showsDelivery: Bool

  private var questions: [InboxQuestion] { (message.questions ?? []).filter { $0.kind != .action }.sorted { $0.position < $1.position } }

  var body: some View {
    let name = Names.agent(message.author)
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .center, spacing: 10) {
        if message.author.kind == .agent { AgentMark(name: name, size: 28) }
        Text(name).font(.subheadline.weight(.semibold)).foregroundStyle(Token.foreground)
        Text(TimeWords().when(message.createdAt)).font(.subheadline).foregroundStyle(Token.mutedForeground)
      }
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)
      MessageBodyView(text: message.body, hasCards: !(message.questions ?? []).isEmpty)
      ForEach(questions, id: \.key) { question in
        QuestionCard(session: session, thread: thread, message: message.id, question: question)
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
    switch delivery.state {
    case "queued": return Words.deliverySentQueued(name: name)
    case "saved": return Words.deliverySentSaved(name: name)
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
  var focused: FocusState<Bool>.Binding

  private var hasPicks: Bool { thread.messages.contains { ($0.questions ?? []).contains { $0.state == .picked } } }
  private var canSend: Bool { session.canSend(thread: id, words: words) && !session.sending.contains(id) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let notice = session.notices[id] {
        Label(notice, systemImage: "exclamationmark.circle")
          .font(.footnote)
          .foregroundStyle(Token.destructive)
          .padding(.horizontal, 6)
      }
      if session.hasHeldReply(id) {
        Label(PhoneWords.willSendWhenBack(session.computer.name), systemImage: "clock")
          .font(.footnote)
          .foregroundStyle(Token.mutedForeground)
          .padding(.horizontal, 6)
      }
      HStack(alignment: .bottom, spacing: 8) {
        TextField(hasPicks ? PhoneWords.noteOrSend : PhoneWords.reply, text: $words, axis: .vertical)
          .lineLimit(1...6)
          .font(.body)
          .focused(focused)
          .padding(.leading, 16)
          .padding(.vertical, 12)
          .accessibilityLabel(hasPicks ? PhoneWords.noteOrSend : PhoneWords.reply)
        Button {
          let text = words
          Task {
            if await session.send(thread: id, words: text) { words = "" }
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
    .padding(.horizontal, 12)
    .padding(.top, 8)
    .padding(.bottom, 8)
  }
}
