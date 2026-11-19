import InboxCore
import InboxWire
import SwiftUI

/// The Inbox: the computer's sections in the computer's order (FLOWS 3, mock 2).
struct InboxScreen: View {
  let session: InboxSession
  @Environment(AppModel.self) private var model
  @State private var path: [ThreadID] = []
  @Environment(\.openURL) private var openURL

  var body: some View {
    NavigationStack(path: $path) {
      content
        .background(Token.background.ignoresSafeArea())
        .navigationTitle(PhoneWords.inbox)
        .toolbar { ToolbarItem(placement: .topBarLeading) { ComputerMenu(session: session) } }
        .scrollEdgeEffectStyle(.hard, for: .top)
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
      // The copy this phone keeps stays readable; only answering needs the update.
      if session.listLoaded { list } else { Standing(symbol: "arrow.down.app", words: PhoneWords.updatePhone, action: PhoneWords.update) { openURL(AppLinks.update) } }
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
        if session.standing == .appNeedsUpdate {
          UpdateNotice { openURL(AppLinks.update) }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: Self.edge, bottom: 4, trailing: Self.edge))
        } else if session.reach == .away {
          AwayNotice(session: session)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: Self.edge, bottom: 4, trailing: Self.edge))
        }
        ForEach(sections, id: \.id) { section in
          Section {
            ForEach(section.threads, id: \.threadId) { row in
              ZStack {
                NavigationLink(value: row.threadId) { EmptyView() }.opacity(0)
                ThreadRow(row: row, held: session.held.contains { $0.thread == row.threadId.rawValue && $0.kind != .seen })
              }
              .listRowBackground(Token.background)
              // One rhythm: every row has the same air and the same height, and no row has a line another lacks.
              .listRowInsets(EdgeInsets(top: 10, leading: Self.edge, bottom: 10, trailing: Self.edge))
              .listRowSeparator(.hidden)
            }
          } header: {
            // The header and its count read as one line: the product's own name, then how many, quieter.
            // A section this app does not know keeps the computer's label.
            run(Text(Words.sections[section.id.rawValue] ?? section.label).fontWeight(.semibold).foregroundStyle(Token.foreground),
              Text("  \(section.threads.count)").monospacedDigit().foregroundStyle(Token.mutedForeground))
              .font(.subheadline)
              .textCase(nil)
              .frame(maxWidth: .infinity, alignment: .leading)
              .listRowInsets(EdgeInsets(top: 12, leading: Self.edge, bottom: 4, trailing: Self.edge))
              .accessibilityLabel("\(Words.sections[section.id.rawValue] ?? section.label), \(section.threads.count)")
              .accessibilityAddTraits(.isHeader)
          }
          .listSectionSeparator(.hidden)
        }
      }
      .listStyle(.plain)
      .listSectionSpacing(0)
      .scrollContentBackground(.hidden)
      .refreshable { await session.refresh() }
      .overlay {
        if sections.isEmpty {
          ContentUnavailableView(PhoneWords.listEmpty, systemImage: "tray")
        }
      }
    }
  }

  /// The page's one left and right edge: the title, the headers and the rows all start on it.
  static let edge: CGFloat = 16

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
    switch session.standing {
    case .appNeedsUpdate, .inboxNeedsUpdate: return (Token.warning, PhoneWords.stateNeedsUpdate)
    case .removed: return (Token.mutedForeground, PhoneWords.stateRemoved)
    case .ok: break
    }
    switch session.reach {
    case .here: return (Token.success, PhoneWords.stateHere)
    case .away: return (Token.mutedForeground, PhoneWords.stateAway)
    case .connecting: return (Token.warning, PhoneWords.stateConnecting)
    }
  }

  @State private var pairing = false

  var body: some View {
    Menu {
      // Every paired computer: a new pairing never hides another.
      if model.computers.count > 1 {
        ForEach(model.computers) { computer in
          Button {
            if computer.id != session.computer.id { model.use(computer) }
          } label: {
            if computer.id == session.computer.id { Label(computer.name, systemImage: "checkmark") } else { Text(computer.name) }
          }
        }
        Divider()
      }
      if !model.isDemo {
        Button { pairing = true } label: { Label(PhoneWords.pairAnother, systemImage: "qrcode.viewfinder") }
      }
      Button(role: .destructive) {
        Task { await model.removeThisPhone() }
      } label: {
        Label(model.isDemo ? PhoneWords.leaveDemo : PhoneWords.removeThisPhone, systemImage: "iphone.slash")
      }
    } label: {
      HStack(spacing: 8) {
        Circle().fill(state.0).frame(width: 9, height: 9)
        Text(session.computer.name).font(.headline).foregroundStyle(Token.foreground).lineLimit(1)
        if model.isDemo {
          // The stand-in computer is never mistaken for a real one.
          Text(PhoneWords.demoMark)
            .font(.caption.weight(.semibold))
            .foregroundStyle(Token.mutedForeground)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Token.muted, in: Capsule())
        }
        Image(systemName: "chevron.down").font(.caption.weight(.bold)).foregroundStyle(Token.mutedForeground)
      }
      .padding(.horizontal, 6)
      .frame(minHeight: 44)
      .contentShape(Rectangle())
    }
    .accessibilityLabel([session.computer.name, model.isDemo ? PhoneWords.demoMark : nil, state.1].compactMap { $0 }.joined(separator: ", "))
    .sheet(isPresented: $pairing) { PairingScreen(another: true).environment(model) }
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

