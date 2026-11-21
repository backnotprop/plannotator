import SwiftUI

// The app's look, in one place: every screen takes its spacing, type, surfaces and controls from here, so a new
// screen inherits the product's rhythm instead of choosing numbers of its own. The colours are the contract's
// (`Token`, Theme.swift); this file is what the app does with them. The pieces the next screens need (rows,
// raised surfaces, media, states) are in LookKit.swift.
//
// The rules the pieces hold to:
//   - One thing is emphasised at a time. A card's prompt is its only heavy line; everything else steps down.
//   - Colour is a role, never decoration: the accent is what the person can do or has done, amber is work held up
//     or a caution, red is an agent stopped or a thing destroyed, green is a thing finished.
//   - Hairlines part things; a ground (a well) is kept for what the person chose.
//   - A length between things is a step of `Space`; a thing's own measure is in `Size`; a corner is one of
//     `Radius`, and a shape inside another keeps the same centre (its radius is the outer one less the gap).
//   - A fraction of a mark's own side (a tick inside a ring, a nudge onto the text's line) is written where the
//     mark is drawn: it is the mark's drawing, not a length of the layout.

/// The spacing scale, in points: the room between things and inside them.
enum Space {
  /// Between two lines that are one thought (a label and its detail).
  static let hair: CGFloat = 2
  static let tight: CGFloat = 4
  /// A line and the one it explains; a dot and its words.
  static let trim: CGFloat = 6
  /// Between parts of one group.
  static let close: CGFloat = 8
  /// The air over and under the words in a row, a field or a button.
  static let near: CGFloat = 10
  /// Between groups inside a card; a mark and its words.
  static let step: CGFloat = 12
  /// A card's words and its answers; the inside of a code box.
  static let snug: CGFloat = 14
  /// A card's own padding; the list's page edge.
  static let card: CGFloat = 16
  /// The thread's page edge.
  static let page: CGFloat = 20
  /// Between sections of a page.
  static let section: CGFloat = 24
  /// The least a thing to touch measures, either way.
  static let touch: CGFloat = 44
}

/// The measures of the controls themselves.
enum Size {
  /// A button that is an answer.
  static let button: CGFloat = 48
  /// The one thing to do on a screen.
  static let wideButton: CGFloat = 50
  /// A tinted capsule inside a 44-point target (Accept recommended).
  static let capsule: CGFloat = 34
  /// Send's disc at the default text size: 6 points in from the reply field's edge all round.
  static let sendDisc: CGFloat = 36
  /// Copy's own square inside its 44-point target.
  static let copy: CGFloat = 32
  /// A choice's mark at the default text size, and the most it grows to (`MarkSide`).
  static let mark: CGFloat = 22
  static let markCap: CGFloat = 32
  /// The reply field's one line: Send's disc with 6 points over and under it.
  static let replyRow: CGFloat = 48
  /// A field with room for a sentence or two (a reason).
  static let reasonField: CGFloat = 64
  /// The line numbers' column in a file's preview.
  static let gutter: CGFloat = 26
  /// Where a drawing that scrolls sideways fades out at its cut edge.
  static let codeFade: CGFloat = 56
  /// The title bar's way back with the air on both its sides (the system's 44-point button, 16 from the edge,
  /// 12 before the title).
  static let barSide: CGFloat = 72
  /// The largest text size a line of the foot or a bar grows to. Past it the page would lose the screen to its
  /// own chrome; the system's bars stop too, and offer the Large Content Viewer instead (`barSized()`).
  static let barText = DynamicTypeSize.accessibility2
}

/// The corners. A card holds wells and controls 4 points in from its edge, so theirs is 4 less.
enum Radius {
  static let card: CGFloat = 20
  /// A well or a row's ground inside a card.
  static let well: CGFloat = 16
  /// A button.
  static let control: CGFloat = 12
  /// A field, a code box (tokens.json `radius`).
  static let field: CGFloat = Token.radius
  /// The reply field at a thread's foot.
  static let foot: CGFloat = 24
  /// A small word on a tinted ground: a capsule on one line, still rounded on two.
  static let chip: CGFloat = 11
  /// Copy's square, a thumbnail.
  static let thumb: CGFloat = 8
}

