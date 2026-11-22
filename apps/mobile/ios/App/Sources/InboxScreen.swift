import InboxCore
import InboxWire
import SwiftUI

/// Where the list leads.
enum ListRoute: Hashable {
  case thread(ThreadID)
  case archived
}

/// The Inbox: the window's groups in the window's order (FLOWS 3, mock 2). A row is touched to open it, swiped to
/// mark it read or archive it, and held for its menu; Select picks several.
struct InboxScreen: View {
  let session: InboxSession
  @Environment(AppModel.self) private var model
  @State private var path: [ListRoute] = []
  @State private var actions: RowActions
  /// Which groups are closed: this phone's own choice, kept in the window's form.
  @AppStorage("listFolds") private var foldsRaw = ""
  @State private var loaded = Date()
  @Environment(\.openURL) private var openURL
  @Environment(\.accessibilityReduceMotion) private var still

  init(session: InboxSession) {
    self.session = session
    _actions = State(initialValue: RowActions(session: session))
  }

  private var folds: ListFolds { ListFolds(foldsRaw, loaded: loaded) }
  private var selecting: Bool { actions.selecting }

  var body: some View {
    // The list as drawn now, worked out once for the bar, the rows and the picks.
    let view = session.listView()
    return NavigationStack(path: $path) {
      content(view)
        .background(Token.background.ignoresSafeArea())
        // While picking the large title says how many are picked (as Mail's does): the bar keeps its kind, so
        // nothing moves as picking starts or ends, and the large title is back after Done.
        .navigationTitle(selecting ? (actions.picked.isEmpty ? PhoneWords.tapToSelect : PhoneWords.selected(actions.picked.count)) : PhoneWords.inbox)
        .toolbar { bar(view) }
        .toolbar(selecting ? .visible : .hidden, for: .bottomBar)
        .scrollEdgeEffectStyle(.hard, for: .top)
        // The picks' bar floats over the list: the rows end under a hard edge, never read between its buttons.
        .scrollEdgeEffectStyle(selecting ? .hard : .automatic, for: .bottom)
        .toastHost(actions)
        .navigationDestination(for: ListRoute.self) { route in
          switch route {
          case .thread(let id): ThreadScreen(session: session, id: id, actions: actions)
          case .archived: ArchivedScreen(session: session, actions: actions)
          }
        }
    }
    .rowActionSheets(actions)
    .onChange(of: model.opening, initial: true) { _, id in
      if let id {
        path = [.thread(id)]
        model.opening = nil
      }
    }
    // An act that waited on the phone and was not taken is said once, when the computer is back.
    .onChange(of: session.actionNotices) { _, _ in actions.told() }
  }

  @ToolbarContentBuilder private func bar(_ view: ListView?) -> some ToolbarContent {
    if selecting {
      let every = Self.shown(view).filter { folds.isOpen($0.id) }.flatMap(\.threads).map(\.threadId)
      let all = !every.isEmpty && every.allSatisfy(actions.picked.contains)
      ToolbarItem(placement: .topBarLeading) {
        Button(PhoneWords.selectAll) {
          actions.picked = all ? actions.picked.subtracting(every) : actions.picked.union(every)
        }
        .accessibilityAddTraits(all ? .isSelected : [])
      }
      ToolbarItem(placement: .confirmationAction) { Button(PhoneWords.done) { actions.stopSelecting() } }
      ToolbarItemGroup(placement: .bottomBar) { PickBar(actions: actions, view: view) }
    } else {
      ToolbarItem(placement: .topBarLeading) { ComputerMenu(session: session) }
    }
  }

  @ViewBuilder private func content(_ view: ListView?) -> some View {
    switch session.standing {
    case .appNeedsUpdate:
      // The copy this phone keeps stays readable; only answering needs the update.
      if session.listLoaded { list(view) } else { Standing(symbol: "arrow.down.app", words: PhoneWords.updatePhone, action: PhoneWords.update) { openURL(AppLinks.update) } }
    case .inboxNeedsUpdate:
      Standing(symbol: "desktopcomputer.and.arrow.down", words: PhoneWords.updateComputer(session.computer.name))
    case .removed:
      Standing(symbol: "iphone.slash", words: PhoneWords.removedByComputer(session.computer.name), action: PhoneWords.pairAgain) { Task { await model.removeThisPhone() } }
    case .ok:
      list(view)
    }
  }

