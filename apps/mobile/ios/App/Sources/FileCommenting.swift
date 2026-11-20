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
  /// Each picture's viewer, to flatten what was drawn onto the picture as a PNG.
  @ObservationIgnored var flatten: [AttachmentID: ([PictureMark]) -> Data?] = [:]

  func begin(_ draft: Draft) {
    editing = nil
    if self.draft == nil { words = "" }
    self.draft = draft
    wantsKeyboard += 1
  }

  func edit(_ comment: FileComment) {
    draft = nil
    editing = comment
    words = comment.isWordlessMarkup ? "" : comment.words
    wantsKeyboard += 1
  }

  func cancel() {
    draft = nil
    editing = nil
    words = ""
  }

  func seek(_ comment: FileComment) { sought = Sought(comment: comment, turn: (sought?.turn ?? 0) + 1) }

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

  /// Keep the comment being written (or the change to one), and clear the desk for the next.
  func keep(session: InboxSession, thread: ThreadID, item: AttachmentItem, version: AttachmentVersion, picture: Bool) {
    guard ready(on: item, picture: picture) else { return }
    if let editing {
      session.editComment(editing.id, thread: thread, words: trimmed)
    } else {
      let target = draft?.file == item.id ? draft?.target : picture ? .picture : nil
      let on = draft?.file == item.id ? draft?.version ?? version : version
      switch target {
      case .words(let block, let start, let quote)?:
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.words(block: block, start: start, quote: quote, comment: trimmed))
      case .lines(let range, let code)?:
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.lines(lineStart: range.lowerBound, lineEnd: range.upperBound, code: code, comment: trimmed))
      case .pin(let element)?:
        let order = session.comments(thread, on: item.id).count
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.pin(element: element, order: order, comment: trimmed))
      case .picture?:
        let drawn = marks[item.id] ?? []
        // The drawing goes flattened onto the picture, as the window sends it.
        let drawing = drawn.isEmpty ? nil : flatten[item.id]?(drawn)
        if !drawn.isEmpty, drawing == nil { return }
        session.addComment(thread: thread, item: item, version: on, annotation: FileComments.picture(name: item.name, comment: trimmed, markup: nil), drawing: drawing, marks: drawn.isEmpty ? nil : drawn)
        marks[item.id] = nil
        marking = false
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
  @FocusState private var focused: Bool
  @ScaledMetric(relativeTo: .body) private var textLine: CGFloat = Size.mark
  private var oneLine: CGFloat { max(Size.replyRow, textLine + 2 * Space.step) }

  private var picture: Bool { shown == .picture }
  private var writing: Bool { desk.editing != nil || desk.draft?.file == item.id }
  private var drawn: [PictureMark] { desk.marks[item.id] ?? [] }

  /// What the comment is on, in the file's own words: the words selected, a line's start, an element's words.
  private var quote: (symbol: String, words: String)? {
    if let editing = desk.editing { return (Self.symbol(editing), editing.quote) }
    guard let draft = desk.draft, draft.file == item.id else { return nil }
    switch draft.target {
    case .words(_, _, let quote): return ("text.quote", quote)
    case .lines(let range, let code):
      let first = code.components(separatedBy: "\n").first { !$0.trimmingCharacters(in: .whitespaces).isEmpty }?.trimmingCharacters(in: .whitespaces) ?? ""
      return ("number", range.count == 1 ? "\(range.lowerBound)  \(first)" : "\(range.lowerBound)–\(range.upperBound)  \(first)")
    case .pin(let element): return ("mappin", element.text.isEmpty ? "<\(element.tag)>" : element.text)
    case .picture: return nil
    }
  }

  static func symbol(_ comment: FileComment) -> String {
    if comment.codeRange != nil { return "number" }
    if comment.elementTag != nil { return "mappin" }
    if !comment.images.isEmpty { return "scribble.variable" }
    return comment.blockId == "image" ? "photo" : "text.quote"
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
          desk.keep(session: session, thread: thread, item: item, version: version, picture: picture)
          focused = false
        } label: {
          SendDisc(ready: ready, symbol: "checkmark")
        }
        .buttonStyle(PressStyle())
        .disabled(!ready)
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
/// changes its words or removes it.
struct CommentsSheet: View {
  let session: InboxSession
  let thread: ThreadID
  /// Go to a comment's place in its file.
  let open: (FileComment) -> Void
  let edit: (FileComment) -> Void
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    let comments = session.comments(thread)
    let files = session.attachments(thread)
    let order = comments.map(\.attachment).reduce(into: [AttachmentID]()) { if !$0.contains($1) { $0.append($1) } }
    NavigationStack {
      List {
        ForEach(order, id: \.self) { file in
          Section {
            ForEach(comments.filter { $0.attachment == file }) { comment in
              Button {
                dismiss()
                open(comment)
              } label: {
                CommentRow(session: session, comment: comment)
              }
              .buttonStyle(RowStyle(selected: false))
              .listRowInsets(EdgeInsets())
              .listRowBackground(Surface.sheet)
              .swipeActions(edge: .trailing) {
                Button(role: .destructive) { session.removeComment(comment.id, thread: thread) } label: { Label(PhoneWords.remove, systemImage: "trash") }
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
                Button(role: .destructive) { session.removeComment(comment.id, thread: thread) } label: { Label(PhoneWords.remove, systemImage: "trash") }
              }
              .accessibilityIdentifier("comment/\(comment.words)")
            }
          } header: {
            Text(files.first { $0.id == file }?.name ?? "").font(TextRole.name).foregroundStyle(Token.mutedForeground).textCase(nil)
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
    .presentationDetents([.medium, .large])
    .presentationBackground(Surface.sheet)
    .onChange(of: comments.isEmpty) { _, empty in if empty { dismiss() } }
  }
}

struct CommentRow: View {
  let session: InboxSession
  let comment: FileComment

  var body: some View {
    HStack(alignment: .top, spacing: Space.step) {
      Image(systemName: CommentFoot.symbol(comment)).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).frame(width: Size.mark).padding(.top, Space.hair).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: Space.tight) {
        // A picture's quote is its own name, which the section already says.
        if comment.blockId != "image" {
          Text(comment.codeRange.map { range in "\(range.lineStart == range.lineEnd ? "\(range.lineStart)" : "\(range.lineStart)–\(range.lineEnd)")  \(comment.quote)" } ?? comment.quote)
            .font(comment.codeRange == nil ? TextRole.secondary : TextRole.code(.footnote))
            .foregroundStyle(Token.mutedForeground)
            .lineLimit(2)
        }
        Text(comment.words).font(TextRole.body).foregroundStyle(Token.foreground).multilineTextAlignment(.leading)
        if session.commentRefusal(comment.id) != nil {
          Label(PhoneWords.commentNotSaved, systemImage: "exclamationmark.circle").font(TextRole.meta).foregroundStyle(Token.destructive)
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