/// The type roles. All are system text styles, so each follows the person's text size and keeps the system's own
/// tracking and leading for its size; hierarchy is the step in size and weight between roles, never colour alone.
enum TextRole {
  /// A card's question: the one heavy line on it.
  static let prompt = Font.title3.weight(.semibold)
  /// A choice, a task, a row's title.
  static let label = Font.body.weight(.medium)
  /// A message's words.
  static let body = Font.body
  /// The words on a button.
  static let action = Font.body.weight(.semibold)
  /// A choice's detail, a card's context, a preview.
  static let secondary = Font.subheadline
  /// Words alone that can be touched.
  static let link = Font.subheadline.weight(.medium)
  /// A name over a message, a section's name.
  static let name = Font.subheadline.weight(.semibold)
  /// Times, counts, where a thing stands ("Picked 12:23 AM · in your draft").
  static let meta = Font.footnote
  static let metaStrong = Font.footnote.weight(.semibold)
  /// The smallest words: a line under a title, a tag.
  static let caption = Font.caption
  static let captionStrong = Font.caption.weight(.semibold)
  /// A small arrow beside words (a chevron).
  static let glyph = Font.caption.weight(.bold)
  /// Code is set a step under the words around it, as in the window: a line of it holds more, so it wraps less.
  static func code(_ style: Font.TextStyle = .subheadline) -> Font { .system(style, design: .monospaced) }
  /// A heading inside a message; a name in a bar.
  static let heading = Font.headline
  /// Extra room between the lines of sentences to read, and of code.
  static let bodyLeading: CGFloat = 3
  static let codeLeading: CGFloat = 2
}

/// What a colour says. Views name the role; the role names the token.
enum Role {
  /// The person's own doing: a pick, Send, a thing to touch.
  case act
  /// Work held up until the person answers.
  case hold
  /// A warning about the answer itself ("Can't be undone").
  case caution
  /// An agent stopped.
  case stop
  /// A thing the person destroys (delete, remove): a swipe's or a menu's red.
  case destructive
  /// A thing finished.
  case done
  case quiet

  var ink: Color {
    switch self {
    case .act: return Token.primary
    case .hold, .caution: return Token.warning
    case .stop, .destructive: return Token.destructive
    case .done: return Token.success
    case .quiet: return Token.mutedForeground
    }
  }

  /// The role's colour as words on a tint of itself (a chip, a count): a quarter of the way to the foreground,
  /// so the words keep 4.5:1 on the tint over a card, the page or a well, in the dark and in the light.
  var inkOnTint: Color { self == .quiet ? ink : ink.mix(with: Token.foreground, by: 0.25) }
  /// The tint under those words.
  var tint: Color { self == .quiet ? Token.muted : ink.opacity(0.14) }
}

/// How things move. Motion is kept for what it means: a pick settling, a thing taking its colour, a touch
/// answered. With Reduce Motion on, each is a short fade and nothing changes size.
enum Motion {
  /// A mark filling after a finger set it down: a short spring with a little give.
  case settle
  /// A ground or a colour arriving.
  case fade
  /// A touch, down and up.
  case press

  func animation(still: Bool) -> Animation {
    switch self {
    case .settle: return still ? .easeOut(duration: 0.15) : .spring(response: 0.26, dampingFraction: 0.74)
    case .fade: return .easeOut(duration: still ? 0.15 : 0.2)
    case .press: return .easeOut(duration: 0.12)
    }
  }
}

private struct Moves<Value: Equatable>: ViewModifier {
  let motion: Motion
  let value: Value
  @Environment(\.accessibilityReduceMotion) private var still

