import InboxCore
import InboxWire
import SwiftUI

/// What the person is doing with comments in one file cover: the place they are commenting on, the words so far, the
/// marks drawn on a picture and not yet commented, and the comment they asked to go back to. One for the cover, so
/// the viewers, the foot and the list speak of the same thing.
@MainActor
@Observable
final class CommentDesk {
  /// A place in a file a comment is being written on.
  enum Target: Equatable {
    /// Words selected in a document or a text file: the window's block (or "" where the phone does not share the
    /// window's blocks), where they start, and the words.
    case words(block: String, start: Int, quote: String)
    /// A line of code, or a run of lines, with those lines as the file has them.
    case lines(ClosedRange<Int>, code: String)
    /// The picture, with whatever is drawn on it.
    case picture
    /// A spot on a page.
    case pin(PinnedElement)
    /// The whole file: a document's or a code file's Global comment, a page's own comment.
    case whole
  }

  struct Draft: Equatable {
    var file: AttachmentID
    var version: AttachmentVersion
    var target: Target
  }

  /// A comment asked for: the viewer of its file shows where it is. `turn` moves with each ask, so asking twice
  /// for the same one goes there twice.
  struct Sought: Equatable {
    var comment: FileComment
    var turn: Int
  }

  var draft: Draft?
  /// A kept comment whose words are being changed.
  var editing: FileComment?
  var words = ""
  /// A change to the comment being edited was not kept: it already went in a Send. The editor says so until its words
  /// change or it closes.
  var alreadySent = false
  /// The picture takes the finger: a drag draws, a touch pins.
  var marking = false
  /// What is drawn on each picture and not yet part of a comment.
  var marks: [AttachmentID: [PictureMark]] = [:]
  /// A page takes comments (a touch pins a spot) instead of touches of its own.
  var commenting = false
  var listOpen = false
  /// How tall the foot stands now: a page that runs under it scrolls its own end clear of it.
  var foot: CGFloat = 0
  private(set) var sought: Sought?
  /// The reply field's keyboard is wanted.
  var wantsKeyboard = 0
  /// The picture on screen's viewer, to flatten what was drawn onto it as a PNG (only that one: a picture let go
  /// of its decoded pixels when the cover moved on).
  @ObservationIgnored var flatten: (file: AttachmentID, make: ([PictureMark]) async -> Data?)?
  /// Each page's pin at the middle of the screen (VoiceOver's pin), by file.
  @ObservationIgnored var pinMiddle: [AttachmentID: () -> Void] = [:]
  /// The cover's toast, with Undo.
  let toasts = CommentToast()
  /// A drawing is being flattened to keep: Comment waits for it.
  private(set) var keeping = false
  /// What was being written on each file the person stepped away from, back when they return to it.
  @ObservationIgnored private var parked: [AttachmentID: (draft: Draft?, editing: FileComment?, words: String)] = [:]

  func begin(_ draft: Draft) {
    editing = nil
    alreadySent = false
    if self.draft == nil { words = "" }
    self.draft = draft
    wantsKeyboard += 1
  }

  func edit(_ comment: FileComment) {
    draft = nil
    alreadySent = false
    editing = comment
    words = comment.isWordlessMarkup ? "" : comment.words
    wantsKeyboard += 1
  }

  func cancel() {
    draft = nil
    editing = nil
    words = ""
    alreadySent = false
  }

  /// The words in the field changed: a line about the last try no longer stands.
  func wordsChanged() { alreadySent = false }

  func seek(_ comment: FileComment) { sought = Sought(comment: comment, turn: (sought?.turn ?? 0) + 1) }

  /// The cover stepped from one file to the next: what was being written on the last one waits for the person's
  /// return to it, and what was being written on this one comes back. Not when the step is the way to the comment
  /// whose words are being changed, or the place being commented on.
  func step(from old: AttachmentID?, to now: AttachmentID) {
    if editing?.attachment == now || draft?.file == now { return }
    alreadySent = false
    if let old, draft != nil || editing != nil || !words.isEmpty { parked[old] = (draft, editing, words) }
    if let back = parked.removeValue(forKey: now) {
      draft = back.draft
      editing = back.editing
      words = back.words
    } else {
      cancel()
    }
  }

  /// The lines being commented on in a code file, if any.
  func lines(in file: AttachmentID) -> ClosedRange<Int>? {
    if let draft, draft.file == file, case .lines(let range, _) = draft.target { return range }
    return nil
  }

  private var trimmed: String { words.trimmingCharacters(in: .whitespacesAndNewlines) }

