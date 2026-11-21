import SwiftUI

// The pieces the next screens are built from: rows that can be touched, swiped and selected; surfaces that rise
// over the page; media; counts; and the three states every screen has besides its content. They hold to the rules
// at the top of Look.swift. Each is small on purpose: a screen that needs more grows the piece here, never a
// copy of it beside the screen.

// MARK: Rows

/// A row of a list as a thing to touch: it dims its ground on the way down, and a selected row keeps a ground.
/// The ground reaches `inset` past the row's content, so words stay on the page's edge while the ground does not
/// touch the screen's.
struct RowStyle: ButtonStyle {
  var selected = false
  var inset: CGFloat = Space.close

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .padding(.horizontal, inset)
      .background(ground(configuration.isPressed), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
      .padding(.horizontal, -inset)
      .motion(.press, value: configuration.isPressed)
      .motion(.fade, value: selected)
  }

  private func ground(_ pressed: Bool) -> Color {
    if pressed { return Token.foreground.opacity(0.08) }
    return selected ? Token.muted : .clear
  }
}

/// What a swipe or a menu item does, by role: its colour is the role's, never a colour of its own. Mark read and
/// Mark unread are quiet; Archive and Unarchive are the accent, as the window's Archive swipe is (the person's own
/// doing, and it can be undone); a thing destroyed is red.
enum RowAction {
  case quiet, act, destructive

  /// A swipe action's tint (`.tint(RowAction.destructive.tint)`).
  var tint: Color {
    switch self {
    case .quiet: return Token.mutedForeground
    case .act: return Role.act.ink
    case .destructive: return Role.destructive.ink
    }
  }

  /// A menu item's or a confirmation's button role: only a destroyed thing has one, and the system draws it red.
  var buttonRole: ButtonRole? { self == .destructive ? .destructive : nil }
}

private struct SelectionRing: ViewModifier {
  let on: Bool
  let radius: CGFloat

  func body(content: Content) -> some View {
    content
      .overlay(RoundedRectangle(cornerRadius: radius + Space.hair, style: .continuous).strokeBorder(Token.ring, lineWidth: 2).padding(-Space.hair).opacity(on ? 1 : 0))
      .motion(.fade, value: on)
  }
}

// MARK: Raised surfaces

/// Where a thing sits over the page. Glass is for what floats over content that moves under it (a tool bar over a
/// file or a picture): there it shows what is behind. A sheet and a popover stand on a still ground, where glass
/// would only blur a flat colour, so they are solid. The thread's foot is the one exception today: its glass sits
/// on the page's own solid ground (the words fade out above it, so no line is cut by it), which shows little of
/// the glass; it is kept as the system's look for a reply field, and is the owner's to change.
enum Surface {
  /// A sheet's ground: the card colour, so a sheet reads as a larger card.
  static let sheet = Token.card
  /// A popover's or a menu's ground.
  static let popover = Token.popover
  /// What dims the page under a sheet that asks for the person's whole attention.
  static let scrim = Color.black.opacity(0.4)
  /// The one shadow, for things that float over content (a tool bar, a popover): soft, low, never a halo.
  static let shadow = (color: Color.black.opacity(0.22), radius: CGFloat(16), y: CGFloat(6))
}

private struct FloatingBar: ViewModifier {
  func body(content: Content) -> some View {
    content
      .padding(.horizontal, Space.close)
      .frame(minHeight: Space.touch)
      .glassEffect(.regular, in: .rect(cornerRadius: Radius.foot))
      .shadow(color: Surface.shadow.color, radius: Surface.shadow.radius, y: Surface.shadow.y)
  }
}

private struct PopoverSurface: ViewModifier {
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: Radius.well, style: .continuous)
    content
      .background(Surface.popover, in: shape)
      .overlay(shape.strokeBorder(Token.border.opacity(0.6), lineWidth: 0.5))
      .shadow(color: Surface.shadow.color, radius: Surface.shadow.radius, y: Surface.shadow.y)
  }
}

// MARK: Media

