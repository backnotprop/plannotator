import InboxCore
import SwiftUI

@main
struct PlannotatorInboxApp: App {
  @State private var model = AppModel()
  @Environment(\.scenePhase) private var phase

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .tint(Token.primary)
        .task { await model.boot() }
        // A pairing link from outside the app is shown, never redeemed, until the person says Pair.
        .onOpenURL { url in model.offer(link: url.absoluteString) }
        .onChange(of: phase) { _, now in
          // Back to the front: read again. Out of it, nothing looks for a better way to the computer.
          model.session?.setInFront(now == .active)
          if now == .active, model.booted, let session = model.session { Task { await session.refresh() } }
        }
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model
  /// The pairing link the sheet shows, once its words are measured, and their height.
  @State private var offered: PairLink?
  @State private var offeredHeight: CGFloat = 0
  /// The width the pairing sheet was last shown at, as the sheet tells it, so its words are measured at the width
  /// they are shown at; the screen's width before it was ever shown (an iPhone sheet's content is as wide).
  @State private var rootWidth: CGFloat = 0
  @State private var sheetWidth: CGFloat?
  private var measureWidth: CGFloat { sheetWidth ?? rootWidth }

  var body: some View {
    Group {
      if !model.booted {
        Token.background.ignoresSafeArea()
      } else if let session = model.session {
        // A new session is a new screen, with its own row actions: the same computer paired again too.
        InboxScreen(session: session)
          .id(ObjectIdentifier(session))
      } else {
        PairingScreen()
      }
    }
    .background(Token.background.ignoresSafeArea())
    #if DEBUG
      // The UI tests' look into the accessibility tree (AccessibilityProbe.swift); never in a release build.
      .overlay(alignment: .bottomLeading) {
        if let target = UserDefaults.standard.string(forKey: "a11yProbe") { AccessibilityProbe(target: target) }
      }
    #endif
    .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { rootWidth = $0 }
    .animation(.default, value: model.session?.computer.id)
    // A link offered is measured off screen first, at the sheet's width, so the sheet opens at its own height.
    .background(alignment: .top) {
      if let link = model.offered, offered?.id != link.id, measureWidth > 0 {
        OfferedPairingContent(link: link)
          .fixedSize(horizontal: false, vertical: true)
          .frame(width: measureWidth)
          .hidden()
          .accessibilityHidden(true)
          .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
            offeredHeight = height
            offered = link
          }
      }
    }
    .onChange(of: model.offered?.id) { _, now in if now == nil { offered = nil } }
    .sheet(item: Binding(get: { offered }, set: { if $0 == nil { model.offered = nil; offered = nil } })) { link in
      OfferedPairingSheet(link: link, initial: offeredHeight) { sheetWidth = $0 }.environment(model)
    }
  }
}
