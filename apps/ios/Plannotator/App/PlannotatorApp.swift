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
                    // A pairing QR read by the Camera app (or any other app) opens
                    // here. It pairs only after the person confirms, with the
                    // address it will contact in front of them.
                    guard case .success(let link) = PairLink.parse(url.absoluteString) else { return }
                    model.offered = link
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
        .alert(offerTitle, isPresented: Binding(get: { model.offered != nil }, set: { if !$0 { model.offered = nil } }), presenting: model.offered) { link in
            Button("Cancel", role: .cancel) {}
            if link.tailnet != nil {
                Button("Pair") {
                    Task {
                        do throws(InboxError) {
                            try await model.pair(link: link)
                            Haptics.success()
                        } catch {
                            Haptics.error()
                            pairProblem = error.message
                        }
                    }
                }
            }
        } message: { link in
            Text(link.tailnet == nil
                ? "This code has no address your phone can reach. On your computer, turn on Reach from my tailnet, then show the code again."
                : "This phone will read and answer the Inbox at that address. Pair only with a computer you know.")
        }
        .alert("Not paired", isPresented: Binding(get: { pairProblem != nil }, set: { if !$0 { pairProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(pairProblem ?? "")
        }
    }

    @State private var pairProblem: String?

    /// "Pair with MacBook Pro at macbook-pro.tail0000.ts.net:8443?": the address is the one contacted.
    private var offerTitle: String {
        guard let link = model.offered else { return "" }
        guard let address = link.tailnet else { return "Pair with \(link.name)?" }
        return "Pair with \(link.name) at \(address.hostPort)?"
    }
}
