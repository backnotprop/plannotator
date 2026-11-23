import InboxCore
import InboxWire
import SwiftUI

/// A message's action items as one checklist, as the window draws them
/// (packages/inbox/components/ActionChecklist.tsx): how many things only the person can do and how many are done,
/// then a row per item with a round tick, the task, and what opens under it: why, what it holds up, where, the
/// command with Copy, then Done and Can't do it…. A mark waits in the reply draft and goes with the next Send.
struct ActionChecklist: View {
  let session: InboxSession
  let thread: ThreadID
  let message: MessageID
  let actions: [InboxQuestion]
  let agent: String
  /// No marking: the thread is archived.
  var readOnly = false
  let drafts: ThreadDrafts

  @State private var openKey: String?
  @State private var chosen = false

  /// The open row: the one the person chose, else one with a reason still being typed (a card the thread built
  /// anew after a long scroll), else the first still to do.
  private var open: String? {
    if chosen { return openKey }
    return actions.first { drafts.reasons[ActionRow.reasonKey(message, $0)] != nil }?.key ?? actions.first { ActionMarks.state($0) == .open }?.key
  }

  var body: some View {
    let progress = ActionMarks.progress(actions)
    let live = actions.filter { ActionMarks.state($0) == .open }
    let waited = actions.filter { [.open, .pending].contains(ActionMarks.state($0)) }.compactMap { $0.action?.watching }.filter { !$0.isEmpty }
    let watching = waited.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    let holds = live.reduce(0) { $0 + $1.holdsUp.count }
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: Space.step) {
        // In the column of the ticks under it.
        Image(systemName: "checklist").font(.system(size: side * 0.68, weight: .semibold)).foregroundStyle(Token.mutedForeground).frame(width: side).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: Space.hair) {
          Text(progress.total == 0 ? PhoneWords.actionsReplaced(progress.replaced) : PhoneWords.thingsOnlyYou(progress.total))
            .font(TextRole.action)
            .foregroundStyle(Token.foreground)
            .accessibilityAddTraits(.isHeader)
          if progress.total > 0 {
            Text(PhoneWords.doneOf(progress.done, progress.total, replaced: progress.replaced)).font(TextRole.secondary).monospacedDigit().foregroundStyle(Token.mutedForeground)
          }
        }
        Spacer(minLength: 8)
        if live.contains(where: { $0.stopped != nil }) {
          Chip(words: PhoneWords.stopped, tone: .stop)
        } else if holds > 0 {
          Chip(words: PhoneWords.holdsUp(holds), tone: .hold)
        }
      }
      .lineEdge("head")
      .padding(.horizontal, Space.card)
      .padding(.top, Space.card)
      .padding(.bottom, Space.step)
      ForEach(actions, id: \.key) { action in
        Hairline().padding(.horizontal, Space.card)
        ActionRow(session: session, thread: thread, message: message, action: action, agent: agent, readOnly: readOnly || !session.canMarkActions(), open: open == action.key, drafts: drafts) {
          chosen = true
          openKey = open == action.key ? nil : action.key
        } marked: { mark in
          guard mark != nil else { return }
          chosen = true
          openKey = ActionMarks.nextOpen(actions, after: action.key)
        }
      }
      if !watching.isEmpty {
        Hairline().padding(.horizontal, Space.card)
        Label(PhoneWords.watching(agent, watching), systemImage: "eye")
          .font(TextRole.meta)
          .foregroundStyle(Token.mutedForeground)
          .lineEdge("watching")
          .padding(Space.card)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .cardSurface()
    .accessibilityElement(children: .contain)
  }

  @MarkSide private var side
}

struct ActionRow: View {
  let session: InboxSession
  let thread: ThreadID
  let message: MessageID
  let action: InboxQuestion
  let agent: String
  let readOnly: Bool
  let open: Bool
  let drafts: ThreadDrafts
  let toggle: () -> Void
  let marked: (ActionMarks.Mark?) -> Void