/// The line under the title while this app is too old for the computer: what to do, and what still works.
struct UpdateNotice: View {
  let update: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        // As large as the words beside it.
        Image(systemName: "arrow.down.app").font(.subheadline.weight(.semibold)).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(PhoneWords.updatePhone).fontWeight(.semibold)
          Text(PhoneWords.updateStillReads).foregroundStyle(Token.mutedForeground)
        }
        .font(.subheadline)
        .foregroundStyle(Token.foreground)
      }
      .accessibilityElement(children: .combine)
      WideButton(words: PhoneWords.update, action: update)
    }
    .padding(12)
    .background(Token.muted, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}

/// The one thing to do on a screen: the whole width, 50 points tall, filled.
struct WideButton: View {
  let words: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(words)
        .font(.body.weight(.semibold))
        .foregroundStyle(Token.primaryForeground)
        .frame(maxWidth: .infinity, minHeight: 50)
        .background(Token.primary, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .contentShape(Rectangle())
    }
    .buttonStyle(ChoiceStyle())
  }
}

/// Where the app sends the person outside itself.
enum AppLinks {
  /// The App Store. The app has no listing yet (no Apple account in this slice): once it has one, its own page
  /// goes here, so Update opens the app's page and not the store's front.
  static let update = URL(string: "itms-apps://apps.apple.com")!
}

/// One thread in the list.
struct ThreadRow: View {
  let row: InboxListRow
  let held: Bool

  @Environment(\.dynamicTypeSize) private var typeSize
  private var large: Bool { typeSize.isAccessibilitySize }

