import Foundation
import InboxCore
import InboxStandIn
import InboxWire
import Observation
import UIKit

/// The app's one model: the computers this phone is paired with, the one on screen, and pairing itself.
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
  /// Every paired computer. A new pairing never hides or replaces one of these.
  private(set) var computers: [PairedComputer] = []
  private(set) var pairing: Pairing = .idle
  /// True once the Keychain was read, so the first screen is never a flash of the pairing screen.
  private(set) var booted = false
  private(set) var isDemo = false
  /// A pairing link that came from outside the app. Nothing is redeemed until the person chooses.
  var offered: PairLink?
  /// A thread to open at launch (a test's).
  var opening: ThreadID?

  let app = AppIdentity(version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.1.0")
  private let credentials: any CredentialStore
  private let defaults: UserDefaults
  private var standIn: StandInDoor?
  private static let demoKey = "demo"
  private static let lastKey = "lastComputer"

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
    computers = (try? credentials.all()) ?? []
    // A removal that was cut short leaves no copy behind.
    if let known = try? credentials.all() { LocalCopy.sweep(root: copyRoot, keeping: known.map(\.id)) }
    if launch.standIn || (defaults.bool(forKey: Self.demoKey) && computers.isEmpty) {
      await startDemo(launch)
      if let link = launch.pairLink { offer(link: link) }
      return
    }
    // The computer the person used last: never one a pairing answer could choose by its id.
    let last = defaults.string(forKey: Self.lastKey)
    if let computer = computers.first(where: { $0.id == last }) ?? computers.first { use(computer) }
    if let link = launch.pairLink { offer(link: link) }
  }

  func use(_ computer: PairedComputer) {
    session?.stop()
    let copy = LocalCopy(folder: LocalCopy.folder(root: copyRoot, computer: computer.id))
    let session = InboxSession(computer: computer, app: app, copy: copy) { computer in computer.addresses.compactMap { HTTPTransport(address: $0) } }
    self.session = session
    isDemo = false
    standIn = nil
    // A real computer ends the demo for good.
    defaults.removeObject(forKey: Self.demoKey)
    defaults.set(computer.id, forKey: Self.lastKey)
    Task { await session.start() }
  }

  // MARK: Pairing

  /// A pairing link from outside the app: a web page, another app, the Camera app. It is shown, never redeemed,
  /// until the person says Pair.
  func offer(link text: String) {
    // One at a time: a link that arrives while another pairs waits for nothing and changes nothing.
    guard pairing != .working else { return }
    clearPairingFailure()
    do {
      offered = try PairLink(text)
    } catch {
      pairing = .failed([error == .newerVersion ? PhoneWords.updatePhone : PhoneWords.pairNotACode])
    }
  }

  /// The sheet stays up while this runs, with its progress, and after a failure, with its words.
  func acceptOffered() async {
    guard let link = offered, pairing != .working else { return }
    if await redeem(addresses: link.addresses, secret: link.secret, code: nil), offered == link { offered = nil }
  }

  func declineOffered() {
    guard pairing != .working else { return }
    offered = nil
    clearPairingFailure()
  }

  /// A code scanned by the app's own camera: the person aimed the phone at their computer, so it pairs in one step.
  func scanned(_ text: String) async {
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
    guard pairing != .working else { return }
    let hostPort = address.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "https://", with: "")
    await redeem(addresses: [.tailnet(hostPort: hostPort.hasSuffix("/") ? String(hostPort.dropLast()) : hostPort)], secret: nil, code: code.trimmingCharacters(in: .whitespaces))
  }

  @discardableResult
  private func redeem(addresses: [DoorAddress], secret: String?, code: String?) async -> Bool {
    guard pairing != .working else { return false }
    pairing = .working
    var tried: [String] = []
    for address in addresses {
      guard let transport = HTTPTransport(address: address, timeout: 8) else { continue }
      let client = DoorClient(transport: transport, token: nil, app: app)
      // The first request to an address on the Wi-Fi makes iOS ask for Local Network, and fails while it asks:
      // try again a few times, a moment apart, so the person's "Allow" is enough.
      var tries = 1
      if case .wifi = address { tries = 4 }
      attempts: for attempt in 1...tries {
        do {
          let answer = try await client.pair(secret: secret, code: code, deviceName: UIDevice.current.name)
          var reach: [DoorAddress] = []
          if let lan = answer.addresses.lan, let fingerprint = answer.addresses.fingerprint { reach.append(.wifi(hostPort: lan, fingerprint: fingerprint)) }
          if let tailnet = answer.addresses.tailnet { reach.append(.tailnet(hostPort: tailnet)) }
          if reach.isEmpty { reach = addresses }
          let computer = PairedComputer(
            id: answer.device.id.rawValue, name: answer.computer.name, token: answer.token, secret: answer.secret, addresses: reach, relayURL: answer.relay?.url, mailboxID: answer.relay?.mailboxId)
          do { try credentials.save(computer) } catch {
            pairing = .failed([PhoneWords.pairNotSaved])
            return false
          }
          computers = (try? credentials.all()) ?? computers + [computer]
          pairing = .idle
          use(computer)
          return true
        } catch let failure as DoorFailure {
          switch failure {
          case .unreachable, .unreadable:
            // Again only when the request cannot have arrived (no connection was made, as while iOS asks for
            // Local Network). A request that may have been taken is never sent twice: a pairing secret is
            // redeemed once, and a second try would be told the code is no longer open.
            var neverArrived = false
            if case .unreachable(_, let mayHaveArrived) = failure { neverArrived = !mayHaveArrived }
            if attempt < tries, neverArrived {
              try? await Task.sleep(for: .seconds(2))
              continue attempts
            }
            tried.append(PhoneWords.pairNoAnswer(address.hostPort))
            if case .wifi = address { tried.append(PhoneWords.pairNeedsWifi) } else { tried.append(PhoneWords.pairNeedsTailnet) }
            break attempts
          case .appNeedsUpdate:
            pairing = .failed([PhoneWords.updatePhone])
          case .refused(_, let error):
            // The Inbox's own words, with the tries left on a wrong code.
            pairing = .failed([error.error] + (error.triesLeft.map { [PhoneWords.pairTriesLeft(Int($0))] } ?? []))
          case .notOffered:
            pairing = .failed([PhoneWords.updateComputer(address.hostPort)])
          }
          return false
        } catch {
          tried.append(PhoneWords.pairNoAnswer(address.hostPort))
          break attempts
        }
      }
    }
    pairing = .failed(tried)
    return false
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
    session?.stop()
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

  /// Remove this phone from the computer on screen and forget that computer here: its Keychain item and its copy.
  /// Another paired computer, if there is one, takes the screen.
  func removeThisPhone() async {
    guard let session else { return }
    self.session = nil
    if isDemo {
      defaults.removeObject(forKey: Self.demoKey)
      standIn = nil
      isDemo = false
    } else {
      try? credentials.remove(id: session.computer.id)
      computers.removeAll { $0.id == session.computer.id }
      await session.removeThisPhone()
    }
    if let next = computers.first { use(next) }
  }
}