  /// Whether there is a comment to keep for the file on screen: words, or a drawing on a picture.
  func ready(on item: AttachmentItem, picture: Bool) -> Bool {
    if editing != nil { return !trimmed.isEmpty || editing?.images.isEmpty == false }
    if let draft, draft.file == item.id, draft.target != .picture { return !trimmed.isEmpty }
    return picture && (!trimmed.isEmpty || !(marks[item.id] ?? []).isEmpty)
  }

  /// Keep the comment being written (or the change to one), and clear the desk for the next. `readKey`: the cache key
  /// of the bytes on screen, which the comment was read on.
  func keep(session: InboxSession, thread: ThreadID, item: AttachmentItem, version: AttachmentVersion, picture: Bool, readKey: String? = nil) {
    guard ready(on: item, picture: picture), !keeping else { return }
    if let editing {
      alreadySent = false
      switch session.editComment(editing.id, thread: thread, words: trimmed) {
      case .changed: break
      case .unchanged:
        // Nothing changed: the editor closes, with no word of success.
        cancel()
        return
      case .alreadyWent:
        // The comment went before the change could: nothing is kept, the words stay in the editor, and it says why.
        alreadySent = true
        UINotificationFeedbackGenerator().notificationOccurred(.error)
        AccessibilityNotification.Announcement(PhoneWords.commentAlreadySent).post()
        return
      }
    } else {
      let target = draft?.file == item.id ? draft?.target : picture ? .picture : nil
      let on = draft?.file == item.id ? draft?.version ?? version : version
      // The key read is the bytes on screen only for the version on screen (a comment begun on the other version
      // keeps to it).
      let read = on == version ? readKey : nil
      switch target {
      case .words(let block, let start, let quote)?:
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.words(block: block, start: start, quote: quote, comment: trimmed), readKey: read)
      case .lines(let range, let code)?:
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.lines(lineStart: range.lowerBound, lineEnd: range.upperBound, code: code, comment: trimmed), readKey: read)
      case .pin(let element)?:
        let order = session.comments(thread, on: item.id).count
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.pin(element: element, order: order, comment: trimmed), readKey: read)
      case .whole?:
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.whole(comment: trimmed), readKey: read)
      case .picture?:
        let drawn = marks[item.id] ?? []
        let words = trimmed
        let add = { (drawing: Data?) in
          session.addComment(thread: thread, item: item, version: on, annotation: FileComments.picture(name: item.name, comment: words, markup: nil), drawing: drawing, marks: drawn.isEmpty ? nil : drawn, readKey: read)
        }
        guard !drawn.isEmpty else {
          _ = add(nil)
          break
        }
        // The drawing goes flattened onto the picture, as the window sends it; the picture is encoded off the main
        // thread, and Comment waits for it.
        guard let flatten, flatten.file == item.id else { return }
        keeping = true
        Task { @MainActor in
          let drawing = await flatten.make(drawn)
          keeping = false
          guard let drawing, let made = add(drawing) else { return }
          marks[item.id] = nil
          marking = false
          UINotificationFeedbackGenerator().notificationOccurred(.success)
          cancel()
          // The window's toast for a drawing added to the reply; Undo takes it back off and puts the marks and
          // words back on the picture.
          toasts.show(ToastWords(mark: .check, lead: PhoneWords.markupAdded, phoneLead: PhoneWords.addedToReply, speech: PhoneWords.markupAddedSpoken), said: { CommentToast.told(session, thread) }) { [weak self] in
            session.removeComment(made.id, thread: thread)
            self?.marks[item.id] = drawn
            if self?.words.isEmpty == true { self?.words = made.isWordlessMarkup ? "" : made.words }
          }
        }
        return
      case nil:
        return
      }
    }
    UINotificationFeedbackGenerator().notificationOccurred(.success)
    cancel()
  }
}

/// The foot of a file cover: the comment being written, above the keyboard. One field with what it is on across
/// its top, as the thread's reply field carries what still waits. A picture's field is always there (a comment
/// can be on the whole picture) with the pencil beside it; a page has its switch here until a spot is pinned.
struct CommentFoot: View {
  let session: InboxSession
  let thread: ThreadID
  let item: AttachmentItem
  let version: AttachmentVersion
  let shown: FileFacts.Shown
  @Bindable var desk: CommentDesk
  /// The cache key of the bytes on screen.
  var readKey: String?
  @FocusState private var focused: Bool
  @ScaledMetric(relativeTo: .body) private var textLine: CGFloat = Size.mark
  private var oneLine: CGFloat { max(Size.replyRow, textLine + 2 * Space.step) }

