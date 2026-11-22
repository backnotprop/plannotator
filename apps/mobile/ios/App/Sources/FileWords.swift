import InboxCore
import InboxWire
import SwiftUI
import UIKit

/// Words of a document that can be selected and commented on: a text view that does not scroll or edit, whose edit
/// menu has Comment first, before the system's Copy and Look Up. A selection's handles and the menu are the
/// system's own, so they behave as everywhere else on the phone; Comment hands the selection (where it starts, and
/// the words) to the cover's comment field.
///
/// Words already commented on carry a tint; a touch on them opens that comment. Links open only over http, https
/// and mailto, as the window's document links do: never another app's scheme, and never this app's own.
struct SelectableWords: UIViewRepresentable {
  let words: NSAttributedString
  /// Whether a selection can be commented on (the file takes comments).
  var comments = true
  /// The parts already commented on, with their comments.
  var marked: [(range: NSRange, comment: FileComment)] = []
  /// The part a comment is being written on now: it keeps a stronger tint while the selection's handles are gone.
  var writing: NSRange?
  /// What the words' state is, for VoiceOver (a task box: ticked or not). Nil: none.
  var state: String?
  /// Comment was chosen for a selection: where it starts in these words, and the words.
  var comment: (Int, String) -> Void = { _, _ in }
  var opened: (FileComment) -> Void = { _ in }

  /// The schemes a document's link may open (packages/ui/components/InlineMarkdown.tsx: a link, or a mail address).
  static func opens(_ url: URL) -> Bool { FileFacts.documentLinkOpens(url) }

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeUIView(context: Context) -> UITextView {
    let view = UITextView(usingTextLayoutManager: false)
    view.isEditable = false
    view.isSelectable = true
    view.isScrollEnabled = false
    view.backgroundColor = .clear
    view.textContainerInset = .zero
    view.textContainer.lineFragmentPadding = 0
    view.adjustsFontForContentSizeCategory = false
    view.dataDetectorTypes = []
    view.delegate = context.coordinator
    view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    view.linkTextAttributes = [.foregroundColor: UIColor(Token.primary), .underlineStyle: 0]
    let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tapped(_:)))
    tap.delegate = context.coordinator
    view.addGestureRecognizer(tap)
    return view
  }

  func updateUIView(_ view: UITextView, context: Context) {
    context.coordinator.parent = self
    let drawn = Self.tinted(words, marked.map(\.range), writing: writing)
    if !view.attributedText.isEqual(to: drawn) { view.attributedText = drawn }
    // VoiceOver: the words' own Comment, on all of them (a selection is hard to make without sight), and Edit the
    // comment for each comment already on them.
    view.accessibilityCustomActions = Self.voiceActions(words: words.string, comments: comments, marked: marked.map(\.comment), comment: { [coordinator = context.coordinator] in
      coordinator.parent.comment($0, $1)
    }, opened: { [coordinator = context.coordinator] in coordinator.parent.opened($0) })
    // Read as its words, with its state after them: the words are the label, the state the value.
    if let state {
      view.accessibilityLabel = words.string
      view.accessibilityValue = state
    }
  }

  /// The words' actions for VoiceOver: Comment on the whole run of words (where it starts past its leading blanks,
  /// as a selection of them would), and Edit the comment for each comment on them.
  static func voiceActions(words: String, comments: Bool, marked: [FileComment], comment: @escaping (Int, String) -> Void, opened: @escaping (FileComment) -> Void) -> [UIAccessibilityCustomAction] {
    var actions: [UIAccessibilityCustomAction] = []
    let quote = words.trimmingCharacters(in: .whitespacesAndNewlines)
    if comments, !quote.isEmpty {
      let start = (words as NSString).range(of: quote).location
      actions.append(UIAccessibilityCustomAction(name: PhoneWords.comment) { _ in
        comment(start == NSNotFound ? 0 : start, quote)
        return true
      })
    }
    for kept in marked {
      actions.append(UIAccessibilityCustomAction(name: "\(PhoneWords.editComment): \(kept.words)") { _ in
        opened(kept)
        return true
      })
    }
    return actions
  }

  func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
    let width = proposal.width ?? UIScreen.main.bounds.width
    guard width.isFinite, width > 0 else { return nil }
    return CGSize(width: width, height: ceil(uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude)).height))
  }

  /// The accent as a ground under words: stronger on a dark page, where a faint one is lost.
  static func tint(_ light: CGFloat, dark: CGFloat) -> UIColor {
    UIColor { traits in UIColor(Token.primary).resolvedColor(with: traits).withAlphaComponent(traits.userInterfaceStyle == .dark ? dark : light) }
  }

  /// The words with a tint under each commented part.
  static func tinted(_ words: NSAttributedString, _ ranges: [NSRange], writing: NSRange? = nil) -> NSAttributedString {
    guard !ranges.isEmpty || writing != nil else { return words }
    let out = NSMutableAttributedString(attributedString: words)
    for range in ranges where range.location >= 0 && NSMaxRange(range) <= out.length {
      out.addAttribute(.backgroundColor, value: Self.tint(0.2, dark: 0.36), range: range)
    }
    if let writing, writing.location >= 0, NSMaxRange(writing) <= out.length { out.addAttribute(.backgroundColor, value: Self.tint(0.38, dark: 0.55), range: writing) }
    return out
  }

  final class Coordinator: NSObject, UITextViewDelegate, UIGestureRecognizerDelegate {
    var parent: SelectableWords
    init(_ parent: SelectableWords) { self.parent = parent }

    func textView(_ view: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
      guard parent.comments, range.length > 0, let chosen = view.attributedText?.attributedSubstring(from: range).string, !chosen.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return UIMenu(children: suggestedActions) }
      let comment = UIAction(title: PhoneWords.comment, image: UIImage(systemName: "text.bubble")) { [weak self, weak view] _ in
        view?.selectedTextRange = nil
        self?.parent.comment(range.location, chosen)
      }
      return UIMenu(children: [comment] + suggestedActions)
    }

    func textView(_ view: UITextView, primaryActionFor item: UITextItem, defaultAction: UIAction) -> UIAction? {
      guard case .link(let url) = item.content else { return defaultAction }
      return SelectableWords.opens(url) ? defaultAction : nil
    }

    func textView(_ view: UITextView, menuConfigurationFor item: UITextItem, defaultMenu: UIMenu) -> UITextItem.MenuConfiguration? {
      guard case .link(let url) = item.content, !SelectableWords.opens(url) else { return .init(menu: defaultMenu) }
      return nil
    }

    func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }

    /// A touch on words already commented on opens that comment.
    @objc func tapped(_ tap: UITapGestureRecognizer) {
      guard let view = tap.view as? UITextView, !parent.marked.isEmpty else { return }
      let point = tap.location(in: view)
      let index = view.layoutManager.characterIndex(for: point, in: view.textContainer, fractionOfDistanceBetweenInsertionPoints: nil)
      // A touch past the end of a line is on no word.
      let glyphs = view.layoutManager.glyphRange(forCharacterRange: NSRange(location: index, length: 1), actualCharacterRange: nil)
      guard view.layoutManager.boundingRect(forGlyphRange: glyphs, in: view.textContainer).insetBy(dx: -4, dy: -4).contains(point) else { return }
      if let hit = parent.marked.first(where: { NSLocationInRange(index, $0.range) }) { parent.opened(hit.comment) }
    }
  }
}