  /// The groups with rows: Priority, the sections, then the Snoozed band.
  private static func shown(_ view: ListView?) -> [InboxListSection] { (view?.groups ?? []).filter { !$0.threads.isEmpty } }

  private func toggle(_ id: InboxListGroupId, in groups: [InboxListSection]) {
    var next = folds
    next.toggle(id)
    // A group that closes lets its picks go: nothing is ever done to rows that cannot be seen.
    if selecting, !next.isOpen(id), let group = groups.first(where: { $0.id == id }) {
      actions.picked.subtract(group.threads.map(\.threadId))
    }
    withAnimation(Motion.fade.animation(still: still)) { foldsRaw = next.raw }
  }

  @ViewBuilder private func list(_ view: ListView?) -> some View {
    if !session.listLoaded {
      if session.reach == .away {
        Standing(symbol: "wifi.slash", words: PhoneWords.awayNoCopy(session.computer.name), details: awayNeeds, action: PhoneWords.tryAgain) { Task { await session.refresh() } }
      } else {
        Waiting()
      }
    } else {
      let groups = Self.shown(view)
      let pins = view?.pins ?? []
      let starred = Set(pins.map(\.threadId))
      let held = Set(session.held.filter(session.willSend).map(\.thread))
      let archived = session.archivedRows().count
      let folds = folds
      List(selection: $actions.picked) {
        if session.standing == .appNeedsUpdate {
          UpdateNotice { openURL(AppLinks.update) }.listPlain()
        } else if session.reach == .away {
          AwayNotice(session: session).listPlain()
        }
        if !pins.isEmpty, !selecting {
          StarredPills(pins: pins, actions: actions) { path.append(.thread($0)) }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: Space.tight, leading: 0, bottom: Space.tight, trailing: 0))
            .selectionDisabled()
        }
        ForEach(Array(groups.enumerated()), id: \.element.id) { index, group in
          let open = folds.isOpen(group.id)
          Section {
            if open {
              ForEach(group.threads, id: \.threadId) { row in
                ListRow(row: row, drawn: group.id, held: held.contains(row.threadId.rawValue), starred: starred.contains(row.threadId), picked: selecting && actions.picked.contains(row.threadId), actions: actions)
              }
            }
          } header: {
            GroupHeader(group: group, first: index == 0, open: open, news: folds.hasNews(group), blocker: folds.blocker(group)) { toggle(group.id, in: groups) }
              .listRowInsets(EdgeInsets(top: index > 0 ? Space.close : Space.tight, leading: Self.edge, bottom: 0, trailing: Self.edge))
          }
          .listSectionSeparator(.hidden)
        }
        if archived > 0, !selecting {
          // The way to the archived threads, under the list (the window keeps them in Settings and in a group of
          // the list).
          ZStack {
            NavigationLink(value: ListRoute.archived) { EmptyView() }.opacity(0)
            VStack(alignment: .leading, spacing: Space.step) {
              Hairline()
              HStack(spacing: Space.close) {
                Text(PhoneWords.archived).font(TextRole.metaStrong).foregroundStyle(Token.foreground)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(TextRole.glyph).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
              }
              .frame(minHeight: Space.touch - Space.step)
            }
            .contentShape(Rectangle())
          }
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(.isButton)
          .listRowBackground(Token.background)
          .listRowSeparator(.hidden)
          .listRowInsets(EdgeInsets(top: Space.close, leading: Self.edge, bottom: Space.near, trailing: Self.edge))
          .selectionDisabled()
        }
      }
      .listStyle(.plain)
      .listSectionSpacing(0)
      .scrollContentBackground(.hidden)
      // A binding the list can hold, moved with picking (RowActions.editMode): a constant handed down left the list
      // in edit mode after Done, its selection circles still drawn.
      .environment(\.editMode, $actions.editMode)
      .onChange(of: selecting) { _, now in
        if !now { withAnimation(Motion.fade.animation(still: still)) { actions.editMode = .inactive } }
      }
      .refreshable { await session.refresh() }
      // The last rows can be brought over the toast while it is up, and over the picks' bar while picking.
      .contentMargins(.bottom, selecting ? Size.wideButton + Space.section : actions.toast == nil ? 0 : Size.wideButton + Space.card, for: .scrollContent)
      // A row that leaves or moves slides; nothing else on the page does.
      .animation(Motion.fade.animation(still: still), value: groups.map { [$0.id.rawValue] + $0.threads.map(\.threadId.rawValue) })
      .animation(Motion.fade.animation(still: still), value: selecting)
      .overlay {
        if groups.isEmpty, pins.isEmpty {
          ContentUnavailableView(PhoneWords.listEmpty, systemImage: "tray")
        }
      }
      // The Snoozed band comes back folded each time it shows.
      .onChange(of: groups.contains { $0.id == .snoozed }) { _, has in
        guard !has else { return }
        var next = folds
        next.reset(.snoozed)
        foldsRaw = next.raw
      }
      // A pick whose row left the list, or whose group closed, drops out: on any change of what is listed.
      .onChange(of: groups.filter { folds.isOpen($0.id) }.flatMap(\.threads).map(\.threadId)) { _, listed in
        guard selecting else { return }
        actions.picked.formIntersection(listed)
      }
      // Picking starts from a row: the list empties its selection as it starts, and that row is picked again.
      .onChange(of: actions.picked) { _, now in
        guard let first = actions.firstPick else { return }
        actions.firstPick = nil
        if selecting, !now.contains(first) { actions.picked.insert(first) }
      }
    }
  }

  /// The page's one left and right edge: the title, the headers and the rows all start on it.
  static let edge: CGFloat = Space.card

  private var awayNeeds: [String] {
    session.computer.addresses.map {
      if case .wifi = $0 { return PhoneWords.pairNeedsWifi }
      return PhoneWords.pairNeedsTailnet
    }
  }
}

