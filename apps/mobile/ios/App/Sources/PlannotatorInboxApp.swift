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
          // Back to the front: read again.
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

  var body: some View {
    Group {
      if !model.booted {
        Token.background.ignoresSafeArea()
      } else if let session = model.session {
        InboxScreen(session: session)
          .id(session.computer.id)
      } else {
        PairingScreen()
      }
    }
    .background(Token.background.ignoresSafeArea())
    .animation(.default, value: model.session?.computer.id)
    // A link offered is measured off screen first, at the sheet's width, so the sheet opens at its own height.
    .background(alignment: .top) {
      if let link = model.offered, offered?.id != link.id {
        OfferedPairingContent(link: link)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: .infinity)
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
      OfferedPairingSheet(link: link, initial: offeredHeight).environment(model)
    }
  }
}