  private var picture: Bool { shown == .picture }
  private var writing: Bool { desk.editing != nil || desk.draft?.file == item.id }
  private var drawn: [PictureMark] { desk.marks[item.id] ?? [] }

  /// What the comment is on, in the file's own words: the words selected, a line's start, an element's words.
  private var quote: (symbol: String, words: String)? {
    if let editing = desk.editing { return (Self.symbol(editing), Self.label(editing, page: shown == .page)) }
    guard let draft = desk.draft, draft.file == item.id else { return nil }
    switch draft.target {
    case .words(_, _, let quote): return ("text.quote", quote)
    case .lines(let range, let code):
      let first = code.components(separatedBy: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }?.trimmingCharacters(in: .whitespaces) ?? ""
      return ("number", range.count == 1 ? "\(range.lowerBound)  \(first)" : "\(range.lowerBound)–\(range.upperBound)  \(first)")
    case .pin(let element): return ("mappin", element.text.isEmpty ? "<\(element.tag)>" : element.text)
    case .whole: return ("doc.text", shown == .page ? PhoneWords.commentOnPage : PhoneWords.globalComment)
    case .picture: return nil
    }
  }

  static func symbol(_ comment: FileComment) -> String {
    if comment.type == FileComment.whole { return "doc.text" }
    if comment.codeRange != nil { return "number" }
    if comment.elementTag != nil { return "mappin" }
    if !comment.images.isEmpty { return "scribble.variable" }
    return comment.blockId == "image" ? "photo" : "text.quote"
  }

  /// What a kept comment is on, as its row and the field say it: its quote, or for a comment on the whole file the
  /// window's words for one.
  static func label(_ comment: FileComment, page: Bool) -> String {
    guard comment.type == FileComment.whole else { return comment.quote }
    return page ? PhoneWords.commentOnPage : PhoneWords.globalComment
  }

  /// The window's words for each field (packages/inbox/components/ImageAttachmentView.tsx, AttachmentPane.tsx,
  /// HtmlPageComment.tsx).
  private var hint: String {
    if picture, desk.editing == nil { return drawn.isEmpty ? PhoneWords.commentOnImage : PhoneWords.whatShouldChange }
    if shown == .page, desk.editing == nil { return PhoneWords.commentOnPage }
    return PhoneWords.commentOnThis
  }

  var body: some View {
    VStack(spacing: 0) {
      if writing || picture { box } else if shown == .page { pageSwitch }
    }
    .padding(.horizontal, Space.step)
    .padding(.bottom, Space.close)
    .onChange(of: desk.wantsKeyboard) { _, _ in focused = true }
    .onChange(of: desk.words) { _, _ in desk.wordsChanged() }
    .onChange(of: writing) { _, on in if !on, !picture { focused = false } }
  }