  func body(content: Content) -> some View { content.animation(motion.animation(still: still), value: value) }
}

/// A choice's mark side at the person's text size: 22 points, growing with the text to 32, so the words keep the
/// row's width at the largest sizes. Everything that stands in the marks' column reads this one value.
@propertyWrapper
struct MarkSide: DynamicProperty {
  @ScaledMetric(relativeTo: .body) private var scaled: CGFloat = Size.mark
  var wrappedValue: CGFloat { min(scaled, Size.markCap) }
  /// From a mark's left edge to the words beside it: what stands under a row starts here.
  var projectedValue: CGFloat { wrappedValue + Space.step }
}

extension View {
  /// Animate with one of the app's motions when `value` changes; Reduce Motion is read here, once.
  func motion<Value: Equatable>(_ motion: Motion, value: Value) -> some View { modifier(Moves(motion: motion, value: value)) }

  /// A thing to touch: 44 points at least both ways, and all of it answers, its padding too. Put it after the
  /// padding.
  func touchTarget() -> some View { frame(minWidth: Space.touch, minHeight: Space.touch).contentShape(Rectangle()) }

  /// A line of a bar or of the foot: it grows with the text to `Size.barText`, and past that a long press shows
  /// it large (the Large Content Viewer), as the system's own bars do.
  func barSized() -> some View { dynamicTypeSize(...Size.barText).accessibilityShowsLargeContentViewer() }

  /// A field's ground: a tint and a hairline, so it reads as a field on a card in the dark too. Focused, its
  /// hairline takes the accent.
  func fieldGround(radius: CGFloat = Radius.field, focused: Bool = false) -> some View {
    background(Token.input.opacity(0.5), in: RoundedRectangle(cornerRadius: radius, style: .continuous))
      .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(focused ? Token.ring : Token.foreground.opacity(0.14), lineWidth: focused ? 1.5 : 1))
      .motion(.fade, value: focused)
  }
}

/// A line that parts two things.
struct Hairline: View {
  var body: some View { Divider().overlay(Token.border) }
}

/// A card's surface: the card ground, one hairline, no shadow (the ground already lifts it off the page).
private struct CardSurface: ViewModifier {
  /// The card holds something of the person's that has not gone yet (a pick in the draft): its edge says so.
  let drafted: Bool

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
    content
      .background(Token.card, in: shape)
      // The drafted edge is 4.6:1 on the card in the dark and 4.0:1 in the light.
      .overlay(shape.strokeBorder(drafted ? Token.primary.opacity(0.75) : Token.border.opacity(0.6), lineWidth: drafted ? 1 : 0.5))
  }
}

extension View {
  /// The one card surface. Its content pads itself by `Space.card`.
  func cardSurface(drafted: Bool = false) -> some View { modifier(CardSurface(drafted: drafted)) }
}

/// How a thing answers a touch: at once, on the way down. It dims and gives a little, and comes back when let go.
struct PressStyle: ButtonStyle {
  /// A whole row dims only: a wide thing that shrinks reads as the page moving.
  var gives = true
  @Environment(\.accessibilityReduceMotion) private var still

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .opacity(configuration.isPressed ? 0.6 : 1)
      .scaleEffect(configuration.isPressed && gives && !still ? 0.97 : 1)
      .animation(Motion.press.animation(still: still), value: configuration.isPressed)
  }
}

/// A button's ground and words. Filled is the one thing to do; neutral is another answer of the same rank;
/// destructive is a thing destroyed; bare is words alone in the accent; off is a filled button that cannot be
/// used yet.
struct ActionGround: ViewModifier {
  enum Tone { case filled, neutral, destructive, bare, off }
  let tone: Tone
  /// The whole width, or as wide as its words.
  var wide = true
  var height: CGFloat = Size.button