/// A document's words as the text view draws them: the system's reading of inline Markdown, with the app's own
/// faces and colours.
@MainActor
enum WordsInk {
  /// `style`: the words' text style; `weight`: nil keeps the style's own.
  static func attributed(_ content: String, style: UIFont.TextStyle = .body, weight: UIFont.Weight? = nil, ink: Color = Token.foreground, leading: CGFloat = TextRole.bodyLeading, mono: Bool = false, size: DynamicTypeSize, plain: Bool = false) -> NSAttributedString {
    let traits = UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory(size))
    let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: traits)
    func face(bold: Bool, italic: Bool, code: Bool) -> UIFont {
      var font = code || mono ? UIFont.monospacedSystemFont(ofSize: mono ? base.pointSize : base.pointSize * 0.94, weight: bold ? .semibold : .regular) : UIFont.systemFont(ofSize: base.pointSize, weight: bold ? .semibold : weight ?? .regular)
      if italic, let slanted = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) { font = UIFont(descriptor: slanted, size: font.pointSize) }
      return font
    }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineSpacing = leading
    let color = UIColor(ink)
    let out = NSMutableAttributedString()
    // Plain text is read as written: a star or an underscore in it is a letter.
    let read = mono || plain ? AttributedString(content) : MessageBody.attributed(content)
    for run in read.runs {
      let intent = run.inlinePresentationIntent ?? []
      var attributes: [NSAttributedString.Key: Any] = [
        .font: face(bold: intent.contains(.stronglyEmphasized), italic: intent.contains(.emphasized), code: intent.contains(.code)),
        .foregroundColor: color, .paragraphStyle: paragraph,
      ]
      if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if let link = run.link { attributes[.link] = link }
      out.append(NSAttributedString(string: String(read[run.range].characters), attributes: attributes))
    }
    return out
  }

  /// Where each comment's words are in a block's drawn words: at the place the comment names when the words are
  /// still there, else where they first read the same. A comment whose words are gone marks nothing.
  static func marks(_ comments: [FileComment], in words: NSAttributedString, base: Int = 0) -> [(range: NSRange, comment: FileComment)] {
    let text = words.string as NSString
    return comments.compactMap { comment in
      let quote = comment.quote as NSString
      guard quote.length > 0 else { return nil }
      let at = Int(comment.startOffset) - base
      if at >= 0, at + quote.length <= text.length, text.substring(with: NSRange(location: at, length: quote.length)) == comment.quote { return (NSRange(location: at, length: quote.length), comment) }
      let found = text.range(of: comment.quote)
      return found.location == NSNotFound ? nil : (found, comment)
    }
  }
}

/// What a document's viewer needs to take comments: the file, the version on screen, and the cover's desk.
struct CommentContext {
  let session: InboxSession
  let thread: ThreadID
  let item: AttachmentItem
  let version: AttachmentVersion
  let desk: CommentDesk

  @MainActor var takes: Bool { session.takesComments(item, in: thread) }
  /// The comments on this file's version on screen.
  @MainActor var comments: [FileComment] {
    let name = InboxSession.commentVersion(item, version)
    return session.comments(thread, on: item.id).filter { $0.version == name }
  }

  /// Where the words being commented on are in a run of drawn words that starts at `base` and names `block`.
  @MainActor func writing(block: String, base: Int, in words: NSAttributedString) -> NSRange? {
    guard let draft = desk.draft, draft.file == item.id, case .words(let named, let start, let quote) = draft.target, named == block else { return nil }
    let range = NSRange(location: start - base, length: (quote as NSString).length)
    guard range.location >= 0, NSMaxRange(range) <= words.length, (words.string as NSString).substring(with: range) == quote else { return nil }
    return range
  }

  @MainActor func begin(_ target: CommentDesk.Target) { desk.begin(CommentDesk.Draft(file: item.id, version: version, target: target)) }
}
