import InboxCore
import SwiftUI

/// The one toast after a row action (FLOWS 3; the window's Toast.tsx on a phone): its mark, the news, the rest
/// quieter, then Undo and a way to close it. It floats over the list, so it has the popover's solid surface and the
/// one shadow. A swipe across it sends it away.
struct ToastBanner: View {
  let toast: RowActions.Toast
  let undo: () -> Void
  let close: () -> Void

  @State private var drag: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var still
  @Environment(\.dynamicTypeSize) private var typeSize

  private var words: ToastWords { toast.words }

  private var symbol: String {
    switch words.mark {
    case .check: return "checkmark.circle"
    case .archive: return "archivebox"
    case .clock: return "clock"
    case .unread: return "envelope.badge"
    case .unstar: return "star.slash"
    case .warn: return "exclamationmark.triangle"
    }
  }

  private var line: Text {
    let lead = Text(words.shownLead).fontWeight(.semibold).foregroundStyle(Token.foreground)
    guard let detail = words.shownDetail, !detail.isEmpty else { return lead }
    return run(lead, Text(" · \(detail)").foregroundStyle(Token.mutedForeground))
  }

  var body: some View {
    Group {
      if typeSize.isAccessibilitySize {
        // The largest text sizes: the words take the whole width, and what can be touched stands under them.
        boxed(
          VStack(alignment: .leading, spacing: Space.tight) {
            HStack(alignment: .firstTextBaseline, spacing: Space.close) {
              mark
              said(lines: 4)
            }
            .padding(.trailing, Space.step)
            HStack(spacing: Space.close) {
              Spacer(minLength: 0)
              undoButton
              closeButton
            }
          }
          .padding(.top, Space.step),
          box: true)
      } else if words.wraps {
        // An error, or a bulk action some rows refused: the words are never cut. While they fit they are one line,
        // a capsule as any toast; else they wrap, and the mark, Undo and × stay centred against them.
        ViewThatFits(in: .horizontal) {
          boxed(row(said(lines: 1)), box: false)
          boxed(row(said(lines: 4)).padding(.vertical, Space.close), box: true)
        }
      } else {
        boxed(row(said(lines: 1)), box: false)
      }
    }
    .shadow(color: Surface.shadow.color, radius: Surface.shadow.radius, y: Surface.shadow.y)
    .offset(x: drag)
    .opacity(1 - min(abs(drag) / 240, 0.6))
    // A swipe across it sends it away (the window's toast does the same); a short one springs back.
    .gesture(
      DragGesture(minimumDistance: 12)
        .onChanged { drag = $0.translation.width }
        .onEnded { end in
          if abs(end.translation.width) > 80 || abs(end.predictedEndTranslation.width) > 240 { close() } else { withAnimation(Motion.settle.animation(still: still)) { drag = 0 } }
        }
    )
    .accessibilityElement(children: .contain)
    .accessibilityAction(.escape, close)
    .accessibilityActions {
      if toast.undo != nil { Button(PhoneWords.undo, action: undo) }
    }
    // It floats over the page as a bar does: it grows with the text as far as a bar, never past the screen.
    .dynamicTypeSize(...Size.barText)
  }

  private var mark: some View {
    Image(systemName: symbol)
      .font(TextRole.secondary.weight(.medium))
      .foregroundStyle(words.mark == .warn ? Role.hold.ink : Token.mutedForeground)
      .accessibilityHidden(true)
  }

  /// The mark, the words, Undo and ×, on one centre line.
  private func row(_ said: some View) -> some View {
    HStack(alignment: .center, spacing: Space.close) {
      mark
      said
      undoButton
      closeButton
    }
  }

  /// One line is a capsule; wrapped words keep a rounded box.
  private func boxed(_ content: some View, box: Bool) -> some View {
    let shape = RoundedRectangle(cornerRadius: box ? Radius.card : Size.wideButton / 2, style: .continuous)
    return content
      .padding(.leading, Space.card)
      .padding(.trailing, Space.tight)
      .frame(minHeight: Size.wideButton)
      .background(Surface.popover, in: shape)
      .overlay(shape.strokeBorder(Token.border.opacity(0.6), lineWidth: 0.5))
  }

  private func said(lines: Int) -> some View {
    line
      .font(TextRole.secondary)
      .lineLimit(lines)
      .truncationMode(.tail)
      .multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityLabel(words.spoken)
  }

  @ViewBuilder private var undoButton: some View {
    if toast.undo != nil {
      Button(action: undo) {
        Text(PhoneWords.undo)
          .font(TextRole.metaStrong)
          .foregroundStyle(Token.primaryForeground)
          .lineLimit(1)
          .fixedSize()
          .padding(.horizontal, Space.snug)
          .frame(minHeight: Size.capsule)
          .background(Token.primary, in: Capsule())
          .touchTarget()
      }
      .buttonStyle(PressStyle())
    }
  }

  private var closeButton: some View {
    Button(action: close) {
      Image(systemName: "xmark").font(TextRole.glyph).foregroundStyle(Token.mutedForeground).touchTarget()
    }
    .buttonStyle(PressStyle())
    .accessibilityLabel(PhoneWords.dismiss)
  }
}

private struct ToastHost: ViewModifier {
  let actions: RowActions
  /// Room under the toast for what stands at the screen's foot (the reply field, the picks' bar).
  let lift: CGFloat
  @Environment(\.accessibilityReduceMotion) private var still

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .bottom) {
        if let toast = actions.toast {
          ToastBanner(toast: toast) {
            Task { await actions.undo() }
          } close: {
            actions.dismissToast()
          }
          .padding(.horizontal, Space.step)
          .padding(.bottom, Space.close + lift)
          .id(toast.id)
          .transition(still ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
      }
      .animation(Motion.settle.animation(still: still), value: actions.toast?.id)
  }
}

extension View {
  /// The screen shows the session's one toast at its foot, `lift` points up from the safe area.
  func toastHost(_ actions: RowActions, lift: CGFloat = 0) -> some View { modifier(ToastHost(actions: actions, lift: lift)) }
}
