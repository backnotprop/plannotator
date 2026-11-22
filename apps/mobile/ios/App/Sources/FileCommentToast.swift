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
  @ObservationIgnored private var telling: (@MainActor () -> String)?
  @ObservationIgnored private var timer: Task<Void, Never>?

  /// Show `words`; Undo runs `undo`, and a screen reader is then told `said()`, read once it has.
  func show(_ words: ToastWords, said: @escaping @MainActor () -> String, undo: @escaping @MainActor () -> Void) {
    timer?.cancel()
    let next = RowActions.Toast(words: words, undo: .local(said: ""))
    toast = next
    undoing = undo
    telling = said
    AccessibilityNotification.Announcement(words.spoken).post()
    let wait = UIAccessibility.isVoiceOverRunning ? max(RowActions.stays, RowActions.readStays) : RowActions.stays
    timer = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(Int(wait * 1000)))
      guard !Task.isCancelled, let self, self.toast?.id == next.id else { return }
      self.dismiss()
    }
  }

  func undo() {
    guard let undoing, let telling, case .local? = toast?.undo else { return }
    dismiss()
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    undoing()
    AccessibilityNotification.Announcement(telling()).post()
  }

  func dismiss() {
    timer?.cancel()
    toast = nil
    undoing = nil
    telling = nil
  }

  /// What a screen reader is told once a comment is back: how many comments wait now, as the list's title says it.
  static func told(_ session: InboxSession, _ thread: ThreadID) -> String { CountWords.comments(session.comments(thread).count) }

  /// "Removed", with Undo bringing the comment back as it was.
  func removed(_ id: String, thread: ThreadID, session: InboxSession) {
    guard let removed = session.removeComment(id, thread: thread) else { return }
    show(ToastWords(mark: .check, lead: PhoneWords.stateRemoved), said: { Self.told(session, thread) }) {
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