  @State private var composing = false
  @State private var reason = ""
  @State private var note = ""
  @State private var busy = false
  @State private var copied = false
  @FocusState private var focus: Field?
  enum Field { case reason, note }
  @Environment(ScrollBox.self) private var scroll: ScrollBox?
  @Environment(\.cardKey) private var cardKey
  private func touch() { if let cardKey { scroll?.act(cardKey) } }
  /// The tick is a choice's mark: the same size, in the same column, its words in the column of a choice's words.
  @MarkSide private var side
  private var column: CGFloat { Space.card + $side }
  /// How much taller a line of the task's words is at this text size than at the default one.
  @ScaledMetric(relativeTo: .body) private var lineGrowth: CGFloat = 1

  private var state: ActionMarks.State { ActionMarks.state(action) }
  private var result: InboxActionResult? { action.actionResult }
  private var live: Bool { state == .open }
  private var pending: Bool { state == .pending }
  private var inDraft: Bool { ActionMarks.inDraft(action) }
  private var doneLike: Bool { ActionMarks.isDone(action) }
  private var cantLike: Bool { state == .cant || (pending && result?.outcome == .cant) }
  /// The time alone, as the window's lines have it ("3:12 PM").
  private var when: String { result.map { TimeWords().clock($0.at) } ?? "" }
  /// The person's own mark: theirs, or the one the agent's "saw it done" settled.
  private var mine: (cant: Bool, note: String?, at: String)? {
    guard let result else { return nil }
    if result.by == .person { return (result.outcome == .cant, result.note, result.at) }
    return result.person.map { ($0.outcome == .cant, $0.note, $0.at) }
  }
  private var held: Bool { session.isHeldMark(message: message, key: action.key) }
  static func reasonKey(_ message: MessageID, _ action: InboxQuestion) -> String { "cant/\(message.rawValue)/\(action.key)" }
  private var reasonKey: String { Self.reasonKey(message, action) }
  private var sendHeld: Bool { session.isHeldSend(message: message, key: action.key) }

