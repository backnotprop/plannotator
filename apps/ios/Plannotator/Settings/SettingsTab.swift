import PlannotatorKit
import SwiftUI

/// 9.1: sources with their status, notifications and the lock-screen answer,
/// and this phone's appearance and haptics.
struct SettingsTab: View {
    @Environment(AppModel.self) private var model
    @AppStorage("appearance") private var appearance = Appearance.system
    @AppStorage("haptics") private var haptics = true
    @State private var choosing = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(model.sources) { source in
                        NavigationLink(value: source) {
                            HStack(spacing: 13) {
                                ComputerTile()
                                VStack(alignment: .leading, spacing: 1) {
                                    Text(source.name).foregroundStyle(Color.ink)
                                    Text(pathLine(source)).font(.footnote).foregroundStyle(Color.inkSecondary)
                                }
                                Spacer(minLength: 8)
                                if let color = statusColor(source.id) {
                                    Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
                                }
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityValue(statusWords(source.id))
                        }
                        .accessibilityIdentifier("source-\(source.id)")
                    }
                    if let account = model.workspaces {
                        NavigationLink(value: account) {
                            HStack(spacing: 13) {
                                Image("WorkspacesIcon").resizable().scaledToFit().frame(width: 30, height: 30).accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 1) {
                                    Text("Workspaces").foregroundStyle(Color.ink)
                                    Text([account.name, account.teamLine].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(Color.inkSecondary)
                                }
                                Spacer(minLength: 8)
                                if let color = statusColor(WorkspacesAccount.sourceId) {
                                    Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
                                }
                            }
                            .accessibilityElement(children: .combine)
                            .accessibilityValue(statusWords(WorkspacesAccount.sourceId))
                        }
                        .accessibilityIdentifier("source-workspaces")
                    }
                    Button {
                        if model.hasWorkspaces, model.workspaces == nil { choosing = true } else { model.pairing = true }
                    } label: {
                        Label("Add a source", systemImage: "plus")
                    }
                    .accessibilityIdentifier("add-source")
                    .confirmationDialog("Add a source", isPresented: $choosing) {
                        Button("Your computer's Inbox") { model.pairing = true }
                        Button("Workspaces") { Task { await model.signInToWorkspaces() } }
                    }
                } header: {
                    header("Sources")
                }
                NotificationsSection()
                Section {
                    Picker("Appearance", selection: $appearance) {
                        ForEach(Appearance.allCases) { Text($0.label).tag($0) }
                    }
                    .pickerStyle(.navigationLink)
                    Toggle("Haptics", isOn: $haptics)
                    LabeledContent("Version", value: Self.version)
                } header: {
                    header("This phone")
                }
            }
            .listStyle(.insetGrouped)
            .scrollContentBackground(.hidden)
            .background(Color.ground)
            .navigationTitle("Settings")
            .navigationDestination(for: Source.self) { SourceScreen(source: $0) }
            .navigationDestination(for: WorkspacesAccount.self) { WorkspacesScreen(account: $0) }
        }
    }

    private func header(_ text: String) -> some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
    }

    private func pathLine(_ source: Source) -> String {
        if model.activeId == source.id, let session = model.session, session.status == .connected, let path = session.path {
            switch path {
            case .wifi: return "Inbox · over Wi-Fi"
            case .relay: return "Inbox · through the relay"
            case .tailnet: break
            }
        }
        return source.address.isLoopback ? "Inbox · on this Mac" : source.tailnet == nil ? "Inbox · over Wi-Fi" : "Inbox · over your tailnet"
    }

    private func statusColor(_ id: String) -> Color? {
        guard model.activeId == id, let session = model.session else { return nil }
        return session.statusColor
    }

    private func statusWords(_ id: String) -> String {
        guard model.activeId == id, let session = model.session else { return "" }
        return session.statusWords(relayOn: session.source.map(model.relayOn) ?? false)
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "1.0") (\(info?["CFBundleVersion"] as? String ?? "1"))"
    }
}

