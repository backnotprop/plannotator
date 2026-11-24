#if DEBUG
  import SwiftUI
  import UIKit

  /// For the UI tests only (debug builds, `-a11yProbe <words>`): a touch reads the accessibility tree VoiceOver
  /// reads and says, as its own label, the custom actions of the element whose label holds `<words>`. XCUITest has
  /// no way to list an element's custom actions; this is how a test confirms the row's element carries them.
  struct AccessibilityProbe: View {
    let target: String
    @State private var found = "a11y-probe"

    var body: some View {
      Button {
        found = Self.actions(of: target).map { "a11y-probe: " + $0.joined(separator: " | ") } ?? "a11y-probe: no element"
      } label: {
        Color.clear.frame(width: 44, height: 44).contentShape(Rectangle())
      }
      .accessibilityLabel(found)
      .accessibilityIdentifier("a11y-probe")
    }

    /// The custom actions of the first accessibility element (as VoiceOver walks them) whose label holds `words`.
    @MainActor
    static func actions(of words: String) -> [String]? {
      let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
      var seen = Set<ObjectIdentifier>()
      func walk(_ node: NSObject, depth: Int) -> [String]? {
        guard depth < 60, seen.insert(ObjectIdentifier(node)).inserted else { return nil }
        if node.isAccessibilityElement, (node.accessibilityLabel ?? "").contains(words) {
          return (node.accessibilityCustomActions ?? []).map(\.name)
        }
        for child in (node.accessibilityElements ?? []).compactMap({ $0 as? NSObject }) {
          if let found = walk(child, depth: depth + 1) { return found }
        }
        if let view = node as? UIView {
          for child in view.subviews { if let found = walk(child, depth: depth + 1) { return found } }
        }
        return nil
      }
      for window in windows { if let found = walk(window, depth: 0) { return found } }
      return nil
    }
  }
#endif