private extension View {
  /// A notice over the list: no ground, no line, the page's edge.
  func listPlain() -> some View {
    listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
      .listRowInsets(EdgeInsets(top: Space.tight, leading: InboxScreen.edge, bottom: Space.tight, trailing: InboxScreen.edge))
      .selectionDisabled()
  }
}

/// A group's header: its name and how many, read as one line. A touch closes or opens the group (the window's
/// groups do the same; Quiet and Snoozed start closed). Closed, its count goes bold when something new came in,
/// and a blocker inside keeps a warning mark.
struct GroupHeader: View {
  let group: InboxListSection
  let first: Bool
  let open: Bool
  let news: Bool
  let blocker: String?
  let toggle: () -> Void
  @Environment(\.accessibilityReduceMotion) private var still

  private var name: String { group.id == .priority ? Words.groupPriority : group.id == .snoozed ? Words.groupSnoozed : Words.sections[group.id.rawValue] ?? group.label }

  var body: some View {
    // A hairline parts a group from the one over it; the name sits close to its own rows, far from the rows above,
    // so the list reads as groups and not as one run of lines.
    VStack(alignment: .leading, spacing: Space.step) {
      if !first { Hairline() }
      Button(action: toggle) {
        HStack(alignment: .firstTextBaseline, spacing: Space.trim) {
          run(Text(name).fontWeight(.semibold).foregroundStyle(Token.foreground),
            Text("  \(group.threads.count.formatted(.number.locale(Locale(identifier: "en_US"))))").monospacedDigit().fontWeight(news ? .semibold : .regular).foregroundStyle(news ? Token.foreground : Token.mutedForeground))
          if blocker != nil {
            // A mark only: the header's own label says it in words.
            Image(systemName: "exclamationmark.triangle.fill")
              .font(TextRole.caption)
              .foregroundStyle((group.threads.contains { $0.section == .stopped } ? Role.stop : Role.hold).ink)
              .accessibilityHidden(true)
          }
          Spacer(minLength: Space.close)
          Image(systemName: "chevron.right")
            .font(Font.caption2.weight(.semibold))
            .foregroundStyle(Token.mutedForeground.opacity(0.7))
            // A small mark at any text size: the name beside it is what grows.
            .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
            .accessibilityHidden(true)
            .rotationEffect(.degrees(open ? 90 : 0))
            .animation(Motion.fade.animation(still: still), value: open)
        }
        .font(TextRole.meta)
        .textCase(nil)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressStyle(gives: false))
      .accessibilityLabel([name, group.threads.count.formatted(.number.locale(Locale(identifier: "en_US"))), news ? PhoneWords.newSinceClosed : nil, blocker].compactMap { $0 }.joined(separator: ", "))
      .accessibilityValue(open ? "" : PhoneWords.closed)
      .accessibilityAddTraits(.isHeader)
    }
  }
}