/// 9.1's Notifications: "Allow notifications" asks the system once (never
/// at launch); "Answer from the lock screen" gives a single-choice question
/// its choices as buttons.
struct NotificationsSection: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var notifier = model.notifier
        Section {
            Toggle("Allow notifications", isOn: Binding(get: { notifier.allowed }, set: { on in
                Task { await notifier.setAllowed(on, sources: model.sources) }
            }))
            .accessibilityIdentifier("allow-notifications")
            Toggle("Answer from the lock screen", isOn: $notifier.answerOnLockScreen)
                .disabled(!notifier.allowed)
                .accessibilityIdentifier("answer-lock-screen")
        } header: {
            Text("Notifications").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
        } footer: {
            Text("A message with one question and one choice to make shows its choices as buttons. Anything else opens the thread.")
        }
    }
}

/// 9.2: how the phone reaches this computer, in the order it tries them:
/// the same Wi-Fi, the tailnet, then the Plannotator relay with its switch
/// (on by default from pairing). The line under the name
/// says which one is in use. "Remove this source" revokes this phone's
/// token on the computer.
struct SourceScreen: View {
    let source: Source
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false
    @State private var unreachable: InboxError?
    @State private var removing = false

    private var session: SourceSession? { model.activeId == source.id ? model.session : nil }
    private var inUse: InboxPath? { session?.status == .connected ? session?.path : nil }