  private var chip: Chip? {
    switch state {
    case .open: return nil
    case .pending: return result?.outcome == .cant ? Chip(words: PhoneWords.cantDoIt, tone: .stop) : Chip(words: PhoneWords.done, tone: .ok)
    case .done, .seen: return Chip(words: PhoneWords.done, tone: .ok)
    case .cant: return Chip(words: PhoneWords.cantDoIt, tone: .stop)
    case .setAside: return Chip(words: PhoneWords.setAside, tone: .quiet)
    case .archived: return Chip(words: PhoneWords.closed, tone: .quiet)
    case .replaced: return Chip(words: PhoneWords.replaced, tone: .quiet)
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .top, spacing: Space.step - (Space.touch - side) / 2) {
        // On the task's first line at any text size.
        tick.padding(.top, max(0, (lineGrowth - 1) * Size.mark / 2))
        Button(action: toggle) {
          HStack(alignment: .firstTextBaseline, spacing: Space.close) {
            Text(MessageBody.attributed(Self.task(action.prompt)))
              .font(TextRole.label)
              .foregroundStyle(Token.foreground)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: Space.tight)
            if let chip { chip }
            Image(systemName: open ? "chevron.down" : "chevron.right").font(TextRole.metaStrong).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
          }
          .padding(.vertical, Space.near)
          .padding(.trailing, Space.card)
          .frame(minHeight: Space.touch)
          .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle(gives: false))
        .accessibilityAddTraits(.isButton)
      }
      // The tick stands in the column of a question's mark.
      .padding(.leading, Space.card - (Space.touch - side) / 2)
      .lineEdge("row/\(action.key)")
      if let line = underLine {
        HStack(alignment: .firstTextBaseline, spacing: Space.step) {
          Text(line).font(TextRole.meta).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).lineEdge("under/\(action.key)")
          if ActionMarks.timed(action), !readOnly {
            Button(PhoneWords.undo) { mark(nil) }.font(TextRole.metaStrong).touchTarget().disabled(busy)
          }
        }
        .padding(.leading, column)
        .padding(.trailing, Space.card)
        .padding(.bottom, Space.close)
      }
      if inDraft, let mine { draftNote(mine) }
      if let refusal = session.refusal(message: message, key: action.key) {
        Label(PhoneWords.markNotice(refusal, computer: session.computer.name), systemImage: "exclamationmark.circle")
          .font(TextRole.meta)
          .foregroundStyle(Token.destructive)
          .lineEdge("refusal/\(action.key)")
          .padding(.leading, column)
          .padding(.trailing, Space.card)
          .padding(.bottom, Space.near)
      }
      if open { panel }
    }
    .onAppear {
      note = mine?.note ?? ""
      // Built anew after a long scroll: the reason being typed is still there, its field open.
      if let kept = drafts.reasons[reasonKey] {
        reason = kept
        composing = true
      }
    }
    .onChange(of: reason) { _, now in if composing { drafts.reasons[reasonKey] = now } }
    .onChange(of: composing) { _, now in drafts.reasons[reasonKey] = now ? reason : nil }
    // Send saves a note still inside its typing pause first, so what is on screen is what goes. Registered again
    // whenever the item changes, so the saver reads the item as it is now.
    .onChange(of: action, initial: true) { _, _ in drafts.register("action/\(message.rawValue)/\(action.key)") { saveNote() } }
    .onDisappear { drafts.remove("action/\(message.rawValue)/\(action.key)") }
    .onChange(of: mine?.note) { _, now in if focus != .note { note = now ?? "" } }
    // The note saves itself after a pause, as in the window, and when the field is left.
    .task(id: note) {
      try? await Task.sleep(for: .milliseconds(600))
      if !Task.isCancelled { saveNote() }
    }
    .onChange(of: focus) { before, now in
      if before == .note, now != .note { saveNote() }
      if now != nil { touch() }
    }
  }

  /// The task as a button's words: a link keeps its label (a button holds no link).
  static func task(_ prompt: String) -> String {
    prompt.replacing(/!?\[([^\]]*)\]\([^)]*\)/) { String($0.1) }
  }

  private var tick: some View {
    Button {
      if pending { mark(nil) } else { mark(ActionMarks.Mark(.done)) }
    } label: {
      ZStack {
        Circle().strokeBorder(doneLike ? Token.success : cantLike ? Token.destructive : Token.mutedForeground.opacity(0.75), lineWidth: 1.5)
        if doneLike { Circle().fill(Token.success) }
        if doneLike { Image(systemName: "checkmark").font(.system(size: side * 0.5, weight: .bold)).foregroundStyle(Token.card) }
        if cantLike { Image(systemName: "xmark").font(.system(size: side * 0.46, weight: .bold)).foregroundStyle(Token.destructive) }
      }
      .frame(width: side, height: side)
      .frame(width: Space.touch, height: Space.touch)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(readOnly || busy || !(live || pending))
    .accessibilityLabel(PhoneWords.doneTask(action.prompt))
    .accessibilityAddTraits(pending ? [.isButton, .isSelected] : .isButton)
  }

  private var underLine: String? {
    guard let result else { return nil }
    if ActionMarks.timed(action) { return PhoneWords.goesSoon(cant: result.outcome == .cant, note: result.note, at: when, agent: agent) }
    if state == .cant { return PhoneWords.cantSent(note: result.note, agent: agent, withReply: result.staged == true) }
    if state == .seen, inDraft { return PhoneWords.sawItDone(agent, at: when) }
    return nil
  }

  private var settled: String? {
    guard !sendHeld else { return PhoneWords.willSendWhenBack(session.computer.name) }
    switch state {
    case .done: return result.map { PhoneWords.markedDone(at: when, note: $0.note != nil, agent: agent, withReply: $0.staged == true) }
    case .seen:
      if inDraft { return nil }
      return mine?.note != nil ? PhoneWords.sawItDoneWithNote(agent, at: when) : PhoneWords.sawItDone(agent, at: when)
    case .setAside: return PhoneWords.setAsideLine(agent)
    case .replaced: return PhoneWords.replacedLine(agent)
    case .archived: return PhoneWords.closedLine
    default: return nil
    }
  }

  /// The mark waiting in the reply draft: a note for the agent, then "Done 3:12 PM · in your draft".
  private func draftNote(_ mine: (cant: Bool, note: String?, at: String)) -> some View {
    VStack(alignment: .leading, spacing: Space.trim) {
      TextField(PhoneWords.noteFor(agent), text: $note, axis: .vertical)
        .lineLimit(1...5)
        .font(TextRole.body)
        .focused($focus, equals: .note)
        .disabled(readOnly)
        .padding(.horizontal, Space.step)
        .padding(.vertical, Space.near)
        .frame(minHeight: Space.touch)
        .fieldGround(focused: focus == .note)
        .toolbar { if focus == .note { keyboardDone } }
        .accessibilityLabel(PhoneWords.noteLabel(agent, cant: mine.cant))
        .lineEdge("note/\(action.key)")
      Text(held ? PhoneWords.markWaits(cant: mine.cant, computer: session.computer.name) : PhoneWords.markInDraft(cant: mine.cant, seen: state == .seen, at: TimeWords().clock(mine.at)))
        .font(TextRole.meta)
        .foregroundStyle(Token.mutedForeground)
        .lineEdge("draft/\(action.key)")
    }
    .padding(.leading, column)
    .padding(.trailing, Space.card)
    .padding(.bottom, Space.step)
  }

  @ToolbarContentBuilder private var keyboardDone: some ToolbarContent {
    ToolbarItemGroup(placement: .keyboard) {
      Spacer()
      Button(PhoneWords.done) { focus = nil }.fontWeight(.semibold)
    }
  }

  private var panel: some View {
    let facts = action.action
    return VStack(alignment: .leading, spacing: Space.near) {
      if let why = action.context, !why.isEmpty {
        Text(MessageBody.attributed(why)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).lineEdge("why/\(action.key)")
      }
      if live, let stopped = action.stopped {
        run(Text(PhoneWords.stopped).fontWeight(.semibold), Text(stopped.isEmpty ? "" : " \(stopped)")).font(TextRole.secondary).foregroundStyle(Token.foreground).lineEdge("stopped/\(action.key)")
      }
      if live, !action.holdsUp.isEmpty {
        Text(PhoneWords.holdsUpWhat(action.holdsUp)).font(TextRole.secondary).foregroundStyle(Token.foreground).lineEdge("holds/\(action.key)")
      }
      if live, let place = facts?.whereValue, !place.isEmpty, facts?.whereUrl == nil {
        Label(place, systemImage: "folder").font(TextRole.secondary).foregroundStyle(Token.mutedForeground).lineEdge("where/\(action.key)")
      }
      if live, let link = facts?.whereUrl.flatMap(URL.init(string:)) {
        Link(destination: link) {
          HStack {
            Text(PhoneWords.openLink(facts?.whereValue)).font(TextRole.label)
            Spacer()
            Image(systemName: "arrow.up.right").font(TextRole.metaStrong)
          }
          .foregroundStyle(Token.foreground)
          .padding(.horizontal, Space.snug)
          .frame(minHeight: Space.touch)
          .background(Token.foreground.opacity(0.09), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
        }
        .lineEdge("link/\(action.key)")
      }
      if live, let run = facts?.run, !run.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Text(PhoneWords.command).font(TextRole.metaStrong).foregroundStyle(Token.mutedForeground)
            Spacer()
            CopyButton(text: run, copied: $copied)
          }
          .padding(.leading, Space.snug)
          Text(run)
            .font(TextRole.code())
            .foregroundStyle(Token.foreground)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, Space.snug)
            .padding(.bottom, Space.step)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Token.codeBackground, in: RoundedRectangle(cornerRadius: Radius.field, style: .continuous))
        .lineEdge("command/\(action.key)")
      }
      if let settled {
        Text(settled).font(TextRole.meta).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).lineEdge("settled/\(action.key)")
      }
      if live, !readOnly {
        if composing { compose } else { answers.lineEdge("answers/\(action.key)") }
      }
    }
    .padding(.leading, column)
    .padding(.trailing, Space.card)
    .padding(.bottom, Space.snug)
  }

  private var answers: some View {
    // Side by side; one under the other when the words are too large to fit whole.
    ViewThatFits(in: .horizontal) {
      HStack(spacing: Space.close) { answerButtons(whole: true) }
      // Under each other, the words may wrap: at the largest sizes they are wider than the card.
      VStack(alignment: .leading, spacing: Space.tight) { answerButtons(whole: false) }
    }
    .buttonStyle(PressStyle())
    .disabled(busy)
  }

  @ViewBuilder private func answerButtons(whole: Bool) -> some View {
    Group {
      Button {
        mark(ActionMarks.Mark(.done))
      } label: {
        Label(PhoneWords.done, systemImage: "checkmark").fixedSize(horizontal: whole, vertical: true).actionGround(.filled, wide: false, height: Space.touch)
      }
      Button {
        touch()
        composing = true
        focus = .reason
      } label: {
        Text(PhoneWords.cantDoItMore).multilineTextAlignment(.leading).fixedSize(horizontal: whole, vertical: true).actionGround(.bare, wide: false, height: Space.touch).padding(.leading, whole ? 0 : -Space.step)
      }
    }
  }

  private var compose: some View {
    VStack(alignment: .leading, spacing: Space.close) {
      Text(PhoneWords.whyCant(agent)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true).lineEdge("whyCant/\(action.key)")
      TextField("", text: $reason, axis: .vertical)
        .lineLimit(2...6)
        .font(TextRole.body)
        .focused($focus, equals: .reason)
        .padding(.horizontal, Space.step)
        .padding(.vertical, Space.near)
        .frame(minHeight: Space.touch)
        .fieldGround(focused: focus == .reason)
        .accessibilityLabel(PhoneWords.whyCant(agent))
        .lineEdge("reason/\(action.key)")
      HStack(spacing: Space.trim) {
        let empty = reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        Button {
          mark(ActionMarks.Mark(.cant, note: reason))
        } label: {
          Text(PhoneWords.cantDoIt).actionGround(empty ? .off : .filled, wide: false, height: Space.touch)
        }
        .disabled(busy || empty)
        Button {
          composing = false
          focus = nil
        } label: {
          Text(PhoneWords.cancel).actionGround(.bare, wide: false, height: Space.touch)
        }
      }
      .buttonStyle(PressStyle())
      .lineEdge("reasonButtons/\(action.key)")
    }
    .cardPart()
  }

  private func mark(_ next: ActionMarks.Mark?) {
    guard !busy else { return }
    busy = true
    touch()
    Task {
      let taken = await session.mark(action: action, thread: thread, message: message, next)
      busy = false
      // Refused: the row stays as it is, with the reason the person typed, and says why.
      guard taken == .saved || taken == .waits else { return }
      composing = false
      reason = ""
      focus = nil
      marked(next)
    }
  }

  /// A note typed under the marked row. A Can't do it's note is its reason: emptied, it is not saved.
  private func saveNote() {
    guard inDraft, let mine, !readOnly else { return }
    let typed = note.trimmingCharacters(in: .whitespacesAndNewlines)
    guard typed != (mine.note ?? "").trimmingCharacters(in: .whitespacesAndNewlines) else { return }
    if mine.cant, typed.isEmpty {
      if focus != .note { note = mine.note ?? "" }
      return
    }
    // The agent saw it done itself: an emptied note leaves nothing of the person's to send.
    let next: ActionMarks.Mark? = state == .seen && typed.isEmpty ? nil : ActionMarks.Mark(mine.cant ? .cant : .done, note: typed.isEmpty ? nil : typed)
    // `note_only`: it never marks again an item taken back meanwhile.
    guard session.hold(mark: next, action: action, thread: thread, message: message, quiet: next != nil) else { return }
    Task { await session.deliverHeld(thread: thread) }
  }
}