/// One thread's row in the list, with what a finger can do to it: a touch opens it, a swipe to the right marks it
/// read (Quiet) or unread, a swipe to the left archives it, and a hold opens its menu. While picking, a touch picks.
struct ListRow: View {
  let row: InboxListRow
  let drawn: InboxListGroupId
  let held: Bool
  let starred: Bool
  /// Picked, while picking.
  var picked = false
  let actions: RowActions

  private var swipe: (lead: RowOffers.Action?, trail: RowOffers.Action?) {
    RowOffers.swipe(row, drawn: drawn, canMarkRead: actions.session.canAct(.read), canMarkUnread: actions.session.canAct(.markUnread))
  }

  var body: some View {
    let picking = actions.selecting
    ZStack {
      NavigationLink(value: ListRoute.thread(row.threadId)) { EmptyView() }.opacity(0)
      ThreadRow(row: row, held: held, starred: starred, picked: picked, unstar: picking ? nil : { actions.perform(.unpin, on: row) })
    }
    // A picked row rests on a ground of its own: inside the page's edge, rounded, clear of the header over it.
    .listRowBackground(
      Token.background.overlay {
        RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
          .fill(Token.muted)
          .padding(.horizontal, Space.close)
          .padding(.vertical, Space.hair)
          .opacity(picked ? 1 : 0)
      }
    )
    // They reach the row's one combined element, the one VoiceOver lands on (a UI test reads them there).
    .accessibilityActions {
      if !picking { RowSpokenActions(row: row, drawn: drawn, starred: starred, actions: actions) }
    }
    // One rhythm: every row has the same air and the same height, and no row has a line another lacks.
    .listRowInsets(EdgeInsets(top: Space.near, leading: InboxScreen.edge, bottom: Space.near, trailing: InboxScreen.edge))
    .listRowSeparator(.hidden)
    .swipeActions(edge: .leading, allowsFullSwipe: true) {
      if !picking, let lead = swipe.lead {
        Button {
          actions.perform(lead, on: row)
        } label: {
          Label(lead == .markUnread ? PhoneWords.markUnread : PhoneWords.swipeQuiet, systemImage: lead == .markUnread ? "envelope.badge" : "checkmark.circle")
        }
        .tint(RowAction.quiet.tint)
        .accessibilityLabel(lead == .markUnread ? PhoneWords.markUnread : PhoneWords.swipeQuietName)
      }
    }
    .swipeActions(edge: .trailing, allowsFullSwipe: true) {
      if !picking, swipe.trail == .archive, actions.session.canAct(.archive) {
        Button {
          actions.perform(.archive, on: row)
        } label: {
          Label(PhoneWords.archive, systemImage: "archivebox")
        }
        .tint(RowAction.act.tint)
      }
    }
    .contextMenu {
      if !picking { ThreadMenuItems(row: row, drawn: drawn, starred: starred, actions: actions) }
    }
  }
}

/// The picks' actions, in the bar at the screen's foot (the window's phone sheet): Archive, Snooze, and More with
/// the rest. Each takes the picked rows it can; one that takes none is off or left out.
struct PickBar: View {
  let actions: RowActions
  /// The list as drawn now, read once for the whole bar.
  let view: ListView?