    var body: some View {
        List {
            Section {
                VStack(spacing: 6) {
                    ComputerTile(size: 64)
                        .padding(.bottom, 8)
                    Text(source.name).font(.title2.bold()).foregroundStyle(Color.ink)
                    HStack(spacing: 6) {
                        if let color = session?.statusColor { Circle().fill(color).frame(width: 8, height: 8) }
                        Text(statusLine).font(.subheadline).foregroundStyle(Color.inkSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("path-status")
            }
            Section {
                PathRow(title: "Same Wi-Fi", detail: wifiDetail, inUse: inUse == .wifi) {
                    PathTile(color: Color(red: 0.0, green: 0.6, blue: 0.85)) { Image(systemName: "wifi").font(.system(size: 15, weight: .semibold)) }
                }
                .accessibilityIdentifier("path-wifi")
                PathRow(title: "Tailnet", detail: source.tailnet?.hostPort ?? "Not set up", inUse: inUse == .tailnet) {
                    PathTile(color: Color(white: 0.24)) { Image(systemName: "point.3.connected.trianglepath.dotted").font(.system(size: 15, weight: .semibold)) }
                }
                .accessibilityIdentifier("path-tailnet")
                Toggle(isOn: Binding(get: { model.relayOn(source) }, set: { on in Task { await model.setRelay(source, on: on) } })) {
                    HStack(spacing: 13) {
                        PathTile(color: .tint) { RelayGlyph().stroke(style: StrokeStyle(lineWidth: 2.1, lineCap: .round, lineJoin: .round)).frame(width: 18, height: 18) }
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Plannotator relay").foregroundStyle(Color.ink)
                            Text(source.relay == nil ? "Not available yet" : "When the other two can't reach it").font(.footnote).foregroundStyle(Color.inkSecondary)
                        }
                    }
                }
                .disabled(source.relay == nil)
                .accessibilityIdentifier("relay-switch")
            } header: {
                Text("How the phone reaches it").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
            } footer: {
                Text("The relay carries messages encrypted end to end; it cannot read them. It also brings notifications while the app is closed.")
            }
            Section {
                LabeledContent("Paired", value: When.dayAndTime(source.pairedAt))
                LabeledContent("Notifications", value: model.notifier.allowed ? "On" : "Off")
            } header: {
                Text("This phone").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
            }
            Section {
                Button(role: .destructive) {
                    confirm = true
                } label: {
                    HStack {
                        Spacer()
                        if removing { ProgressView() } else { Text("Remove this source") }
                        Spacer()
                    }
                }
                .disabled(removing)
                .accessibilityIdentifier("remove-source")
            } footer: {
                Text("Unpairs this phone. Nothing on your computer is deleted.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.ground)
        .navigationTitle(source.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        // Forgotten elsewhere (paired again, or removed): this screen has nothing to show.
        .onChange(of: model.sources) { _, sources in
            if !sources.contains(where: { $0.id == source.id }) { dismiss() }
        }
        .confirmationDialog("Remove \(source.name)?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Remove This Source", role: .destructive) { remove(force: false) }
        } message: {
            Text("This phone stops reading and answering this Inbox. Nothing on your computer is deleted.")
        }
        .alert("Can't reach \(source.name)", isPresented: Binding(get: { unreachable != nil }, set: { if !$0 { unreachable = nil } })) {
            Button("Remove Anyway", role: .destructive) { remove(force: true) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The phone will forget it now. Your computer keeps listing this phone until you remove it there, under Pair a phone.")
        }
    }

    private var wifiDetail: String {
        guard let lan = source.lan else { return "Not set up" }
        return inUse == .wifi ? lan.address.hostPort : "Not on it now"
    }

    private var statusLine: String {
        guard let session else { return source.address.isLoopback ? "On this Mac" : "Not shown now" }
        return session.statusWords(relayOn: model.relayOn(source))
    }

    private func remove(force: Bool) {
        removing = true
        Task {
            defer { removing = false }
            if let error = await model.remove(source, force: force) {
                unreachable = error
            } else {
                dismiss()
            }
        }
    }
}

/// A row of 9.2's paths: its tile, its name, what it reaches, a tick when in use.
private struct PathRow<Tile: View>: View {
    var title: String
    var detail: String
    var inUse: Bool
    @ViewBuilder var tile: Tile

    var body: some View {
        HStack(spacing: 13) {
            tile
            VStack(alignment: .leading, spacing: 1) {
                Text(title).foregroundStyle(Color.ink)
                Text(detail).font(.footnote).foregroundStyle(Color.inkSecondary)
            }
            Spacer(minLength: 8)
            if inUse {
                Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.tint).accessibilityLabel("In use")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct PathTile<Glyph: View>: View {
    var color: Color
    @ViewBuilder var glyph: Glyph

    var body: some View {
        glyph
            .foregroundStyle(.white)
            .frame(width: 30, height: 30)
            .background(color, in: .rect(cornerRadius: 8))
            .accessibilityHidden(true)
    }
}

/// The record's relay mark: an arc over a hub, drawn on a 24-point grid.
private struct RelayGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + x * s, y: rect.minY + y * s) }
        var path = Path()
        path.addArc(center: p(12, 15), radius: 8 * s, startAngle: .degrees(180), endAngle: .degrees(0), clockwise: false)
        path.move(to: p(4, 15)); path.addLine(to: p(7, 15))
        path.move(to: p(17, 15)); path.addLine(to: p(20, 15))
        path.addEllipse(in: CGRect(origin: p(10, 13), size: CGSize(width: 4 * s, height: 4 * s)))
        return path
    }
}

extension SourceSession {
    /// Where this computer is reached, in words: 9.2's line, 9.1's row.
    /// Workspaces keeps its own short words.
    func statusWords(relayOn: Bool) -> String {
        if isWorkspaces {
            switch status {
            case .connected: return "Connected"
            case .unreachable: return "Not reachable"
            case .removed: return "Signed out"
            case .connecting: return ""
            }
        }
        switch status {
        case .removed: return "This phone was removed on the computer"
        case .connecting: return "Connecting"
        case .unreachable: return relayOn ? "Not reachable right now" : "Not reachable right now. The relay is off."
        case .connected:
            switch path {
            case .wifi: return "Connected over Wi-Fi"
            case .relay: return inboxOnline ? "Connected through the relay" : "Waiting for your computer"
            default: return source?.address.isLoopback == true ? "Connected on this Mac" : "Connected over your tailnet"
            }
        }
    }

    /// The dot beside those words: green while the computer answers.
    var statusColor: Color? {
        switch status {
        case .connected: return path == .relay && !inboxOnline ? .inkSecondary : .success
        case .unreachable, .removed: return .inkSecondary
        case .connecting: return nil
        }
    }
}
