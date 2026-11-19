import SwiftUI

// The app's look, in one place: every screen takes its spacing, type, surfaces and controls from here, so a new
// screen inherits the product's rhythm instead of choosing numbers of its own. The colours are the contract's
// (`Token`, Theme.swift); this file is what the app does with them.
//
// The rules the pieces hold to:
//   - One thing is emphasised at a time. A card's prompt is its only heavy line; everything else steps down.
//   - Colour is a role, never decoration: the accent is what the person can do or has done, amber is work held up,
//     red is an agent stopped, green is a thing finished.
//   - Hairlines part things; a ground (a well) is kept for what the person chose.
//   - Every length is a step of `Space`; every corner is one of `Radius`, and a shape inside another keeps the same
//     centre (its radius is the outer one less the gap between them).

/// The spacing scale, in points. Nothing in the app is spaced by a number that is not one of these.
enum Space {
  /// Between two lines that are one thought (a label and its detail).
  static let hair: CGFloat = 2
  static let tight: CGFloat = 4
  /// Between parts of one group.
  static let close: CGFloat = 8
  /// Between groups inside a card; a mark and its words.
  static let step: CGFloat = 12
  /// A card's own padding; the list's page edge.
  static let card: CGFloat = 16
  /// The thread's page edge.
  static let page: CGFloat = 20
  /// Between sections of a page.
  static let section: CGFloat = 24
  /// The least a thing to touch measures, either way.
  static let touch: CGFloat = 44
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
  static func code(_ style: Font.TextStyle = .callout) -> Font { .system(style, design: .monospaced) }
}

/// What a colour says. Views name the role; the role names the token.
enum Role {
  /// The person's own doing: a pick, Send, a thing to touch.
  case act
  /// Work held up until the person answers.
  case hold
  /// An agent stopped.
  case stop
  /// A thing finished.
  case done
  case quiet

  var ink: Color {
    switch self {
    case .act: return Token.primary
    case .hold: return Token.warning
    case .stop: return Token.destructive
    case .done: return Token.success
    case .quiet: return Token.mutedForeground
    }
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
      .overlay(shape.strokeBorder(drafted ? Token.primary.opacity(0.55) : Token.border.opacity(0.6), lineWidth: drafted ? 1 : 0.5))
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
      .animation(.easeOut(duration: configuration.isPressed ? 0.08 : 0.18), value: configuration.isPressed)
  }
}

/// A button's ground and words. Filled is the one thing to do; neutral is another answer of the same rank; bare is
/// words alone in the accent; off is a filled button that cannot be used yet.
struct ActionGround: ViewModifier {
  enum Tone { case filled, neutral, bare, off }
  let tone: Tone
  /// The whole width, or as wide as its words.
  var wide = true
  var height: CGFloat = 48

  private var ink: Color {
    switch tone {
    case .filled: return Token.primaryForeground
    case .neutral: return Token.foreground
    case .bare: return Token.primary
    case .off: return Token.mutedForeground
    }
  }

  private var ground: Color {
    switch tone {
    case .filled: return Token.primary
    case .neutral: return Token.foreground.opacity(0.09)
    case .bare: return .clear
    case .off: return Token.foreground.opacity(0.05)
    }
  }

  func body(content: Content) -> some View {
    content
      .font(tone == .bare ? Font.body.weight(.medium) : TextRole.action)
      .foregroundStyle(ink)
      .padding(.horizontal, tone == .bare && !wide ? Space.step : Space.card)
      .padding(.vertical, 10)
      .frame(maxWidth: wide ? .infinity : nil, minHeight: height)
      .background(ground, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
      .contentShape(Rectangle())
  }
}

extension View {
  func actionGround(_ tone: ActionGround.Tone, wide: Bool = true, height: CGFloat = 48) -> some View {
    modifier(ActionGround(tone: tone, wide: wide, height: height))
  }
}

/// A small word on a tinted ground: Done, Can't do it, Stopped, Holds up 2, Recommended.
struct Chip: View {
  enum Tone { case ok, stop, hold, quiet, accent }
  let words: String
  let tone: Tone

  private var ink: Color {
    switch tone {
    case .ok: return Role.done.ink
    case .stop: return Role.stop.ink
    case .hold: return Role.hold.ink
    case .quiet: return Role.quiet.ink
    case .accent: return Role.act.ink
    }
  }

  var body: some View {
    Text(words)
      .font(tone == .accent ? Font.caption.weight(.semibold) : TextRole.metaStrong)
      .foregroundStyle(ink)
      .padding(.horizontal, Space.close)
      .padding(.vertical, 3)
      .background(tone == .quiet ? Token.muted : ink.opacity(0.14), in: Capsule())
      .fixedSize()
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
      Text(words).foregroundStyle(role.ink).fontWeight(.medium)
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
  @ScaledMetric(relativeTo: .body) private var scaled: CGFloat = 22
  @Environment(\.accessibilityReduceMotion) private var still

  /// The mark's side: it grows with the text, to a limit, so the words keep the row's width at the largest sizes.
  private var side: CGFloat { min(scaled, 32) }
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
    // The pick settles: a short spring with a little give, since a finger set it down. With motion reduced it fades.
    .animation(still ? .easeOut(duration: 0.15) : .spring(response: 0.26, dampingFraction: 0.74), value: selected)
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
  /// From a row's mark to its words, for a mark of the size `PickMark` draws at this text size: lines that belong
  /// to a row (a field under it) start here.
  static func column(_ mark: CGFloat) -> CGFloat { min(mark, 32) + Space.step }
  @Environment(\.accessibilityReduceMotion) private var still

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
      .padding(.vertical, 11)
      .frame(minHeight: Space.touch)
      // The well is the page's own ground showing through the card: dark in the dark, grey in the light.
      .background(Token.background.opacity(selected ? 1 : 0), in: RoundedRectangle(cornerRadius: Radius.well, style: .continuous))
      .animation(.easeOut(duration: still ? 0.15 : 0.2), value: selected)
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
  @ScaledMetric(relativeTo: .body) private var mark: CGFloat = 22

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Space.step) {
      Image(systemName: symbol).font(.system(size: min(mark, 32) * 0.6, weight: .semibold)).foregroundStyle(role.ink).frame(width: min(mark, 32)).accessibilityHidden(true)
      Text(words).font(TextRole.meta).foregroundStyle(role == .quiet ? Token.mutedForeground : role.ink).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}
