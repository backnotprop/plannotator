import PlannotatorKit
import SwiftUI

@main
struct PlannotatorApp: App {
    @State private var model = AppModel()
    @Environment(\.scenePhase) private var phase
    @AppStorage("appearance") private var appearance = Appearance.system

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.tint)
                .preferredColorScheme(appearance.scheme)
                .onOpenURL { url in
                    // A pairing QR read by the Camera app opens here.
                    guard case .success(let link) = PairLink.parse(url.absoluteString) else { return }
                    Task { try? await model.pair(link: link) }
                }
        }
        .onChange(of: phase) { _, phase in
            // The event stream runs in the foreground; on return it catches up from the cursor.
            if phase == .active { model.session?.start() } else if phase == .background { model.session?.stop() }
        }
    }
}

enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView {
            Tab("Inbox", systemImage: "tray") { InboxTab() }
            Tab("Settings", systemImage: "gearshape") { SettingsTab() }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .fullScreenCover(isPresented: $model.pairing) { PairingCover() }
    }
}