  private var title: String { row.threadName ?? row.subject ?? row.project.name }
  /// At the largest sizes the project alone: the agent's mark already says who.
  private var lead: String { large ? row.project.name : "\(Names.agent(row.author)) · \(row.project.name)" }
  private var time: String { TimeWords().short(row.lastAt) }
  /// The row's two marks as the window draws them (`rowMarks`): each has its own number and its own step.
  private var marks: RowMarks { RowMarks(row) }
  /// What the marks say to a screen reader: the state in words, never by colour alone.
  private var spoken: String? {
    if held { return PhoneWords.willSend }
    let words = PhoneWords.markWords(marks)
    return words.isEmpty ? nil : words.joined(separator: ", ")
  }

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      AgentMark(author: row.author)
      VStack(alignment: .leading, spacing: 2) {
        if large {
          // At the largest sizes the title keeps the whole line; the time and the count share the next one.
          titleText
          leadText
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            timeText
            Spacer(minLength: 4)
            counts
          }
        } else {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            titleText
            Spacer(minLength: 4)
            timeText.layoutPriority(1)
          }
          // The count has one place: the end of this line. It never wraps onto a line of its own.
          HStack(alignment: .center, spacing: 8) {
            leadText
            Spacer(minLength: 4)
            counts.layoutPriority(1)
          }
          // The line is as tall with a count as without one.
          .frame(minHeight: 22)
        }
        // The same number of lines in every row, so the list scans.
        Text(row.latestPreview ?? " ")
          .font(.subheadline)
          .foregroundStyle(row.unread ? Token.foreground : Token.mutedForeground)
          .lineLimit(large ? 3 : 1)
          .truncationMode(.tail)
          .padding(.top, 1)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel([row.unread ? PhoneWords.unreadMark : nil, title, "\(Names.agent(row.author)) · \(row.project.name)", spoken, row.latestPreview, time].compactMap { $0 }.joined(separator: ", "))
    .accessibilityAddTraits(.isButton)
  }

  private var titleText: some View {
    Text(title)
      .font(.headline.weight(row.unread ? .semibold : .regular))
      .foregroundStyle(Token.foreground)
      .lineLimit(large ? 2 : 1)
      .truncationMode(.tail)
  }

  private var timeText: some View {
    Text(time).font(.subheadline).monospacedDigit().foregroundStyle(Token.mutedForeground).lineLimit(1)
  }

  private var leadText: some View {
    Text(lead).font(.subheadline).foregroundStyle(Token.mutedForeground).lineLimit(1).truncationMode(.tail)
  }

  /// What waits, compact, as the window's row has it (packages/inbox/components/RowBadge.tsx): the action box
  /// and the question mark, each coloured by its own step. Open is quiet (the question mark plain, the action box a
  /// neutral pill); held-up work is amber; a stopped agent is red.
  @ViewBuilder private var counts: some View {
    if held {
      Text(PhoneWords.willSend)
        .font(.footnote.weight(.semibold))
        .foregroundStyle(Token.foreground)
        .padding(.horizontal, 8)
        .frame(height: 22)
        .background(Token.muted, in: Capsule())
        .fixedSize()
    } else if marks.actions + marks.questions > 0 {
      HStack(spacing: 6) {
        if marks.actions > 0 { CountMark(symbol: "checklist", count: marks.actions, step: marks.action, boxed: true) }
        if marks.questions > 0 { CountMark(symbol: "questionmark.bubble", count: marks.questions, step: marks.question, boxed: false) }
      }
      .fixedSize()
    }
  }
}

/// One count in a row: its mark and its number ("99+" past 99).
private struct CountMark: View {
  let symbol: String
  let count: Int
  let step: RowMarks.Step
  /// The action box keeps a pill when it is open; the question mark is plain text then.
  let boxed: Bool

  private var ink: Color {
    switch step {
    case .stop: return Token.destructive
    case .hold: return Token.warning
    case .open: return boxed ? Token.foreground : Token.mutedForeground
    }
  }

  var body: some View {
    HStack(spacing: 3) {
      Image(systemName: symbol).font(.caption2.weight(.semibold))
      Text(RowMarks.shown(count)).font(.footnote.weight(step == .open && !boxed ? .regular : .semibold)).monospacedDigit()
    }
    .foregroundStyle(ink)
    .padding(.horizontal, step == .open && !boxed ? 2 : 8)
    // As tall as its words at any text size: the mark never spills out of its pill.
    .padding(.vertical, 2)
    .frame(minHeight: 22)
    .background(step == .open ? (boxed ? Token.muted : Color.clear) : ink.opacity(0.14), in: Capsule())
    .accessibilityHidden(true)
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
    VStack(spacing: 0) {
      ContentUnavailableView {
        Label(words, systemImage: symbol)
      } description: {
        if !details.isEmpty {
          VStack(spacing: 6) { ForEach(details, id: \.self) { Text($0) } }
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      // The one thing to do: the whole width, never a small capsule.
      if let action, let run { WideButton(words: action, action: run).padding(.horizontal, 24).padding(.top, 4) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
