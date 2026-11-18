import InboxCore
import InboxWire
import SwiftUI

/// The Inbox: the computer's sections in the computer's order (FLOWS 3, mock 2).
struct InboxScreen: View {
  let session: InboxSession
  @Environment(AppModel.self) private var model
  @State private var path: [ThreadID] = []

  var body: some View {
    NavigationStack(path: $path) {
      content
        .background(Token.background.ignoresSafeArea())
        .navigationTitle(PhoneWords.inbox)
        .toolbar { ToolbarItem(placement: .topBarLeading) { ComputerMenu(session: session) } }
        .navigationDestination(for: ThreadID.self) { id in ThreadScreen(session: session, id: id) }
    }
    .onChange(of: model.opening, initial: true) { _, id in
      if let id {
        path = [id]
        model.opening = nil
      }
    }
  }

  @ViewBuilder private var content: some View {
    switch session.standing {
    case .appNeedsUpdate:
      Standing(symbol: "arrow.down.app", words: PhoneWords.updatePhone)
    case .inboxNeedsUpdate:
      Standing(symbol: "desktopcomputer.and.arrow.down", words: PhoneWords.updateComputer(session.computer.name))
    case .removed:
      Standing(symbol: "iphone.slash", words: PhoneWords.removedByComputer(session.computer.name), action: PhoneWords.pairAgain) { Task { await model.removeThisPhone() } }
    case .ok:
      list
    }
  }

  private var sections: [InboxListSection] { (session.list?.sections ?? []).filter { !$0.threads.isEmpty } }

