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

  private var open: String? { chosen ? openKey : actions.first { ActionMarks.state($0) == .open }?.key }

  var body: some View {
    let progress = ActionMarks.progress(actions)
    let live = actions.filter { ActionMarks.state($0) == .open }
    let waited = actions.filter { [.open, .pending].contains(ActionMarks.state($0)) }.compactMap { $0.action?.watching }.filter { !$0.isEmpty }
    let watching = waited.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
    let holds = live.reduce(0) { $0 + $1.holdsUp.count }
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Image(systemName: "checklist").font(.subheadline.weight(.semibold)).foregroundStyle(Token.primary).accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(progress.total == 0 ? PhoneWords.actionsReplaced(progress.replaced) : PhoneWords.thingsOnlyYou(progress.total))
            .font(.body.weight(.semibold))
            .foregroundStyle(Token.foreground)
            .accessibilityAddTraits(.isHeader)
          if progress.total > 0 {
            Text(PhoneWords.doneOf(progress.done, progress.total, replaced: progress.replaced)).font(.subheadline).foregroundStyle(Token.mutedForeground)
          }
        }
        Spacer(minLength: 8)
        if live.contains(where: { $0.stopped != nil }) {
          Chip(words: PhoneWords.stopped, tone: .stop)
        } else if holds > 0 {
          Chip(words: PhoneWords.holdsUp(holds), tone: .hold)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 16)
      .padding(.bottom, 10)
      ForEach(actions, id: \.key) { action in
        Divider().overlay(Token.border).padding(.horizontal, 16)
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
        Divider().overlay(Token.border).padding(.horizontal, 16)
        Label(PhoneWords.watching(agent, watching), systemImage: "eye")
          .font(.footnote)
          .foregroundStyle(Token.mutedForeground)
          .padding(16)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Token.card, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Token.border.opacity(0.6)))
    .accessibilityElement(children: .contain)
  }
}

/// A small word on a tinted ground: Done, Can't do it, Stopped, Holds up 2.
struct Chip: View {
  enum Tone { case ok, stop, hold, quiet }
  let words: String
  let tone: Tone

  private var ink: Color {
    switch tone {
    case .ok: return Token.success
    case .stop: return Token.destructive
    case .hold: return Token.warning
    case .quiet: return Token.mutedForeground
    }
  }

  var body: some View {
    Text(words)
      .font(.footnote.weight(.semibold))
      .foregroundStyle(ink)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .background(tone == .quiet ? Token.muted : ink.opacity(0.14), in: Capsule())
      .fixedSize()
  }
}

