import PlannotatorKit
import SwiftUI

@main
struct PlannotatorApp: App {
    @State private var model = AppModel()
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @Environment(\.scenePhase) private var phase
    @AppStorage("appearance") private var appearance = Appearance.system

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .tint(.tint)
                .preferredColorScheme(appearance.scheme)
                .onOpenURL { url in
                    // A Workspaces sign-in return finishes only the sign-in in
                    // progress with the same state; any other is dropped.
                    if model.receiveSignInReturn(url) { return }
                    // A pairing QR read by the Camera app (or any other app) opens
                    // here. It pairs only after the person confirms, with the
                    // address it will contact in front of them.
                    guard case .success(let link) = PairLink.parse(url.absoluteString) else { return }
                    model.offered = link
                }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { _ = model.receiveSignInReturn(url) }
                }
                .onReceive(NotificationCenter.default.publisher(for: .pushToken)) { model.pushToken = $0.object as? Data }
        }
        .onChange(of: phase) { _, phase in
            // The event stream runs in the foreground; on return it catches up from the cursor.
            if phase == .active {
                model.session?.start()
                Task { await model.registerForPushIfAllowed() }
            } else if phase == .background {
                model.session?.stop()
            }
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
            // The address the client will dial, alone on the first line; the
            // name, which the link chooses, comes after it and is marked as a name.
            if let address = link.tailnet {
                Text("\(address.hostPort)\nNamed “\(link.name)”\n\nThis phone will read and answer the Inbox at that address. Pair only with a computer you know.")
            } else {
                Text("This code has no address your phone can reach. On your computer, turn on Reach from my tailnet, then show the code again.")
            }
        }
        .alert("Not paired", isPresented: Binding(get: { pairProblem != nil }, set: { if !$0 { pairProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(pairProblem ?? "")
        }
        .alert("Not signed in", isPresented: Binding(get: { model.signInProblem != nil }, set: { if !$0 { model.signInProblem = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(model.signInProblem ?? "")
        }
    }

    @State private var pairProblem: String?

    /// The title names no one: the address the phone will contact is the message's first line.
    private var offerTitle: String { "Pair with this computer?" }
}
