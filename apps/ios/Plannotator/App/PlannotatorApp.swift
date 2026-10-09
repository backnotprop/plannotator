import PlannotatorKit
import SwiftUI

@main
struct PlannotatorApp: App {
    @UIApplicationDelegateAdaptor private var delegate: AppDelegate
    private var model: AppModel { delegate.model }
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
        }
        .onChange(of: phase) { _, phase in
            // The event stream runs in the foreground; on return it catches up from the cursor.
            if phase == .active {
                model.session?.start()
                Task {
                    await model.notifier.refresh()
                    await model.syncRelays()
                }
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

enum RootTab: Hashable { case inbox, decisions, settings }

struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        TabView(selection: $tab) {
            Tab("Inbox", systemImage: "tray", value: RootTab.inbox) { InboxTab() }
            Tab("Decisions", systemImage: "diamond", value: RootTab.decisions) { DecisionsTab() }
            Tab("Settings", systemImage: "gearshape", value: RootTab.settings) { SettingsTab() }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        // A notification opened a thread: it shows in the Inbox tab.
        .onChange(of: model.opening) { if model.opening != nil { tab = .inbox } }
        .fullScreenCover(isPresented: $model.pairing) { PairingCover() }
        .alert(offerTitle, isPresented: Binding(get: { model.offered != nil }, set: { if !$0 { model.offered = nil } }), presenting: model.offered) { link in
            Button("Cancel", role: .cancel) {}
            if !link.addresses.isEmpty {
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
            // The addresses the client will dial, in the order it tries them, each
            // alone on a line; the name, which the link chooses, comes after them
            // and is marked as a name.
            if link.addresses.isEmpty {
                Text("This code has no address your phone can reach. On your computer, turn on Reach from my tailnet or Reach from this Wi-Fi, then show the code again.")
            } else {
                Text("\(link.addresses.map(\.hostPort).joined(separator: "\n"))\nNamed “\(link.name)”\n\nThis phone will read and answer the Inbox at \(link.addresses.count == 1 ? "that address" : "those addresses"). Pair only with a computer you know.")
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
    @State private var tab = RootTab.inbox

    /// The title names no one: the address the phone will contact is the message's first line.
    private var offerTitle: String { "Pair with this computer?" }
}
