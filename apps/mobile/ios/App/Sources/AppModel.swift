import Foundation
import InboxCore
import InboxStandIn
import InboxWire
import Observation
import UIKit

/// The app's one model: which computer this phone is paired with, and pairing itself.
@MainActor
@Observable
final class AppModel {
  enum Pairing: Equatable {
    case idle
    case working
    /// Words to show under the camera: the Inbox's own for a refusal, the app's for a computer it could not reach.
    case failed([String])
  }

  private(set) var session: InboxSession?
  private(set) var pairing: Pairing = .idle
  /// True once the Keychain was read, so the first screen is never a flash of the pairing screen.
  private(set) var booted = false
  private(set) var isDemo = false
  /// A thread to open at launch (a pairing link's or a test's).
  var opening: ThreadID?

  let app = AppIdentity(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0")
  private let credentials: any CredentialStore
  private let defaults: UserDefaults
  private var standIn: StandInDoor?
  private static let demoKey = "demo"

  init(credentials: any CredentialStore = KeychainCredentialStore(), defaults: UserDefaults = .standard) {
    self.credentials = credentials
    self.defaults = defaults
  }

  private var copyRoot: URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
  }

  func boot() async {
    defer { booted = true }
    let launch = LaunchOptions()
    if launch.standIn || defaults.bool(forKey: Self.demoKey) {
      await startDemo(launch)
      return
    }
    if let computer = (try? credentials.all())?.first { use(computer) }
    if session == nil, let link = launch.pairLink { await open(link: link) }
  }

  private func use(_ computer: PairedComputer) {
    let copy = LocalCopy(folder: LocalCopy.folder(root: copyRoot, computer: computer.id))
    let session = InboxSession(computer: computer, app: app, copy: copy) { computer in computer.addresses.compactMap { HTTPTransport(address: $0) } }
    self.session = session
    isDemo = false
    Task { await session.start() }
  }

  // MARK: Pairing

  /// A scanned code, a link opened from the Camera app, or one handed in at launch.
  func open(link text: String) async {
    guard pairing != .working else { return }
    let link: PairLink
    do { link = try PairLink(text) } catch {
      pairing = .failed([error == .newerVersion ? PhoneWords.updatePhone : PhoneWords.pairNotACode])
      return
    }
    await redeem(addresses: link.addresses, secret: link.secret, code: nil)
  }

  /// The address and the six digits, typed: the tailnet only.
  func pair(address: String, code: String) async {
    let hostPort = address.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "https://", with: "")
    await redeem(addresses: [.tailnet(hostPort: hostPort.hasSuffix("/") ? String(hostPort.dropLast()) : hostPort)], secret: nil, code: code.trimmingCharacters(in: .whitespaces))
  }

  private func redeem(addresses: [DoorAddress], secret: String?, code: String?) async {
    pairing = .working
    var tried: [String] = []
    for address in addresses {
      guard let transport = HTTPTransport(address: address, timeout: 8) else { continue }
      let client = DoorClient(transport: transport, token: nil, app: app)
      do {
        let answer = try await client.pair(secret: secret, code: code, deviceName: UIDevice.current.name)
        var reach: [DoorAddress] = []
        if let lan = answer.addresses.lan, let fingerprint = answer.addresses.fingerprint { reach.append(.wifi(hostPort: lan, fingerprint: fingerprint)) }
        if let tailnet = answer.addresses.tailnet { reach.append(.tailnet(hostPort: tailnet)) }
        if reach.isEmpty { reach = addresses }
        let computer = PairedComputer(
          id: answer.device.id.rawValue, name: answer.computer.name, token: answer.token, secret: answer.secret, addresses: reach, relayURL: answer.relay?.url, mailboxID: answer.relay?.mailboxId)
        do { try credentials.save(computer) } catch {
          pairing = .failed([String(describing: error)])
          return
        }
        pairing = .idle
        use(computer)
        return
      } catch let failure as DoorFailure {
        switch failure {
        case .unreachable, .unreadable:
          tried.append(PhoneWords.pairNoAnswer(address.hostPort))
          if case .wifi = address { tried.append(PhoneWords.pairNeedsWifi) } else { tried.append(PhoneWords.pairNeedsTailnet) }
          continue
        case .appNeedsUpdate:
          pairing = .failed([PhoneWords.updatePhone])
        case .refused(_, let error):
          // The Inbox's own words, with the tries left on a wrong code.
          pairing = .failed([error.error] + (error.triesLeft.map { [PhoneWords.pairTriesLeft(Int($0))] } ?? []))
        case .notOffered:
          pairing = .failed([PhoneWords.updateComputer(address.hostPort)])
        }
        return
      } catch {
        tried.append(PhoneWords.pairNoAnswer(address.hostPort))
      }
    }
    pairing = .failed(tried)
  }

  func clearPairingFailure() { if case .failed = pairing { pairing = .idle } }

  // MARK: The demo: a stand-in computer in memory

  func startDemo(_ launch: LaunchOptions = LaunchOptions()) async {
    var options = StandInDoor.Options()
    if let floor = launch.standInFloor { options.minAppContract = floor; options.contract = floor }
    let door = StandInDoor(options: options)
    standIn = door
    let issued = await door.issueToken()
    let computer = PairedComputer(id: issued.device.rawValue, name: options.computerName, token: launch.standInRemoved ? "tok_removed" : issued.token, secret: options.secret, addresses: [])
    let session = InboxSession(computer: computer, app: app) { _ in [StandInTransport(door: door)] }
    self.session = session
    isDemo = true
    if !launch.standIn { defaults.set(true, forKey: Self.demoKey) }
    await session.start()
    #if DEBUG
      await launch.stage(session: session, door: door)
      opening = launch.open
    #endif
  }

  /// Remove this phone from the computer and forget the computer here: its Keychain item and its copy.
  func removeThisPhone() async {
    guard let session else { return }
    self.session = nil
    if isDemo {
      defaults.removeObject(forKey: Self.demoKey)
      standIn = nil
      isDemo = false
      return
    }
    try? credentials.remove(id: session.computer.id)
    await session.removeThisPhone()
  }
}