/// Thumbnails and the viewer. A picture or a file page is shown on a dark ground in both appearances, so its own
/// colours are not judged against the page's.
enum Media {
  /// A thumbnail in a message, and in a row.
  static let thumb: CGFloat = 88
  static let rowThumb: CGFloat = 56
}

private struct MediaGround: ViewModifier {
  func body(content: Content) -> some View {
    // The page's own dark ground, whatever the phone's appearance: the token, read as dark.
    content.background(Token.background.ignoresSafeArea()).environment(\.colorScheme, .dark)
  }
}

private struct Thumbnail: ViewModifier {
  let side: CGFloat

  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: Radius.thumb, style: .continuous)
    content
      .frame(width: side, height: side)
      .background(Token.muted)
      .clipShape(shape)
      .overlay(shape.strokeBorder(Token.border.opacity(0.6), lineWidth: 0.5))
  }
}

extension View {
  /// A ring round what is selected (an annotation, a picked thumbnail), in the token kept for it.
  func selectionRing(_ on: Bool, radius: CGFloat = Radius.control) -> some View { modifier(SelectionRing(on: on, radius: radius)) }
  /// A tool bar that floats over a file or a picture: glass, since the content moves under it.
  func floatingBar() -> some View { modifier(FloatingBar()) }
  /// A popover's or a menu's own surface: solid, one hairline, the one shadow.
  func popoverSurface() -> some View { modifier(PopoverSurface()) }
  /// The viewer's ground: dark in both appearances. Its chrome is `floatingBar()` over it.
  func mediaGround() -> some View { modifier(MediaGround()) }
  /// A thumbnail: square, clipped, one hairline.
  func thumbnail(_ side: CGFloat = Media.thumb) -> some View { modifier(Thumbnail(side: side)) }
}

// MARK: Counts

/// One count: its mark and its number. With a role it is a tinted pill in the role's colour (amber held up, red
/// stopped); without one it is quiet: a neutral pill when `boxed`, plain words when not.
struct CountBadge: View {
  let symbol: String
  /// The number as shown ("99+" past 99).
  let count: String
  let role: Role?
  var boxed = true

  private var plain: Bool { role == nil && !boxed }

  var body: some View {
    HStack(spacing: Space.tight) {
      Image(systemName: symbol).font(Font.caption2.weight(.semibold))
      Text(count).font(plain ? TextRole.meta : TextRole.metaStrong).monospacedDigit()
    }
    .foregroundStyle(role?.inkOnTint ?? (boxed ? Token.foreground : Token.mutedForeground))
    .padding(.horizontal, plain ? Space.hair : Space.close)
    // As tall as its words at any text size: the mark never spills out of its pill.
    .padding(.vertical, Space.hair)
    .frame(minHeight: Size.mark)
    .background(role?.tint ?? (boxed ? Token.muted : Color.clear), in: Capsule())
    .accessibilityHidden(true)
  }
}

// MARK: Buttons and states

/// The one thing to do on a screen: the whole width, 50 points tall, filled.
struct WideButton: View {
  let words: String
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Text(words).actionGround(.filled, height: Size.wideButton)
    }
    .buttonStyle(PressStyle())
  }
}

/// Loading: the system's own spinner, alone in the room the content will take. No words: a wait that needs
/// words is a `Standing`.
struct Waiting: View {
  var body: some View {
    ProgressView().controlSize(.large).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// A thing that went wrong, said in a line where it happened: what is wrong, in red, with its mark. What to do
/// about it is the control beside it, or the words themselves.
struct Trouble: View {
  let words: String

  var body: some View {
    Label(words, systemImage: "exclamationmark.circle").font(TextRole.meta).foregroundStyle(Role.stop.ink)
  }
}

/// A whole-screen state with its words, and at most one thing to do about it: nothing here yet (empty), the
/// computer not reached, a thing gone. The words say what is so and the button what to do.
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
          VStack(spacing: Space.trim) { ForEach(details, id: \.self) { Text($0) } }
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      // The one thing to do: the whole width, never a small capsule.
      if let action, let run { WideButton(words: action, action: run).padding(.horizontal, Space.section).padding(.top, Space.tight) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}