  /// Comment, or Use the page: what a touch on the page does (apps/mobile/contract/flows/07-attachment.md).
  private var pageSwitch: some View {
    Picker("", selection: $desk.commenting) {
      Text(PhoneWords.useThePage).tag(false)
      Text(PhoneWords.comment).tag(true)
    }
    .pickerStyle(.segmented)
    .labelsHidden()
    .frame(maxWidth: 280)
    .padding(Space.tight)
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.foot))
    .barSized()
    .accessibilityIdentifier("page-mode")
    // VoiceOver: the switch's action turns Comment on and pins what is in the middle of the page on screen.
    .accessibilityAction(named: PhoneWords.comment) { commentHere() }
    #if DEBUG
      // UI tests cannot perform an accessibility action: in debug builds launched with `-voiceActions`, a button
      // runs the same one.
      .overlay(alignment: .topLeading) {
        if LaunchOptions().voiceActions {
          Button { commentHere() } label: { Color.clear.frame(width: 44, height: 44) }.accessibilityIdentifier("voice-comment").accessibilityLabel(PhoneWords.comment)
        }
      }
    #endif
  }

  /// The VoiceOver action: Comment on, and a pin at the middle of this file's page (not another page's).
  private func commentHere() {
    if !desk.commenting { desk.commenting = true }
    desk.pinMiddle[item.id]?()
  }

  private var box: some View {
    VStack(spacing: 0) {
      if let quote {
        HStack(alignment: .firstTextBaseline, spacing: Space.close) {
          Image(systemName: quote.symbol).foregroundStyle(Token.mutedForeground).accessibilityHidden(true)
          Text(quote.words).foregroundStyle(Token.foreground).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityIdentifier("comment-quote")
          Button {
            desk.cancel()
            focused = false
          } label: {
            Image(systemName: "xmark").font(TextRole.glyph).foregroundStyle(Token.mutedForeground).touchTarget()
          }
          .buttonStyle(PressStyle())
          .accessibilityLabel(PhoneWords.cancel)
        }
        .font(TextRole.link)
        .padding(.leading, Space.card)
        .barSized()
        Hairline().padding(.horizontal, Space.card)
      }
      // A change that was not kept, said as an action item's refusal is (ActionChecklist), over the words.
      if desk.alreadySent, desk.editing != nil {
        Label(PhoneWords.commentAlreadySent, systemImage: "exclamationmark.circle")
          .font(TextRole.meta)
          .foregroundStyle(Token.destructive)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, Space.card)
          .padding(.top, Space.step)
          .accessibilityElement(children: .combine)
          .accessibilityIdentifier("comment-already-sent")
      }
      HStack(alignment: .bottom, spacing: 0) {
        if picture, desk.editing == nil { pencil.frame(minHeight: oneLine) }
        TextField("", text: $desk.words, axis: .vertical)
          .lineLimit(1...5)
          .font(TextRole.body)
          .focused($focused)
          .padding(.leading, picture && desk.editing == nil ? Space.tight : Space.card)
          .padding(.vertical, Space.step)
          .overlay(alignment: .topLeading) {
            if desk.words.isEmpty {
              Text(hint).lineLimit(1).font(TextRole.body).foregroundStyle(Color(uiColor: .placeholderText))
                .padding(.leading, picture && desk.editing == nil ? Space.tight : Space.card)
                .padding(.vertical, Space.step)
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
          }
          .frame(minHeight: Size.replyRow)
          .accessibilityLabel(hint)
          .accessibilityIdentifier("comment-field")
        let ready = desk.ready(on: item, picture: picture)
        Button {
          desk.keep(session: session, thread: thread, item: item, version: version, picture: picture, readKey: readKey)
          focused = false
        } label: {
          SendDisc(ready: ready, symbol: "checkmark")
        }
        .buttonStyle(PressStyle())
        .disabled(!ready || desk.keeping)
        .accessibilityLabel(PhoneWords.comment)
        .accessibilityIdentifier("comment-keep")
        .barSized()
        .frame(minHeight: oneLine)
      }
    }
    .glassEffect(.regular, in: .rect(cornerRadius: Radius.foot))
  }

  /// Mark up: the picture takes the finger. Beside it, while something is drawn, the way to take the last mark back.
  @ViewBuilder private var pencil: some View {
    if session.takesDrawings() {
      HStack(spacing: 0) {
        Button {
          desk.marking.toggle()
          UISelectionFeedbackGenerator().selectionChanged()
        } label: {
          Image(systemName: "scribble.variable")
            .font(TextRole.body.weight(.semibold))
            .foregroundStyle(desk.marking ? Token.primaryForeground : Token.foreground)
            .frame(width: Size.sendDisc, height: Size.sendDisc)
            .background(desk.marking ? Token.primary : Token.foreground.opacity(0.08), in: Circle())
            .padding(Space.trim)
            .touchTarget()
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(PhoneWords.markUp)
        .accessibilityAddTraits(desk.marking ? .isSelected : [])
        .accessibilityIdentifier("picture-mark")
        if !drawn.isEmpty {
          Button {
            desk.marks[item.id]?.removeLast()
          } label: {
            Image(systemName: "arrow.uturn.backward").font(TextRole.body.weight(.medium)).foregroundStyle(Token.foreground).touchTarget()
          }
          .buttonStyle(PressStyle())
          .accessibilityLabel(PhoneWords.undo)
          .accessibilityIdentifier("picture-undo")
        }
      }
      .barSized()
    }
  }
}