private struct ActionRow: View {
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
      HStack(alignment: .top, spacing: 4) {
        tick
        Button(action: toggle) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(MessageBody.attributed(Self.task(action.prompt)))
              .font(.body.weight(.semibold))
              .foregroundStyle(Token.foreground)
              .multilineTextAlignment(.leading)
              .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            if let chip { chip }
            Image(systemName: open ? "chevron.down" : "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
          }
          .padding(.vertical, 11)
          .padding(.trailing, 16)
          .frame(minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(ChoiceStyle())
        .accessibilityAddTraits(.isButton)
      }
      .padding(.leading, 6)
      if let line = underLine {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
          Text(line).font(.footnote).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
          if ActionMarks.timed(action), !readOnly {
            Button(PhoneWords.undo) { mark(nil) }.font(.footnote.weight(.semibold)).frame(minWidth: 44, minHeight: 44).disabled(busy)
          }
        }
        .padding(.leading, 54)
        .padding(.trailing, 16)
        .padding(.bottom, 8)
      }
      if inDraft, let mine { draftNote(mine) }
      if let refusal = session.refusal(message: message, key: action.key) {
        Label(PhoneWords.markNotice(refusal, computer: session.computer.name), systemImage: "exclamationmark.circle")
          .font(.footnote)
          .foregroundStyle(Token.destructive)
          .padding(.leading, 54)
          .padding(.trailing, 16)
          .padding(.bottom, 10)
      }
      if open { panel }
    }
    .onAppear { note = mine?.note ?? "" }
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
    .onChange(of: focus) { before, now in if before == .note, now != .note { saveNote() } }
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
        Circle().strokeBorder(doneLike ? Token.success : cantLike ? Token.destructive : Token.mutedForeground, lineWidth: 1.6)
        if doneLike { Circle().fill(Token.success) }
        if doneLike { Image(systemName: "checkmark").font(.caption.weight(.bold)).foregroundStyle(Token.card) }
        if cantLike { Image(systemName: "xmark").font(.caption.weight(.bold)).foregroundStyle(Token.destructive) }
      }
      .frame(width: 24, height: 24)
      .frame(width: 44, height: 44)
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
    VStack(alignment: .leading, spacing: 6) {
      TextField(PhoneWords.noteFor(agent), text: $note, axis: .vertical)
        .lineLimit(1...5)
        .font(.body)
        .focused($focus, equals: .note)
        .disabled(readOnly)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .fieldGround(radius: Token.radius)
        .toolbar { if focus == .note { keyboardDone } }
        .accessibilityLabel(PhoneWords.noteLabel(agent, cant: mine.cant))
      Text(held ? PhoneWords.markWaits(cant: mine.cant, computer: session.computer.name) : PhoneWords.markInDraft(cant: mine.cant, seen: state == .seen, at: TimeWords().clock(mine.at)))
        .font(.footnote)
        .foregroundStyle(Token.mutedForeground)
    }
    .padding(.leading, 54)
    .padding(.trailing, 16)
    .padding(.bottom, 12)
  }

  @ToolbarContentBuilder private var keyboardDone: some ToolbarContent {
    ToolbarItemGroup(placement: .keyboard) {
      Spacer()
      Button(PhoneWords.done) { focus = nil }.fontWeight(.semibold)
    }
  }

  private var panel: some View {
    let facts = action.action
    return VStack(alignment: .leading, spacing: 10) {
      if let why = action.context, !why.isEmpty {
        Text(MessageBody.attributed(why)).font(.subheadline).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
      }
      if live, let stopped = action.stopped {
        run(Text(PhoneWords.stopped).fontWeight(.semibold), Text(stopped.isEmpty ? "" : " \(stopped)")).font(.subheadline).foregroundStyle(Token.foreground)
      }
      if live, !action.holdsUp.isEmpty {
        Text(PhoneWords.holdsUpWhat(action.holdsUp)).font(.subheadline).foregroundStyle(Token.foreground)
      }
      if live, let place = facts?.whereValue, !place.isEmpty, facts?.whereUrl == nil {
        Label(place, systemImage: "folder").font(.subheadline).foregroundStyle(Token.mutedForeground)
      }
      if live, let link = facts?.whereUrl.flatMap(URL.init(string:)) {
        Link(destination: link) {
          HStack {
            Text(PhoneWords.openLink(facts?.whereValue)).font(.body.weight(.medium))
            Spacer()
            Image(systemName: "arrow.up.right").font(.footnote.weight(.semibold))
          }
          .foregroundStyle(Token.foreground)
          .padding(.horizontal, 14)
          .frame(minHeight: 44)
          .background(Token.muted, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
      if live, let run = facts?.run, !run.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          HStack {
            Text(PhoneWords.command).font(.footnote.weight(.semibold)).foregroundStyle(Token.mutedForeground)
            Spacer()
            CopyButton(text: run, copied: $copied)
          }
          .padding(.leading, 14)
          Text(run)
            .font(.system(.callout, design: .monospaced))
            .foregroundStyle(Token.foreground)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 14)
            .padding(.bottom, 12)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Token.codeBackground, in: RoundedRectangle(cornerRadius: Token.radius, style: .continuous))
      }
      if let settled {
        Text(settled).font(.footnote).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
      }
      if live, !readOnly {
        if composing { compose } else { answers }
      }
    }
    .padding(.leading, 54)
    .padding(.trailing, 16)
    .padding(.bottom, 14)
  }

  private var answers: some View {
    // Side by side; one under the other when the words are too large to fit whole.
    ViewThatFits(in: .horizontal) {
      HStack(spacing: 6) { answerButtons }
      VStack(alignment: .leading, spacing: 6) { answerButtons }
    }
    .buttonStyle(ChoiceStyle())
    .disabled(busy)
  }

  @ViewBuilder private var answerButtons: some View {
    Group {
      Button {
        mark(ActionMarks.Mark(.done))
      } label: {
        Label(PhoneWords.done, systemImage: "checkmark")
          .font(.body.weight(.semibold))
          .foregroundStyle(Token.primaryForeground)
          .fixedSize()
          .padding(.horizontal, 18)
          .frame(minHeight: 44)
          .background(Token.primary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      }
      Button {
        composing = true
        focus = .reason
      } label: {
        Text(PhoneWords.cantDoItMore).font(.body).foregroundStyle(Token.foreground).fixedSize().padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
      }
    }
  }

  private var compose: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(PhoneWords.whyCant(agent)).font(.subheadline).foregroundStyle(Token.mutedForeground).fixedSize(horizontal: false, vertical: true)
      TextField("", text: $reason, axis: .vertical)
        .lineLimit(2...6)
        .font(.body)
        .focused($focus, equals: .reason)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(minHeight: 44)
        .fieldGround(radius: Token.radius)
        .accessibilityLabel(PhoneWords.whyCant(agent))
      HStack(spacing: 6) {
        let empty = reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        Button {
          mark(ActionMarks.Mark(.cant, note: reason))
        } label: {
          Text(PhoneWords.cantDoIt)
            .font(.body.weight(.semibold))
            .foregroundStyle(empty ? Token.mutedForeground : Token.primaryForeground)
            .padding(.horizontal, 18)
            .frame(minHeight: 44)
            .background(empty ? Token.muted : Token.primary, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .disabled(busy || empty)
        Button(PhoneWords.cancel) {
          composing = false
          focus = nil
        }
        .font(.body)
        .foregroundStyle(Token.foreground)
        .padding(.horizontal, 12)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
      }
      .buttonStyle(ChoiceStyle())
    }
  }

  private func mark(_ next: ActionMarks.Mark?) {
    guard !busy else { return }
    busy = true
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