  private static let more: [(BulkAction, String, String)] = [
    (.read, PhoneWords.markRead, "checkmark.circle"),
    (.unread, PhoneWords.markUnread, "envelope"),
    (.star, PhoneWords.starThreads, "star"),
    (.unstar, PhoneWords.unstarThreads, "star.slash"),
    (.priorityAdd, PhoneWords.addToPriority, "arrow.up.to.line"),
    (.priorityRemove, PhoneWords.removeFromPriority, "arrow.down.to.line"),
  ]

  private func offers(_ action: BulkAction) -> Bool {
    let session = actions.session
    switch action {
    case .archive: return session.canAct(.archive)
    case .snooze: return session.canAct(.unsnooze)
    case .read: return session.canAct(.read)
    case .unread: return session.canAct(.markUnread)
    case .star, .unstar: return session.canAct(.star)
    case .priorityAdd, .priorityRemove: return session.canAct(.priority(true))
    }
  }

  var body: some View {
    // Which actions take any picked row, worked out once.
    let taking = Set(BulkAction.allCases.filter { offers($0) && !actions.targets($0, in: view).isEmpty })
    let takes: (BulkAction) -> Bool = { taking.contains($0) }
    let rest = Self.more.filter { takes($0.0) }
    Button {
      actions.bulk(.archive)
    } label: {
      Label(PhoneWords.archive, systemImage: "archivebox")
    }
    .disabled(!takes(.archive))
    Spacer()
    if takes(.snooze) || actions.picked.isEmpty {
      Menu {
        SnoozeTimes { actions.bulk(.snooze, until: $0) } pickATime: { actions.picking = .picked }
      } label: {
        Label(PhoneWords.snooze, systemImage: "clock")
      }
      .disabled(!takes(.snooze))
      Spacer()
    }
    Menu {
      ForEach(rest, id: \.0) { item in
        Button(item.1, systemImage: item.2) { actions.bulk(item.0) }
      }
    } label: {
      Label(PhoneWords.more, systemImage: "ellipsis.circle")
    }
    .disabled(rest.isEmpty)
  }
}

/// The starred threads, above the list: the window's "Keep starred above the list", always on here since the
/// phone has no sidebar for its Starred section. A touch opens one; a hold offers Unstar, Move up, Move down and
/// Copy link, the starred row's own menu in the window.
struct StarredPills: View {
  let pins: [InboxListRow]
  let actions: RowActions
  let open: (ThreadID) -> Void

  private func role(_ row: InboxListRow) -> Role? {
    switch ListRules.pinnedState(row) {
    case .stop: return .stop
    case .hold: return .hold
    case .wait, .new: return .act
    default: return nil
    }
  }

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: Space.close) {
        ForEach(Array(pins.enumerated()), id: \.element.threadId) { index, row in
          let name = row.threadName ?? row.subject ?? row.project.name
          Button {
            open(row.threadId)
          } label: {
            HStack(spacing: Space.trim) {
              Image(systemName: ListRules.archived(row) ? "archivebox" : "star.fill")
                .font(TextRole.caption)
                .foregroundStyle(role(row)?.ink ?? Token.mutedForeground)
              Text(name).font(TextRole.link).foregroundStyle(Token.foreground).lineLimit(1)
            }
            .padding(.horizontal, Space.step)
            .frame(minHeight: Size.capsule)
            .frame(maxWidth: 240)
            .background(Token.muted, in: Capsule())
            .frame(minHeight: Space.touch)
            .contentShape(Rectangle())
          }
          .buttonStyle(PressStyle())
          // A row of small things to touch, as a bar is: it grows with the text as far as a bar does.
          .barSized()
          .accessibilityLabel("\(PhoneWords.starred), \(name)")
          .contextMenu {
            Button(PhoneWords.unstarThread, systemImage: "star.slash") { actions.perform(.unpin, on: row) }
            Button(PhoneWords.moveUp, systemImage: "arrow.left") { actions.move(row.threadId, by: -1) }.disabled(index == 0)
            Button(PhoneWords.moveDown, systemImage: "arrow.right") { actions.move(row.threadId, by: 1) }.disabled(index == pins.count - 1)
            Button(PhoneWords.copyLink, systemImage: "link") { actions.perform(.copyLink, on: row) }
          }
        }
      }
      .padding(.horizontal, InboxScreen.edge)
    }
    .scrollClipDisabled()
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
      HStack(spacing: Space.close) {
        Circle().fill(state.0).frame(width: Space.close, height: Space.close)
        Text(session.computer.name).font(TextRole.heading).foregroundStyle(Token.foreground).lineLimit(1)
        if model.isDemo {
          // The stand-in computer is never mistaken for a real one.
          Text(PhoneWords.demoMark)
            .font(TextRole.captionStrong)
            .foregroundStyle(Token.mutedForeground)
            .padding(.horizontal, Space.trim)
            .padding(.vertical, Space.hair)
            .background(Token.muted, in: Capsule())
        }
        Image(systemName: "chevron.down").font(TextRole.glyph).foregroundStyle(Token.mutedForeground)
      }
      .padding(.horizontal, Space.trim)
      .frame(minHeight: Space.touch)
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
    let waiting = session.held.filter(session.willSend).count
    HStack(alignment: .firstTextBaseline, spacing: Space.near) {
      Image(systemName: "moon.fill").font(TextRole.meta).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.hair) {
        Text(PhoneWords.away(session.computer.name))
        if waiting > 0 { Text(PhoneWords.willSendWhenBack(session.computer.name)) }
      }
      .font(TextRole.secondary)
      .foregroundStyle(Token.foreground)
      Spacer(minLength: 0)
    }
    .padding(Space.step)
    .background(Token.muted, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
    .accessibilityElement(children: .combine)
  }
}