/// The comments that wait for the next Send, file by file: a touch goes to where one is; a swipe or a long press
/// changes its words or removes it. A comment the next Send does not carry says why. At the foot, what rides the
/// next Send, in the window's words (packages/inbox/components/AttachmentPane.tsx, the panel's foot).
struct CommentsSheet: View {
  let session: InboxSession
  let thread: ThreadID
  /// The file on screen behind the list, when it is opened from a file: the foot counts the comments on others.
  var current: AttachmentID?
  let toasts: CommentToast
  /// Go to a comment's place in its file.
  let open: (FileComment) -> Void
  let edit: (FileComment) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let comments = session.comments(thread)
    let files = session.attachments(thread)
    let order = comments.map(\.attachment).reduce(into: [AttachmentID]()) { if !$0.contains($1) { $0.append($1) } }
    let riding = session.commentsToSend(thread)
    NavigationStack {
      List {
        ForEach(order, id: \.self) { file in
          Section {
            ForEach(comments.filter { $0.attachment == file }) { comment in
              Button {
                dismiss()
                open(comment)
              } label: {
                CommentRow(session: session, comment: comment, standing: session.commentStanding(comment, in: thread), page: files.first { $0.id == file }?.kind == .html)
              }
              .buttonStyle(RowStyle(selected: false))
              .listRowInsets(EdgeInsets())
              .listRowBackground(Surface.sheet)
              .swipeActions(edge: .trailing) {
                Button(role: .destructive) { toasts.removed(comment.id, thread: thread, session: session) } label: { Label(PhoneWords.remove, systemImage: "trash") }
                Button {
                  dismiss()
                  edit(comment)
                } label: {
                  Label(PhoneWords.editComment, systemImage: "pencil")
                }
                .tint(Token.primary)
              }
              .contextMenu {
                Button {
                  dismiss()
                  edit(comment)
                } label: {
                  Label(PhoneWords.editComment, systemImage: "pencil")
                }
                Button(role: .destructive) { toasts.removed(comment.id, thread: thread, session: session) } label: { Label(PhoneWords.remove, systemImage: "trash") }
              }
              .accessibilityIdentifier("comment/\(comment.words)")
            }
          } header: {
            Text(files.first { $0.id == file }?.name ?? "").font(TextRole.name).foregroundStyle(Token.mutedForeground).textCase(nil)
          }
        }
        if !riding.isEmpty {
          Section {
            Text(PhoneWords.commentsRide(riding.count, agent: agent, elsewhere: current.map { here in riding.filter { $0.attachment != here }.count } ?? 0))
              .font(TextRole.meta)
              .foregroundStyle(Token.mutedForeground)
              .padding(.horizontal, Space.page)
              .padding(.vertical, Space.step)
              .frame(maxWidth: .infinity, alignment: .leading)
              .listRowInsets(EdgeInsets())
              .listRowBackground(Surface.sheet)
              .listRowSeparator(.hidden)
              .accessibilityIdentifier("comments-ride")
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .background(Surface.sheet)
      .navigationTitle(comments.isEmpty ? PhoneWords.noComments : CountWords.comments(comments.count))
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { Button(PhoneWords.done) { dismiss() } }
      }
    }
    .commentToast(toasts)
    .presentationDetents([.medium, .large])
    .presentationBackground(Surface.sheet)
    .onChange(of: comments.isEmpty) { _, empty in if empty { dismiss() } }
  }

  /// The agent the thread's lines name, as the thread's own foot says it.
  private var agent: String { session.thread(thread).map { ThreadScreen.agentName($0.thread, row: session.row(thread)) } ?? PhoneWords.anAgent }
}

struct CommentRow: View {
  let session: InboxSession
  let comment: FileComment
  var standing: CommentStanding = .goes
  var page = false

  /// Why the next Send leaves it, or how it goes, in words the app already says.
  private var note: (words: String, symbol: String, role: Color)? {
    switch standing {
    case .goes: return nil
    case .unanchored: return (PhoneWords.unanchored, "location.slash", Token.mutedForeground)
    case .drawingWaits: return (PhoneWords.needsNetwork, "wifi", Token.mutedForeground)
    case .notSaved: return (PhoneWords.commentNotSaved, "exclamationmark.circle", Token.destructive)
    case .window: return (PhoneWords.replyOnComputer, "desktopcomputer", Token.mutedForeground)
    }
  }

  var body: some View {
    HStack(alignment: .top, spacing: Space.step) {
      Image(systemName: CommentFoot.symbol(comment)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).frame(width: Size.mark).padding(.top, Space.hair).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.tight) {
        // A picture's quote is its own name, which the section already says.
        if comment.blockId != "image" {
          Text(comment.codeRange.map { range in "\(range.lineStart == range.lineEnd ? "\(range.lineStart)" : "\(range.lineStart)–\(range.lineEnd)")  \(comment.quote)" } ?? CommentFoot.label(comment, page: page))
            .font(comment.codeRange == nil ? TextRole.secondary : TextRole.code(.footnote))
            .foregroundStyle(Token.mutedForeground)
            .lineLimit(2)
        }
        Text(comment.words).font(TextRole.body).foregroundStyle(Token.foreground).multilineTextAlignment(.leading)
        if let note {
          Label(note.words, systemImage: note.symbol).font(TextRole.meta).foregroundStyle(note.role)
            .accessibilityIdentifier("comment-standing")
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .padding(.horizontal, Space.page)
    .padding(.vertical, Space.step)
    .frame(minHeight: Space.touch)
    .contentShape(Rectangle())
    .accessibilityElement(children: .combine)
  }
}
