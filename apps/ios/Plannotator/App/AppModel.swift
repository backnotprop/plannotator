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
    /// The address this phone paired at: the tailnet publication (or loopback
    /// in the simulator), or the Wi-Fi listener when the code carried only that.
    var address: InboxAddress
    var pairedAt: Date
    /// The computer's relay mailbox, from the pairing answer: where this phone's
    /// APNs token goes, and the fallback path (9.2).
    var relay: InboxRelayRef?
    /// The Wi-Fi listener and its certificate's SHA-256, from the QR code
    /// (contract section 3): the fingerprint comes from the computer's screen.
    var lan: LanAddress?

    /// The tailnet row's address (9.2): none when the phone paired over the Wi-Fi alone.
    var tailnet: InboxAddress? { address == lan?.address ? nil : address }

    /// The direct paths, in the order the phone tries them: the Wi-Fi, then the tailnet.
    func directClients(token: String) -> [InboxClient] {
        [lan.map { InboxClient(address: $0.address, token: token, pin: $0.fingerprint) }, tailnet.map { InboxClient(address: $0, token: token) }].compactMap(\.self)
    }
}

/// The Wi-Fi listener's address and the certificate the phone pins there.
struct LanAddress: Codable, Hashable {
    var address: InboxAddress
    var fingerprint: String
}

/// What the app keeps per source between launches: the store seq it has
/// read up to, the last relay item it read, the relay switch, and the
/// carriage the relay holds for this phone (contract section 4).
struct SourceState: Codable {
    /// The highest store seq this phone has applied, directly or through the relay.
    var seq = 0
    /// The last relay item number read (`items?after=`).
    var relayThrough = 0
    /// The store seq last acknowledged at the relay after reading directly.
    var ackedSeq = 0
    /// The person's own relay switch; nil until they touch it: on, the
    /// fallback by default from pairing (pick 5 of the iPhone record).
    var relayChoice: Bool?
    /// The carriage the relay holds for this phone, as last set: on from pairing.
    var carriage = true

    static func load(_ source: String) -> SourceState {
        UserDefaults.standard.data(forKey: key(source)).flatMap { try? JSONDecoder().decode(SourceState.self, from: $0) } ?? SourceState()
    }

    static func update(_ source: String, _ change: (inout SourceState) -> Void) {
        var state = load(source)
        change(&state)
        UserDefaults.standard.set(try? JSONEncoder().encode(state), forKey: key(source))
    }

    static func clear(_ source: String) {
        UserDefaults.standard.removeObject(forKey: key(source))
    }

    private static func key(_ source: String) -> String { "sourceState.\(source)" }
}

/// A Send the relay holds for a computer it cannot reach: its thread says
/// "Sent. Waiting for your computer" until the reply lands (owner item 26).
/// Kept across launches; settled by the reply's key in the thread, by the
/// command's result, or (the relay switch off) by asking the door again
/// directly with the same key.
struct PendingSend: Codable, Hashable {
    var source: String
    var thread: String
    var message: String
    /// The Send's idempotency key, which is also its relay command id.
    var key: String
    var words: String?
    /// The Send as posted, so it can be asked again directly by its key.
    var body: InboxClient.ReplyBody?

    private static let name = "pendingSends"

    static func all() -> [PendingSend] {
        UserDefaults.standard.data(forKey: name).flatMap { try? JSONDecoder().decode([PendingSend].self, from: $0) } ?? []
    }

    static func add(_ send: PendingSend) {
        save(all().filter { $0.key != send.key } + [send])
    }

    static func remove(where match: (PendingSend) -> Bool) {
        save(all().filter { !match($0) })
    }

    private static func save(_ sends: [PendingSend]) {
        UserDefaults.standard.set(try? JSONEncoder().encode(sends), forKey: name)
    }
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
    /// Notifications: the permission, the APNs token, 9.1's switches.
    let notifier = Notifier()
    /// A thread a notification opened, for the Inbox tab to push.
    var opening: ThreadRoute?
    /// The Workspaces sign-in sheet (1.4) is up, or its session is being redeemed.
    private(set) var signingIn = false
    var signInProblem: String?
    /// The APNs token iOS handed this install, once notifications are allowed.
    var pushToken: Data? {
        didSet { registerPushDevice() }
    }
    /// The person's relay switch per source (9.2), once touched.
    private(set) var relayChoices: [String: Bool] = [:]

    private let defaults = UserDefaults.standard
    private let signIn = WorkspacesSignInFlow()

