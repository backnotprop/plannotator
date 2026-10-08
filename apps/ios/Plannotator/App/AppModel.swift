import Foundation
import Observation
import PlannotatorKit
import UIKit
import UserNotifications

/// A paired computer: what the phone keeps about it outside the Keychain.
struct Source: Codable, Hashable, Identifiable {
    /// The device id the computer gave this phone (`dev_...`); the Keychain item's name.
    var id: String
    var name: String
    /// The address this phone reaches it at: the tailnet publication (or loopback in the simulator).
    var address: InboxAddress
    var pairedAt: Date
}

/// A computer the phone has seen in a QR link or paired with, listed under
/// "On your tailnet" in 1.3 (a tailnet cannot be listed from another app).
struct KnownComputer: Codable, Hashable, Identifiable {
    var name: String
    var address: InboxAddress
    var id: String { address.hostPort }
}

/// The app's state: the paired sources and Workspaces, the one shown, pairing and signing in.
@Observable
final class AppModel {
    private(set) var sources: [Source] = []
    private(set) var known: [KnownComputer] = []
    /// The Workspaces account, when this build has the source and the person signed in.
    private(set) var workspaces: WorkspacesAccount?
    private(set) var session: SourceSession?
    /// The pairing cover (1.2) is up.
    var pairing = false
    /// A pairing link opened from outside the app, waiting for the person's yes.
    var offered: PairLink?
    /// The Workspaces sign-in sheet (1.4) is up, or its session is being redeemed.
    private(set) var signingIn = false
    var signInProblem: String?
    /// The APNs token iOS handed this install, once notifications are allowed.
    var pushToken: Data? {
        didSet { registerPushDevice() }
    }

    private let defaults = UserDefaults.standard
    private let signIn = WorkspacesSignInFlow()

    init() {
        sources = loadEach(Source.self, "sources")
        known = loadEach(KnownComputer.self, "known")
        if WorkspacesAccount.origin != nil { workspaces = load(WorkspacesAccount.self, "workspacesAccount") }
        // iOS keeps Keychain items when an app is deleted; a fresh install starts clean.
        if sources.isEmpty { Keychain.deleteAll() }
        let active = defaults.string(forKey: "activeSource")
        if active == WorkspacesAccount.sourceId, workspaces != nil {
            showWorkspaces()
        } else if let source = sources.first(where: { $0.id == active }) ?? sources.first {
            show(source)
        } else if workspaces != nil {
            showWorkspaces()
        }
    }

    /// The shown source's id: a computer's device id, or "workspaces".
    var activeId: String? { session?.id }

    /// This build has the Workspaces source (the `WORKSPACES_HOST` build setting).
    var hasWorkspaces: Bool { WorkspacesAccount.origin != nil }

    func show(_ source: Source) {
        guard session?.id != source.id, let credential = Keychain.load(device: source.id) else { return }
        session?.stop()
        session = SourceSession(source: source, token: credential.token)
        defaults.set(source.id, forKey: "activeSource")
        session?.start()
    }

    /// One source at a time: switching stops the other's live changes.
    func showWorkspaces() {
        guard let account = workspaces, !(session?.isWorkspaces == true && session?.status != .removed) else { return }
        session?.stop()
        session = SourceSession(workspaces: WorkspacesSource(client: WorkspacesClient(origin: account.origin), userId: account.userId))
        defaults.set(WorkspacesAccount.sourceId, forKey: "activeSource")
        session?.start()
    }

    /// How many threads wait on the person in a source: the live list for the
    /// shown one, the last list read for another (the switcher's counts, 1.5A).
    func waiting(_ id: String) -> Int {
        let list = session?.id == id && session?.project == nil ? session?.list : Cache(source: id).read(InboxListModel.self, "list")
        return (list?.sections ?? []).filter { ["stopped", "holding", "waiting"].contains($0.id) }.reduce(0) { $0 + $1.threads.count }
    }

    // MARK: Workspaces (1.4)

    /// The system browser sheet on the sign-in door; on return, the normal session.
    func signInToWorkspaces() async {
        guard let origin = WorkspacesAccount.origin, !signingIn else { return }
        signingIn = true
        defer { signingIn = false }
        do throws(InboxError) {
            guard let me = try await signIn.run(origin: origin) else { return }
            workspaces = WorkspacesAccount(
                origin: origin, userId: me.userId, name: me.name, teams: me.memberships.compactMap(\.name),
                deviceId: workspaces?.deviceId ?? WorkspacesAccount.newDeviceId()
            )
            save()
            Haptics.success()
            pairing = false
            showWorkspaces()
            await registerForPushIfAllowed()
        } catch {
            Haptics.error()
            signInProblem = error.message
        }
    }

