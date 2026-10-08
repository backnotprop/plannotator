import PlannotatorKit
import SwiftUI

/// Workspaces in Settings: who is signed in, their teams, and Sign Out, which
/// ends this session in Workspaces (its push devices go with it).
struct WorkspacesScreen: View {
    let account: WorkspacesAccount
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirm = false
    @State private var signingOut = false
    @State private var unconfirmed: InboxError?

    private var status: SourceSession.Status? { model.activeId == WorkspacesAccount.sourceId ? model.session?.status : nil }

    var body: some View {
        List {
            Section {
                VStack(spacing: 6) {
                    Image("WorkspacesIcon").resizable().scaledToFit().frame(width: 64, height: 64).padding(.bottom, 8)
                    Text("Workspaces").font(.title2.bold()).foregroundStyle(Color.ink)
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
                if let name = account.name { LabeledContent("Signed in as", value: name) }
                LabeledContent(account.teams.count == 1 ? "Team" : "Teams", value: account.teams.isEmpty ? "Personal" : account.teams.joined(separator: ", "))
                LabeledContent("Address", value: account.origin.host() ?? account.origin.absoluteString)
            } header: {
                Text("Account").font(.subheadline.weight(.semibold)).foregroundStyle(Color.ink).textCase(nil)
            }
            Section {
                Button(role: .destructive) {
                    confirm = true
                } label: {
                    HStack {
                        Spacer()
                        if signingOut { ProgressView() } else { Text("Sign Out") }
                        Spacer()
                    }
                }
                .disabled(signingOut)
                .accessibilityIdentifier("sign-out")
            } footer: {
                Text("Ends this phone's session. Nothing in Workspaces is deleted.")
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Color.ground)
        .navigationTitle("Workspaces")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .confirmationDialog("Sign out of Workspaces?", isPresented: $confirm, titleVisibility: .visible) {
            Button("Sign Out", role: .destructive) { signOut() }
        } message: {
            Text("This phone stops reading and answering Workspaces until you sign in again.")
        }
        .alert("Signed out on this phone", isPresented: Binding(get: { unconfirmed != nil }, set: { if !$0 { unconfirmed = nil; dismiss() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("Workspaces could not confirm the session ended. \(unconfirmed?.message ?? "")")
        }
    }

    private var statusLine: String {
        switch status {
        case .connected: "Connected"
        case .unreachable: "Not reachable right now"
        case .removed: "Signed out. Sign in again from the Inbox."
        default: "Signed in"
        }
    }

    private func signOut() {
        signingOut = true
        Task {
            let problem = await model.signOutOfWorkspaces()
            signingOut = false
            if let problem, !problem.isDefinite { unconfirmed = problem } else { dismiss() }
        }
    }
}