/// The line under the title while this app is too old for the computer: what to do, and what still works.
struct UpdateNotice: View {
  let update: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: Space.near) {
      HStack(alignment: .firstTextBaseline, spacing: Space.near) {
        // As large as the words beside it.
        Image(systemName: "arrow.down.app").font(TextRole.name).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: Space.hair) {
          Text(PhoneWords.updatePhone).fontWeight(.semibold)
          Text(PhoneWords.updateStillReads).foregroundStyle(Token.mutedForeground)
        }
        .font(TextRole.secondary)
        .foregroundStyle(Token.foreground)
      }
      .accessibilityElement(children: .combine)
      WideButton(words: PhoneWords.update, action: update)
    }
    .padding(Space.step)
    .background(Token.muted, in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
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
  var starred = false
  /// Picked while picking: its mark keeps a ground of its own on the picked row's.
  var picked = false
  /// A touch on the row's star unstars it (the window's row does the same). Nil: the star is only a mark.
  var unstar: (() -> Void)?

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
  /// When a snoozed row comes back ("Fri 8:00 AM"), as the window words it.
  private var snoozedWhen: String? { row.snoozed.map { SnoozeRules().when($0.until) } }
  private var hasTail: Bool { held || starred || snoozedWhen != nil || marks.actions + marks.questions > 0 }

  var body: some View {
    HStack(alignment: .top, spacing: Space.step) {
      AgentMark(author: row.author, size: 32, ground: picked ? Token.background : Token.muted).padding(.top, Space.hair)
      VStack(alignment: .leading, spacing: Space.hair) {
        if large {
          // At the largest sizes the title keeps the whole line; the time and the count share the next one.
          titleText
          leadText
          // One line when both fit whole; else the count under the time. Neither is ever cut.
          ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: Space.close) {
              timeText.fixedSize()
              Spacer(minLength: Space.tight)
              tail
            }
            VStack(alignment: .leading, spacing: Space.tight) {
              timeText
              if hasTail { tail }
            }
          }
        } else {
          HStack(alignment: .firstTextBaseline, spacing: Space.close) {
            titleText
            Spacer(minLength: 4)
            timeText.layoutPriority(1)
          }
          // The count has one place: the end of this line. It never wraps onto a line of its own.
          HStack(alignment: .center, spacing: Space.close) {
            leadText
            Spacer(minLength: 4)
            tail.layoutPriority(1)
          }
          // The line is as tall with a count as without one.
          .frame(minHeight: Size.mark)
        }
        // The same number of lines in every row, so the list scans.
        Text(row.latestPreview ?? " ")
          .font(TextRole.secondary)
          .foregroundStyle(row.unread ? Token.foreground : Token.mutedForeground)
          .lineLimit(large ? 3 : 1)
          .truncationMode(.tail)
          .padding(.top, Space.hair)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
    .accessibilityLabel(
      [
        row.unread ? PhoneWords.unreadMark : nil, title, "\(Names.agent(row.author)) · \(row.project.name)", starred ? PhoneWords.starred : nil, snoozedWhen.map(PhoneWords.snoozedUntil), spoken, row.latestPreview,
        row.snoozeBack != nil ? PhoneWords.backFromSnooze : nil, time,
      ].compactMap { $0 }.joined(separator: ", ")
    )
    .accessibilityAddTraits(.isButton)
  }

  /// What stands at the end of the row's second line, as the window's row has it: the star, a snooze's return,
  /// then what waits.
  private var tail: some View {
    HStack(spacing: Space.trim) {
      if starred {
        if let unstar {
          // For a screen reader the row itself offers Unstar thread (its actions, and its menu).
          Button(action: unstar) { star.frame(minWidth: Size.copy, minHeight: Size.mark).contentShape(Rectangle()) }
            .buttonStyle(.borderless)
            .accessibilityHidden(true)
        } else {
          star
        }
      }
      if let snoozedWhen {
        HStack(spacing: Space.tight) {
          Image(systemName: "clock").font(Font.caption2.weight(.semibold))
          Text(snoozedWhen).font(TextRole.meta).monospacedDigit()
        }
        .foregroundStyle(Token.mutedForeground)
        .fixedSize()
      }
      counts
    }
  }

  private var star: some View {
    // The window's star has a gold of its own (`--ib-star`); amber is the contract's nearest colour.
    Image(systemName: "star.fill").font(TextRole.caption).foregroundStyle(Token.warning).accessibilityHidden(true)
  }

  private var titleText: some View {
    Text(title)
      .font(row.unread ? TextRole.action : TextRole.body)
      .foregroundStyle(Token.foreground)
      .lineLimit(large ? 2 : 1)
      .truncationMode(.tail)
  }

  private var timeText: some View {
    // New since the person looked: the time takes the accent, as the window's row has it. A thread back from a
    // snooze shows a small clock before its time until the person reads it.
    let clock = row.snoozeBack != nil ? Text("\(Image(systemName: "clock")) ").font(Font.caption2.weight(.semibold)) : Text(verbatim: "")
    return run(clock, Text(time)).font(row.unread ? TextRole.metaStrong : TextRole.meta).monospacedDigit().foregroundStyle(row.unread ? Token.primary : Token.mutedForeground).lineLimit(1)
  }

  private var leadText: some View {
    Text(lead).font(TextRole.meta).foregroundStyle(Token.mutedForeground).lineLimit(1).truncationMode(.tail)
  }

  /// A count's step as the role its colour says: open has none.
  private static func role(_ step: RowMarks.Step) -> Role? {
    switch step {
    case .stop: return .stop
    case .hold: return .hold
    case .open: return nil
    }
  }

  /// What waits, compact, as the window's row has it (packages/inbox/components/RowBadge.tsx): the action box
  /// and the question mark, each coloured by its own step. Open is quiet (the question mark plain, the action box a
  /// neutral pill); held-up work is amber; a stopped agent is red.
  @ViewBuilder private var counts: some View {
    if held {
      Text(PhoneWords.willSend)
        .font(TextRole.metaStrong)
        .foregroundStyle(Token.foreground)
        .padding(.horizontal, Space.close)
        .frame(minHeight: Size.mark)
        .background(Token.muted, in: Capsule())
        .fixedSize()
    } else if marks.actions + marks.questions > 0 {
      HStack(spacing: Space.trim) {
        if marks.actions > 0 { CountBadge(symbol: "checklist", count: RowMarks.shown(marks.actions), role: Self.role(marks.action), boxed: true) }
        if marks.questions > 0 { CountBadge(symbol: "questionmark.bubble", count: RowMarks.shown(marks.questions), role: Self.role(marks.question), boxed: false) }
      }
      .fixedSize()
    }
  }
}
