import PlannotatorKit
import SwiftUI

/// 9.1: sources with their status, and this phone's appearance and haptics.
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
        source.address.isLoopback ? "Inbox · on this Mac" : "Inbox · over your tailnet"
    }

    private func statusColor(_ id: String) -> Color? {
        guard model.activeId == id, let status = model.session?.status else { return nil }
        switch status {
        case .connected: return .success
        case .unreachable, .removed: return .inkSecondary
        case .connecting: return nil
        }
    }

    private func statusWords(_ id: String) -> String {
        guard model.activeId == id, let status = model.session?.status else { return "" }
        switch status {
        case .connected: return "Connected"
        case .unreachable: return "Not reachable"
        case .removed: return id == WorkspacesAccount.sourceId ? "Signed out" : "Removed"
        case .connecting: return ""
        }
    }

    static var version: String {
        let info = Bundle.main.infoDictionary
        return "\(info?["CFBundleShortVersionString"] as? String ?? "1.0") (\(info?["CFBundleVersion"] as? String ?? "1"))"
    }
}

/// 9.2, with this build's one path: the tailnet row. "Remove this source"
/// revokes this phone's token on the computer.
struct SourceScreen: View {
    let source: Source
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false
    @State private var unreachable: InboxError?
    @State private var removing = false

    private var status: SourceSession.Status? { model.activeId == source.id ? model.session?.status : nil }

    var body: some View {
        List {
            Section {
                VStack(spacing: 6) {
                    ComputerTile(size: 64)
                        .padding(.bottom, 8)
                    Text(source.name).font(.title2.bold()).foregroundStyle(Color.ink)
                    HStack(spacing: 6) {
                        if status == .connected { Circle().fill(Color.success).frame(width: 8, height: 8) }
                        Text(statusLine).font(.subheadline).foregroundStyle(Color.inkSecondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .listRowBackground(Color.clear)
                .accessibilityElement(children: .combine)
            }
            Section {
                HStack(spacing: 13) {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(Color(white: 0.24), in: .rect(cornerRadius: 8))
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Tailnet").foregroundStyle(Color.ink)
                        Text(source.address.hostPort).font(.footnote).foregroundStyle(Color.inkSecondary)
                    }
                    Spacer(minLength: 8)
                    if status == .connected {
                        Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.tint).accessibilityLabel("In use")
                    }
                }
                .accessibilityElement(children: .combine)
            } header: {
                Text("How the phone reaches it").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
            }
            Section {
                LabeledContent("Paired", value: When.dayAndTime(source.pairedAt))
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

    private var statusLine: String {
        switch status {
        case .connected: source.address.isLoopback ? "Connected on this Mac" : "Connected over your tailnet"
        case .unreachable: "Not reachable right now"
        case .removed: "This phone was removed on the computer"
        default: source.address.isLoopback ? "On this Mac" : "Over your tailnet"
        }
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