  private var ink: Color {
    switch tone {
    case .filled: return Token.primaryForeground
    case .neutral: return Token.foreground
    case .destructive: return Token.destructiveForeground
    case .bare: return Token.primary
    case .off: return Token.mutedForeground
    }
  }

  private var ground: Color {
    switch tone {
    case .filled: return Token.primary
    case .neutral: return Token.foreground.opacity(0.09)
    case .destructive: return Token.destructive
    case .bare: return .clear
    case .off: return Token.foreground.opacity(0.05)
    }
  }

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: Radius.control, style: .continuous)
    content
      .font(tone == .bare ? TextRole.label : TextRole.action)
      .foregroundStyle(ink)
      .padding(.horizontal, tone == .bare && !wide ? Space.step : Space.card)
      .padding(.vertical, Space.near)
      .frame(maxWidth: wide ? .infinity : nil, minHeight: height)
      .background(ground, in: shape)
      // A neutral answer's tint alone is 1.2:1 on its card: the hairline is what stands it off (1.8:1 in the
      // dark, 1.6:1 in the light), as it did before the buttons were shared.
      .overlay(shape.strokeBorder(Token.foreground.opacity(tone == .neutral ? 0.22 : 0)))
      .contentShape(Rectangle())
  }
}

extension View {
  func actionGround(_ tone: ActionGround.Tone, wide: Bool = true, height: CGFloat = Size.button) -> some View {
    modifier(ActionGround(tone: tone, wide: wide, height: height))
  }
}

/// A small word on a tinted ground: Done, Can't do it, Stopped, Holds up 2, Recommended. It keeps its words
/// whole on one line when there is room and wraps to two when there is not (the largest text sizes, a longer
/// language): it never makes its row wider than the screen.
struct Chip: View {
  enum Tone { case ok, stop, hold, quiet, accent }
  let words: String
  let tone: Tone

  private var role: Role {
    switch tone {
    case .ok: return .done
    case .stop: return .stop
    case .hold: return .hold
    case .quiet: return .quiet
    case .accent: return .act
    }
  }

  var body: some View {
    Text(words)
      .font(tone == .accent ? TextRole.captionStrong : TextRole.metaStrong)
      .foregroundStyle(role.inkOnTint)
      .lineLimit(2)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.horizontal, Space.close)
      .padding(.vertical, Space.tight)
      .background(role.tint, in: RoundedRectangle(cornerRadius: Radius.chip, style: .continuous))
      // Beside longer words in a row, the chip keeps its line and the words wrap.
      .layoutPriority(1)
  }
}

/// A line that says where a thing stands by its role: a dot in the role's colour, then the words in it.
struct RoleLine: View {
  let words: String
  let role: Role
  @ScaledMetric(relativeTo: .footnote) private var dot: CGFloat = 6

  var body: some View {
    let lift = dot * 0.42
    HStack(alignment: .firstTextBaseline, spacing: dot) {
      Circle().fill(role.ink).frame(width: dot, height: dot).alignmentGuide(.firstTextBaseline) { $0[.bottom] + lift }.accessibilityHidden(true)
      Text(words).foregroundStyle(role.ink).fontWeight(role == .quiet ? .regular : .medium)
    }
  }
}

/// The mark of a choice: a ring for one of several, a box for any of several. Picked, it fills with the accent and
/// settles; nothing else on the row moves.
struct PickMark: View {
  let multi: Bool
  let selected: Bool
  /// A way out more than a choice ("Other…"): a dashed ring until it holds words.
  var open = false
  @MarkSide private var side
  @Environment(\.accessibilityReduceMotion) private var still

  private var ring: Color { selected ? Token.primary : Token.mutedForeground.opacity(0.75) }
  private var line: StrokeStyle { StrokeStyle(lineWidth: 1.5, dash: open && !selected ? [3, 3] : []) }

