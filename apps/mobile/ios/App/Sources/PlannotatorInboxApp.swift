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
        // The link the computer shows also opens the app from the Camera app.
        .onOpenURL { url in Task { await model.open(link: url.absoluteString) } }
        .onChange(of: phase) { _, now in
          // Back to the front: read again.
          if now == .active, model.booted, let session = model.session { Task { await session.refresh() } }
        }
    }
  }
}

struct RootView: View {
  @Environment(AppModel.self) private var model

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
  }
}
