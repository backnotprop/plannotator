import Foundation
import Observation
import PlannotatorKit
import UIKit

/// A paired computer: what the phone keeps about it outside the Keychain.
struct Source: Codable, Hashable, Identifiable {
    /// The device id the computer gave this phone (`dev_...`); the Keychain item's name.
    var id: String
    var name: String
    /// The address this phone reaches it at: the tailnet publication (or loopback in the simulator).
    var address: InboxAddress
    var pairedAt: Date
    /// The computer's relay mailbox, from the pairing answer: where this phone's APNs token goes.
    var relay: InboxRelayRef?
}

/// A computer the phone has seen in a QR link or paired with, listed under
/// "On your tailnet" in 1.3 (a tailnet cannot be listed from another app).
struct KnownComputer: Codable, Hashable, Identifiable {
    var name: String
    var address: InboxAddress
    var id: String { address.hostPort }
}

/// The app's state: the paired sources, the one shown, and pairing.
@Observable
final class AppModel {
    private(set) var sources: [Source] = []
    private(set) var known: [KnownComputer] = []
    private(set) var session: SourceSession?
    /// The pairing cover (1.2) is up.
    var pairing = false
    /// A pairing link opened from outside the app, waiting for the person's yes.
    var offered: PairLink?
    /// Notifications: the permission, the APNs token, 9.1's switches.
    let notifier = Notifier()
    /// A thread a notification opened, for the Inbox tab to push.
    var opening: ThreadRoute?

    private let defaults = UserDefaults.standard

    init() {
        sources = load([Source].self, "sources") ?? []
        known = load([KnownComputer].self, "known") ?? []
        // iOS keeps Keychain items when an app is deleted; a fresh install starts clean.
        if sources.isEmpty { Keychain.deleteAll() }
        let active = defaults.string(forKey: "activeSource")
        if let source = sources.first(where: { $0.id == active }) ?? sources.first { show(source) }
    }

    var active: Source? { session?.source }

    func show(_ source: Source) {
        guard session?.source.id != source.id, let credential = Keychain.load(device: source.id) else { return }
        session?.stop()
        session = SourceSession(source: source, token: credential.token)
        defaults.set(source.id, forKey: "activeSource")
        session?.start()
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
        let source = Source(id: answer.device.id, name: answer.computer.name, address: address, pairedAt: .now, relay: answer.relay)
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
        if session?.source.id == source.id {
            session?.stop()
            session = nil
        }
        Keychain.delete(device: source.id)
        Cache.clear(source: source.id)
        sources.removeAll { $0.id == source.id }
        if showNext, session == nil, let next = sources.first { show(next) }
    }

    private func remember(_ computer: KnownComputer) {
        known.removeAll { $0.address == computer.address }
        known.insert(computer, at: 0)
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(sources), forKey: "sources")
        defaults.set(try? JSONEncoder().encode(known), forKey: "known")
    }

    private func load<T: Decodable>(_ type: T.Type, _ key: String) -> T? {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(T.self, from: $0) }
    }
}