    init() {
        sources = loadEach(Source.self, "sources")
        known = loadEach(KnownComputer.self, "known")
        if WorkspacesAccount.origin != nil { workspaces = load(WorkspacesAccount.self, "workspacesAccount") }
        // iOS keeps Keychain items when an app is deleted; a fresh install starts clean.
        if sources.isEmpty { Keychain.deleteAll() } else { Keychain.migrate() }
        for source in sources { relayChoices[source.id] = SourceState.load(source.id).relayChoice }
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
        session = SourceSession(source: source, credential: credential) { [weak self] in self?.relayCarries(source) ?? false }
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

    // MARK: The relay switch (9.2)

    /// The switch as drawn: the person's choice, else on (the fallback by default
    /// from pairing). Allowing notifications registers the push token only.
    func relayOn(_ source: Source) -> Bool {
        source.relay != nil && (relayChoices[source.id] ?? true)
    }

    /// The relay carries this source now: the switch is on and the relay holds it on.
    private func relayCarries(_ source: Source) -> Bool {
        relayOn(source) && SourceState.load(source.id).carriage
    }

    func setRelay(_ source: Source, on: Bool) async {
        relayChoices[source.id] = on
        SourceState.update(source.id) { $0.relayChoice = on }
        await syncRelay(source)
    }

    /// Tells each relay the switch as drawn, where it differs from what the relay
    /// holds (on from pairing); a change the relay did not hear is told again here.
    func syncRelays() async {
        for source in sources { await syncRelay(source) }
    }

    private func syncRelay(_ source: Source) async {
        guard let relay = source.relay, let credential = Keychain.load(device: source.id),
              let client = RelayClient(relay: relay, device: source.id, secret: credential.secret) else { return }
        let want = relayOn(source)
        let state = SourceState.load(source.id)
        guard want != state.carriage else { return }
        do throws(InboxError) {
            try await client.setCarriage(on: want, cursor: state.seq)
            SourceState.update(source.id) { $0.carriage = want }
            if session?.id == source.id { await session?.relayChanged() }
        } catch {
            // Told again at the next return to the front.
        }
    }

    // MARK: Pairing (contract section 2, "Redeeming an offer")

    /// Redeems a scanned link: its secret over the Wi-Fi first, the certificate
    /// pinned to the code's fingerprint, then over the tailnet (section 1, "The link").
    func pair(link: PairLink) async throws(InboxError) {
        let lan = link.lanAddress
        guard let first = lan?.address ?? link.tailnet else {
            throw .refused(status: 0, code: "no_address", message: "This code has no address your phone can reach. On your computer, turn on Reach from my tailnet or Reach from this Wi-Fi, then show the code again.", triesLeft: nil)
        }
        let address = link.tailnet ?? first
        if let lan {
            do {
                try await redeem(at: lan.address, pin: lan.fingerprint, secret: link.secret, code: nil, address: address, lan: lan)
                return
            } catch where !error.isDefinite && link.tailnet != nil {
                // No answer over the Wi-Fi: the tailnet next.
            }
        }
        try await redeem(at: address, pin: nil, secret: link.secret, code: nil, address: address, lan: lan)
    }

    /// Redeems the six digits typed for a computer found on the tailnet or typed in (1.3).
    func pair(address: InboxAddress, code: String) async throws(InboxError) {
        try await redeem(at: address, pin: nil, secret: nil, code: code, address: address, lan: nil)
    }

    private func redeem(at dial: InboxAddress, pin: String?, secret: String?, code: String?, address: InboxAddress, lan: LanAddress?) async throws(InboxError) {
        let answer = try await InboxClient.pair(at: dial, pin: pin, secret: secret, code: code, name: UIDevice.current.name)
        Keychain.save(DeviceCredential(token: answer.token, secret: answer.secret), device: answer.device.id)
        let source = Source(id: answer.device.id, name: answer.computer.name, address: address, pairedAt: .now, relay: answer.relay, lan: lan)
        // Pairing again with a computer this phone was removed from replaces the old source.
        for old in sources where old.address == address { forget(old, showNext: false) }
        sources.append(source)
        remember(KnownComputer(name: source.name, address: address))
        save()
        session?.stop()
        session = nil
        show(source)
        pairing = false
        await notifier.paired(source)
        await syncRelay(source)
    }

    // MARK: Removing

    /// "Remove this source" (9.2): revoke this phone's token on the computer, then forget it here.
    /// Returns the error when the computer could not be told; the caller may remove anyway.
    func remove(_ source: Source, force: Bool = false) async -> InboxError? {
        if !force, let credential = Keychain.load(device: source.id) {
            var unanswered: InboxError?
            for client in source.directClients(token: credential.token) {
                do {
                    try await client.revoke()
                    unanswered = nil
                    break
                } catch where !error.isDefinite {
                    unanswered = error
                } catch {
                    unanswered = nil
                    break
                }
            }
            if let unanswered { return unanswered }
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
        SourceState.clear(source.id)
        PendingSend.remove { $0.source == source.id }
        relayChoices[source.id] = nil
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

extension PairLink {
    /// The addresses pairing contacts, in order: the Wi-Fi listener (with its pin), then the tailnet.
    var addresses: [InboxAddress] { [lanAddress?.address, tailnet].compactMap(\.self) }

    /// The Wi-Fi listener and its pin, when the code carries both and the pin is a SHA-256.
    var lanAddress: LanAddress? {
        guard let lan, let fingerprint, fingerprint.count == 64, fingerprint.allSatisfy(\.isHexDigit) else { return nil }
        return LanAddress(address: lan, fingerprint: fingerprint.lowercased())
    }
}