/// What a launch may hand the app. `-pairLink` is how a test pairs without a camera; the `-standIn…` ones seat
/// the stand-in computer for UI tests and screenshots and exist only in debug builds.
struct LaunchOptions {
  private let defaults = UserDefaults.standard
  var pairLink: String? { defaults.string(forKey: "pairLink") }
  var standIn: Bool { debug && defaults.bool(forKey: "standIn") }
  var standInFloor: Int? { debug && defaults.object(forKey: "standInFloor") != nil ? defaults.integer(forKey: "standInFloor") : nil }
  var standInRemoved: Bool { debug && defaults.bool(forKey: "standInRemoved") }
  var open: ThreadID? { debug ? defaults.string(forKey: "open").map { ThreadID($0) } : nil }
  var stageName: String? { debug ? defaults.string(forKey: "stage") : nil }
  var screen: String? { debug ? defaults.string(forKey: "screen") : nil }

  private var debug: Bool {
    #if DEBUG
      return true
    #else
      return false
    #endif
  }

  #if DEBUG
    /// Put the stand-in in a state a screenshot needs, through the same calls a tap makes.
    @MainActor
    func stage(session: InboxSession, door: StandInDoor) async {
      guard let stageName else { return }
      for step in stageName.split(separator: ",") {
        switch step {
        case "open":
          await session.open(StandInData.retry)
        case "picked":
          await session.open(StandInData.retry)
          if let asked = session.thread(StandInData.retry)?.thread.messages.last, let question = asked.questions?.first {
            await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
          }
        case "multi":
          await session.open(StandInData.checkout)
          if let asked = session.thread(StandInData.checkout)?.thread.messages.last, let question = asked.questions?.first {
            await session.pick(thread: StandInData.checkout, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["One page", "Summary beside"], note: "Keep the summary but drop the promo box"))
          }
        case "sent":
          await session.send(thread: StandInData.retry, words: "Go ahead, and tell me when the first 10% looks healthy.")
        case "away":
          await door.setOffline(true)
          await session.refresh()
        case "heldpick":
          if let asked = session.thread(StandInData.retry)?.thread.messages.last, let question = asked.questions?.first {
            await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
          }
        case "refused":
          if let asked = session.thread(StandInData.retry)?.thread.messages.last, let question = asked.questions?.first {
            let other = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: AppIdentity(version: "0.1.0"))
            _ = try? await other.picks(asked.id, body: QuestionAnswers.pickBody(key: question.key, revision: question.revision, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""), idempotencyKey: UUID().uuidString))
            await session.pick(thread: StandInData.retry, message: asked.id, question: question, answer: QuestionAnswers.choice(question, selected: ["Staged, 10% first"], note: ""))
          }
        default: break
        }
      }
    }
  #endif
}