    /// A sign-in return link from outside the sheet. Answers true when the link
    /// was one (finished only if it answers the sign-in in progress, else dropped).
    func receiveSignInReturn(_ url: URL) -> Bool {
        guard WorkspacesSignInFlow.isReturn(url) else { return false }
        signIn.receive(url)
        return true
    }

    /// Sign out (Workspaces in Settings): the door ends this session at WorkOS and
    /// its push devices with it; the phone forgets the cookies and the account.
    /// Answers the error when Workspaces could not be told.
    func signOutOfWorkspaces() async -> InboxError? {
        guard let account = workspaces else { return nil }
        var problem: InboxError?
        do throws(InboxError) {
            try await WorkspacesClient(origin: account.origin).logout()
        } catch {
            problem = error
        }
        workspaces = nil
        save()
        Cache.clear(source: WorkspacesAccount.sourceId)
        if session?.isWorkspaces == true {
            session?.stop()
            session = nil
            if let next = sources.first { show(next) }
        }
        return problem
    }

    /// Push for Workspaces: once the person allows notifications, iOS hands a
    /// token, and this install registers it on the device door.
    func registerForPushIfAllowed() async {
        guard workspaces != nil else { return }
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized else { return }
        UIApplication.shared.registerForRemoteNotifications()
    }

    private func registerPushDevice() {
        guard let token = pushToken, let account = workspaces else { return }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        Task { try? await WorkspacesClient(origin: account.origin).registerDevice(id: account.deviceId, token: hex, environment: environment) }
    }

    // MARK: Pairing (contract section 2, "Redeeming an offer")

    /// Redeems a scanned link: its secret at the first address that answers.
    func pair(link: PairLink) async throws(InboxError) {
        // The LAN address needs the pinned certificate (P2); the tailnet is what this build reaches.
        guard let address = link.tailnet else { throw .refused(status: 0, code: "no_address", message: "This code has no address your phone can reach. On your computer, turn on Reach from my tailnet, then show the code again.", triesLeft: nil) }
        try await redeem(at: address, secret: link.secret, code: nil)
    }

    /// Redeems the six digits typed for a computer found on the tailnet or typed in (1.3).
    func pair(address: InboxAddress, code: String) async throws(InboxError) {
        try await redeem(at: address, secret: nil, code: code)
    }

    private func redeem(at address: InboxAddress, secret: String?, code: String?) async throws(InboxError) {
        let answer = try await InboxClient.pair(at: address, secret: secret, code: code, name: UIDevice.current.name)
        Keychain.save(DeviceCredential(token: answer.token, secret: answer.secret), device: answer.device.id)
        let source = Source(id: answer.device.id, name: answer.computer.name, address: address, pairedAt: .now)
        // Pairing again with a computer this phone was removed from replaces the old source.
        for old in sources where old.address == address { forget(old, showNext: false) }
        sources.append(source)
        remember(KnownComputer(name: source.name, address: address))
        save()
        session?.stop()
        session = nil
        show(source)
        pairing = false
    }

    // MARK: Removing

    /// "Remove this source" (9.2): revoke this phone's token on the computer, then forget it here.
    /// Returns the error when the computer could not be told; the caller may remove anyway.
    func remove(_ source: Source, force: Bool = false) async -> InboxError? {
        if !force, let credential = Keychain.load(device: source.id) {
            do {
                try await InboxClient(address: source.address, token: credential.token).revoke()
            } catch where !error.isDefinite {
                return error
            } catch {}
        }
        forget(source)
        save()
        return nil
    }

    private func forget(_ source: Source, showNext: Bool = true) {
        if session?.id == source.id {
            session?.stop()
            session = nil
        }
        Keychain.delete(device: source.id)
        Cache.clear(source: source.id)
        sources.removeAll { $0.id == source.id }
        if showNext, session == nil {
            if let next = sources.first { show(next) } else { showWorkspaces() }
        }
    }

    private func remember(_ computer: KnownComputer) {
        known.removeAll { $0.address == computer.address }
        known.insert(computer, at: 0)
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(sources), forKey: "sources")
        defaults.set(try? JSONEncoder().encode(known), forKey: "known")
        defaults.set(try? JSONEncoder().encode(workspaces), forKey: "workspacesAccount")
    }

    private func load<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }

    /// A stored list, read entry by entry: one entry that no longer reads (an
    /// address this build refuses) is dropped, and the rest stay.
    private func loadEach<T: Decodable>(_ type: T.Type, _ key: String) -> [T] {
        guard let data = defaults.data(forKey: key),
              let entries = try? JSONDecoder().decode([Entry<T>].self, from: data) else { return [] }
        return entries.compactMap(\.value)
    }

    private struct Entry<T: Decodable>: Decodable {
        let value: T?
        init(from decoder: Decoder) throws {
            value = try? T(from: decoder)
        }
    }
}