  @ViewBuilder private var list: some View {
    if !session.listLoaded {
      if session.reach == .away {
        Standing(symbol: "wifi.slash", words: PhoneWords.awayNoCopy(session.computer.name), details: awayNeeds, action: PhoneWords.tryAgain) { Task { await session.refresh() } }
      } else {
        ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      List {
        if session.reach == .away {
          AwayNotice(session: session)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
        }
        ForEach(sections, id: \.id) { section in
          Section {
            ForEach(Array(section.threads.enumerated()), id: \.element.threadId) { index, row in
              ZStack {
                NavigationLink(value: row.threadId) { EmptyView() }.opacity(0)
                ThreadRow(row: row, held: session.held.contains { $0.thread == row.threadId.rawValue && $0.kind != .seen })
              }
              .listRowBackground(Token.background)
              .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 10, trailing: 20))
              .listRowSeparatorTint(Token.border)
              .listRowSeparator(.hidden, edges: index == section.threads.count - 1 ? .all : .top)
              .alignmentGuide(.listRowSeparatorLeading) { _ in 48 }
            }
          } header: {
            HStack {
              // The product's own name for the section; a section this app does not know keeps the computer's label.
              Text(Words.sections[section.id.rawValue] ?? section.label)
              Spacer()
              Text(section.threads.count, format: .number).monospacedDigit()
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(Token.mutedForeground)
            .textCase(nil)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .refreshable { await session.refresh() }
      .overlay {
        if sections.isEmpty {
          ContentUnavailableView(PhoneWords.listEmpty, systemImage: "tray")
        }
      }
    }
  }

  private var awayNeeds: [String] {
    session.computer.addresses.map {
      if case .wifi = $0 { return PhoneWords.pairNeedsWifi }
      return PhoneWords.pairNeedsTailnet
    }
  }
}

/// The computer's name with its state dot. Removing this phone lives here until the switcher (slice S4).
struct ComputerMenu: View {
  let session: InboxSession
  @Environment(AppModel.self) private var model

  private var state: (Color, String) {
    switch session.reach {
    case .here: return (Token.success, PhoneWords.stateHere)
    case .away: return (Token.mutedForeground, PhoneWords.stateAway)
    case .connecting: return (Token.warning, PhoneWords.stateConnecting)
    }
  }

  var body: some View {
    Menu {
      Button(role: .destructive) {
        Task { await model.removeThisPhone() }
      } label: {
        Label(model.isDemo ? PhoneWords.leaveDemo : PhoneWords.removeThisPhone, systemImage: "iphone.slash")
      }
    } label: {
      HStack(spacing: 8) {
        Circle().fill(state.0).frame(width: 9, height: 9)
        Text(session.computer.name).font(.headline).foregroundStyle(Token.foreground).lineLimit(1)
        Image(systemName: "chevron.down").font(.caption.weight(.bold)).foregroundStyle(Token.mutedForeground)
      }
      .padding(.horizontal, 6)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .accessibilityLabel("\(session.computer.name), \(state.1)")
  }
}

/// The line under the title while the computer does not answer (FLOWS 12).
struct AwayNotice: View {
  let session: InboxSession

  var body: some View {
    let waiting = session.held.filter { $0.kind != .seen }.count
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Image(systemName: "moon.fill").font(.footnote).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(PhoneWords.away(session.computer.name))
        if waiting > 0 { Text(PhoneWords.willSendWhenBack(session.computer.name)) }
      }
      .font(.subheadline)
      .foregroundStyle(Token.foreground)
      Spacer(minLength: 0)
    }
    .padding(12)
    .background(Token.muted, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// One thread in the list.
struct ThreadRow: View {
  let row: InboxListRow
  let held: Bool

  private var title: String { row.threadName ?? row.subject ?? row.project.name }
  private var lead: String { "\(Names.agent(row.author)) · \(row.project.name)" }
  private var time: String { TimeWords().short(row.lastAt) }
  private var tag: String? {
    if held { return PhoneWords.willSend }
    let waiting = CountWords.waiting(open: Int(row.questions.openValue + row.questions.picked), actions: Int(row.questions.actions ?? 0))
    return waiting.isEmpty ? nil : waiting
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AgentMark(name: Names.agent(row.author))
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(title)
            .font(.headline.weight(row.unread ? .semibold : .regular))
            .foregroundStyle(Token.foreground)
            .lineLimit(2)
          Spacer(minLength: 4)
          Text(time).font(.subheadline).foregroundStyle(Token.mutedForeground).layoutPriority(1)
        }
        ViewThatFits(in: .horizontal) {
          HStack(spacing: 8) {
            leadText
            Spacer(minLength: 4)
            tagView
          }
          VStack(alignment: .leading, spacing: 4) {
            leadText
            tagView
          }
        }
        if let preview = row.latestPreview, !preview.isEmpty {
          Text(preview)
            .font(.subheadline)
            .foregroundStyle(row.unread ? Token.foreground : Token.mutedForeground)
            .lineLimit(2)
        }
      }
    }
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel([row.unread ? PhoneWords.unreadMark : nil, title, lead, tag, row.latestPreview, time].compactMap { $0 }.joined(separator: ", "))
    .accessibilityAddTraits(.isButton)
  }

  private var leadText: some View {
    Text(lead).font(.subheadline).foregroundStyle(Token.mutedForeground).lineLimit(1)
  }

  @ViewBuilder private var tagView: some View {
    if let tag {
      Text(tag)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(held ? Token.foreground : Token.primaryForeground)
        .padding(.horizontal, 10)
        .padding(.vertical, 3)
        .background(held ? Token.muted : Token.primary, in: Capsule())
        .fixedSize()
    }
  }
}

/// A whole-screen state with its words, and at most one thing to do about it.
struct Standing: View {
  let symbol: String
  let words: String
  var details: [String] = []
  var action: String?
  var run: (() -> Void)?

  var body: some View {
    ContentUnavailableView {
      Label(words, systemImage: symbol)
    } description: {
      if !details.isEmpty {
        VStack(spacing: 6) { ForEach(details, id: \.self) { Text($0) } }
      }
    } actions: {
      if let action, let run { Button(action, action: run).buttonStyle(.borderedProminent) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