  var body: some View {
    ZStack {
      if multi {
        let shape = RoundedRectangle(cornerRadius: side * 0.28, style: .continuous)
        shape.strokeBorder(ring, style: line)
        shape.fill(Token.primary).opacity(selected ? 1 : 0)
        Image(systemName: "checkmark")
          .font(.system(size: side * 0.52, weight: .bold))
          .foregroundStyle(Token.primaryForeground)
          .opacity(selected ? 1 : 0)
          .scaleEffect(selected || still ? 1 : 0.5)
      } else {
        Circle().strokeBorder(ring, style: line)
        Circle().fill(Token.primary).padding(side * 0.25).opacity(selected ? 1 : 0).scaleEffect(selected || still ? 1 : 0.4)
      }
    }
    .frame(width: side, height: side)
    // The pick settles.
    .motion(.settle, value: selected)
    // On the first line of the words beside it, centred on their capitals.
    .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + $0.height * 0.27 }
    .accessibilityHidden(true)
  }
}

/// One choice: a whole row to touch, 44 points at least. Its mark stands in the card's own left edge and its words
/// in one column; picked, the row rests in a well that reaches almost to the card's edge.
struct ChoiceRow: View {
  let label: String
  let detail: String?
  let recommended: Bool
  let multi: Bool
  let selected: Bool
  let enabled: Bool
  /// What VoiceOver reads as the row's value (the words typed under "Other…").
  var value: String?
  /// A way out more than a choice ("Other…"): quieter until it holds words.
  var open = false
  let action: () -> Void

  /// How far a row's ground reaches past its words, into the card's padding.
  static let reach: CGFloat = Space.step
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: Space.step) {
        PickMark(multi: multi, selected: selected, open: open)
        VStack(alignment: .leading, spacing: Space.hair) {
          ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline, spacing: Space.close) {
              labelText
              badge
            }
            VStack(alignment: .leading, spacing: Space.tight) {
              labelText
              badge
            }
          }
          if let detail, !detail.isEmpty {
            Text(detail).font(TextRole.secondary).foregroundStyle(Token.mutedForeground).multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, Self.reach)
      .padding(.vertical, Space.near)
      .frame(minHeight: Space.touch)
      // The well under a picked row: the page's own dark showing through the card in the dark (1.14:1 on the
      // card), and in the light the muted grey, since the page's light ground is nearly the card's white (1.09:1;
      // muted is 1.26:1). The filled mark carries the pick either way; the well says which row it is on.
      .background((scheme == .dark ? Token.background : Token.muted).opacity(selected ? 1 : 0), in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
      .motion(.fade, value: selected)
      .contentShape(Rectangle())
    }
    // A settled card keeps its words at full contrast: only the touch is off.
    .buttonStyle(PressStyle(gives: false))
    .allowsHitTesting(enabled)
    .padding(.horizontal, -Self.reach)
    .accessibilityElement(children: .combine)
    .accessibilityLabel([label, recommended ? PhoneWords.recommended : nil, detail].compactMap { $0 }.joined(separator: ", "))
    .accessibilityValue(value ?? "")
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
  }

  private var labelText: some View {
    Text(label)
      .font(open && !selected ? TextRole.body : TextRole.label)
      .foregroundStyle(open && !selected ? Token.mutedForeground : Token.foreground)
      .multilineTextAlignment(.leading)
  }

  @ViewBuilder private var badge: some View {
    if recommended { Chip(words: PhoneWords.recommended, tone: .accent) }
  }
}

/// A line under a card's words that says what happened to it, in the column of the choices' words: its mark stands
/// where their marks do.
struct CardNotice: View {
  let words: String
  let symbol: String
  let role: Role
  @MarkSide private var side

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.step) {
      Image(systemName: symbol).font(.system(size: side * 0.6, weight: .semibold)).foregroundStyle(role.ink).frame(width: side).accessibilityHidden(true)
      Text(words).font(TextRole.meta).foregroundStyle(role == .quiet ? Token.mutedForeground : role.ink).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}