/// What a launch may hand the app. `-pairLink` offers a pairing link as a link opened from outside does; the
/// `-standIn…` ones seat the stand-in computer for UI tests and screenshots and exist only in debug builds.
struct LaunchOptions {
  private let defaults = UserDefaults.standard
  var pairLink: String? { defaults.string(forKey: "pairLink") }
  var standIn: Bool { debug && defaults.bool(forKey: "standIn") }
  var standInFloor: Int? { debug && defaults.object(forKey: "standInFloor") != nil ? defaults.integer(forKey: "standInFloor") : nil }
  var standInRemoved: Bool { debug && defaults.bool(forKey: "standInRemoved") }
  var open: ThreadID? { debug ? defaults.string(forKey: "open").map { ThreadID($0) } : nil }
  var stageName: String? { debug ? defaults.string(forKey: "stage") : nil }

  private var debug: Bool {
    #if DEBUG
      return true
    #else
      return false
    #endif
  }

  #if DEBUG
    /// Put the stand-in in a state a screenshot needs, through the same calls a touch makes.
    @MainActor
    func stage(session: InboxSession, door: StandInDoor) async {
      guard let stageName else { return }
      func retry() -> (InboxMessageWire, InboxQuestion)? {
        guard let asked = session.thread(StandInData.retry)?.thread.messages.last(where: { $0.author.kind == .agent }), let question = asked.questions?.first else { return nil }
        return (asked, question)
      }
      func save(_ edit: CardAnswers.Edit, _ thread: ThreadID, _ message: MessageID, _ question: InboxQuestion) async {
        if case .save(let answer) = edit { await session.pick(thread: thread, message: message, question: question, answer: answer) }
      }
      for step in stageName.split(separator: ",") {
        switch step {
        case "open":
          await session.open(StandInData.retry)
        case "picked", "heldpick":
          if step == "picked" { await session.open(StandInData.retry) }
          if let (asked, question) = retry() { await save(CardAnswers.tap(question, label: "Staged, 10% first"), StandInData.retry, asked.id, question) }
        case "multi":
          await session.open(StandInData.checkout)
          for edit in ["One page", "Summary beside", "other", "note"] {
            guard let asked = session.thread(StandInData.checkout)?.thread.messages.last, let question = asked.questions?.first else { continue }
            switch edit {
            case "other": await save(CardAnswers.other(question, words: "A single page with a sticky total"), StandInData.checkout, asked.id, question)
            case "note": await save(CardAnswers.note(question, words: "Keep the summary but drop the promo box"), StandInData.checkout, asked.id, question)
            default: await save(CardAnswers.tap(question, label: edit), StandInData.checkout, asked.id, question)
            }
          }
        case "sent":
          await session.send(thread: StandInData.retry, words: "Go ahead, and tell me when the first 10% looks healthy.")
        case "heldsend":
          await session.send(thread: StandInData.retry, words: "Go ahead when it is back.")
        case "away":
          await door.setOffline(true)
          await session.refresh()
        case "permission":
          await door.add(StandInData.permissionThread(now: Date()))
          await session.refresh()
        case "long":
          // A 300-message thread, to measure how a long thread opens and scrolls.
          await door.add(StandInData.longThread(now: Date()))
          await door.add(StandInData.longPermissionThread(now: Date()))
          await session.refresh()
        case "writes":
          // Twenty seconds on, the long session's agent writes again and the long permission session asks a second
          // command (a test types meanwhile).
          Task {
            try? await Task.sleep(for: .seconds(20))
            await door.agentWrites(thread: StandInData.long, body: "While that waits: the other steps all passed.")
            if var asked = await door.thread(StandInData.longPermission)?.messages.last?.questions?.first {
              asked.key = "q_day_lint"
              let labels = asked.choices.map(\.label)
              await door.agentWrites(
                thread: StandInData.longPermission,
                body: "```\nbun run lint\n```\n\nPurpose: Check the style.\n\nin `~/work/api-server`\n\n:::question\n\(asked.prompt)\n\n" + labels.map { "- [ ] \($0)" }.joined(separator: "\n") + "\n:::",
                questions: [asked])
            }
            await session.refresh()
          }
        case "allowed":
          await session.open(StandInData.permission)
          if let asked = session.thread(StandInData.permission)?.thread.messages.last, let question = asked.questions?.first {
            await session.answerNow(thread: StandInData.permission, message: asked.id, question: question, answer: QuestionAnswer(v: 1, key: question.key, kind: .single, prompt: question.prompt, selected: [PermissionPrompt.allowOnce]))
          }
        case "back":
          // The computer answers again, and another device picked while the phone was away.
          await door.setOptions { $0.racesPicks = 1 }
          await door.setOffline(false)
          await session.refresh()
        case "online":
          await door.setOffline(false)
          await session.refresh()
        case "replaced":
          // The agent replaces the question the phone's held pick and Send answer.
          if let (asked, question) = retry() {
            var newer = question
            newer.key = "q_rollout2"
            newer.prompt = "Roll out to 10% or 25% first?"
            newer.choices = [InboxQuestionChoice(label: "10%", recommended: true, settled: false), InboxQuestionChoice(label: "25%", recommended: false, settled: false)]
            newer.answer = nil
            newer.state = .openValue
            newer.revision = 0
            await door.agentWrites(thread: StandInData.retry, body: "One more thing came up, so I asked this again.\n\n:::question\nRoll out to 10% or 25% first?\n\n- [ ] 10%\n- [ ] 25%\n:::", questions: [newer])
            let written = await door.thread(StandInData.retry)?.messages.last?.id
            await door.change(StandInData.retry) { thread in
              guard let at = thread.messages.firstIndex(where: { $0.id == asked.id }), let written else { return }
              thread.messages[at].questions?[0].state = .superseded
              thread.messages[at].questions?[0].supersededBy = InboxSupersededBy(messageId: written, key: "q_rollout2")
            }
          }
        case "outdated":
          // The computer was updated past this app after the phone last read it: the copy stays readable.
          await door.setOptions { $0.minAppContract = 99; $0.contract = 99 }
          await session.refresh()
        case "done":
          await session.open(StandInData.onboarding)
          if let asked = session.thread(StandInData.onboarding)?.thread.messages.first, let todo = ActionMarks.items(of: asked).first {
            await session.mark(action: todo, thread: StandInData.onboarding, message: asked.id, ActionMarks.Mark(.done))
          }
        case "refused":
          if let (asked, question) = retry() {
            let other = DoorClient(transport: StandInTransport(door: door), token: session.computer.token, app: AppIdentity(version: "0.1.0"))
            _ = try? await other.picks(asked.id, body: QuestionAnswers.pickBody(key: question.key, revision: question.revision, answer: QuestionAnswers.choice(question, selected: ["Everyone at once"], note: ""), idempotencyKey: UUID().uuidString))
            await save(CardAnswers.tap(question, label: "Staged, 10% first"), StandInData.retry, asked.id, question)
          }
        default: break
        }
      }
    }
  #endif
}
