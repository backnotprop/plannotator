import InboxCore
import InboxWire
import SwiftUI

/// The one toast inside a file cover and its list of comments, with Undo: after a comment is removed, and after a
/// drawing is added to the reply. The cover sits over the thread, so the thread's own toast would be hidden.
@MainActor
@Observable
final class CommentToast {
  private(set) var toast: RowActions.Toast?
  @ObservationIgnored private var undoing: (@MainActor () -> Void)?
  @ObservationIgnored private var timer: Task<Void, Never>?

  /// Show `words`; Undo runs `undo`, and a screen reader is told `said` once it has.
  func show(_ words: ToastWords, said: String, undo: @escaping @MainActor () -> Void) {
    timer?.cancel()
    let next = RowActions.Toast(words: words, undo: .local(said: said))
    toast = next
    undoing = undo
    AccessibilityNotification.Announcement(words.spoken).post()
    let wait = UIAccessibility.isVoiceOverRunning ? max(RowActions.stays, RowActions.readStays) : RowActions.stays
    timer = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
      guard !Task.isCancelled, let self, self.toast?.id == next.id else { return }
      self.dismiss()
    }
  }

  func undo() {
    guard let undoing, case .local(let said)? = toast?.undo else { return }
    dismiss()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    undoing()
    AccessibilityNotification.Announcement(said).post()
  }

  func dismiss() {
    timer?.cancel()
    toast = nil
    undoing = nil
  }

  /// "Removed", with Undo bringing the comment back as it was.
  func removed(_ id: String, thread: ThreadID, session: InboxSession) {
    guard let removed = session.removeComment(id, thread: thread) else { return }
    show(ToastWords(mark: .check, lead: PhoneWords.stateRemoved), said: ActionWords.movedBack) {
      session.restoreComment(removed)
    }
  }
}

private struct CommentToastHost: ViewModifier {
  let toasts: CommentToast
  let lift: CGFloat
  @Environment(\.accessibilityReduceMotion) private var still

  func body(content: Content) -> some View {
    content
      .overlay(alignment: .bottom) {
        if let toast = toasts.toast {
          ToastBanner(toast: toast) { toasts.undo() } close: { toasts.dismiss() }
            .padding(.horizontal, Space.step)
            .padding(.bottom, Space.close + lift)
            .id(toast.id)
            .transition(still ? .opacity : .move(edge: .bottom).combined(with: .opacity))
        }
      }
      .animation(Motion.settle.animation(still: still), value: toasts.toast?.id)
  }
}

extension View {
  /// The cover's toast at the foot, `lift` points over the safe area.
  func commentToast(_ toasts: CommentToast, lift: CGFloat = 0) -> some View { modifier(CommentToastHost(toasts: toasts, lift: lift)) }
}
