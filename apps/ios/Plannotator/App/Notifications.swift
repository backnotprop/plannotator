import Observation
import PlannotatorKit
import UIKit
import UserNotifications

/// Notifications on this phone (renders 7.1, 7.2 and 9.1's two switches):
/// the system's permission, asked once from "Allow notifications" and never
/// at launch; the APNs token, registered at each paired computer's relay
/// with this phone's relay secret (exchange 7.29); the answers the person
/// gives from a notification.
@Observable
final class Notifier {
    /// The system lets this app notify.
    private(set) var permitted = false
    private(set) var token: String?

    /// "Allow notifications": the person's switch, shown on only while the system permits it.
    var allowed: Bool { permitted && NotificationSettings.allow }

    /// "Answer from the lock screen" (read by the extension through the app group).
    var answerOnLockScreen = NotificationSettings.answerOnLockScreen {
        didSet { NotificationSettings.answerOnLockScreen = answerOnLockScreen }
    }

    private let center = UNUserNotificationCenter.current()

    /// At launch and on every return to the front: what the system allows now
    /// (the person may have changed it in Settings), and the token when allowed.
    func refresh() async {
        permitted = Self.permits(await center.notificationSettings().authorizationStatus)
        if allowed { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// The switch. On: the system's prompt the first time, the app's page in
    /// Settings when the person said no there before. Off: the token leaves
    /// every relay, so no push is sent to this phone.
    func setAllowed(_ on: Bool, sources: [Source]) async {
        guard on else {
            NotificationSettings.allow = false
            for source in sources { await register(source, token: nil) }
            return
        }
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            permitted = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        case .denied:
            // The switch turns on by itself when the person comes back having allowed it there.
            NotificationSettings.allow = true
            if let url = URL(string: UIApplication.openNotificationSettingsURLString) { await UIApplication.shared.open(url) }
            return
        default:
            permitted = true
        }
        NotificationSettings.allow = permitted
        if permitted { UIApplication.shared.registerForRemoteNotifications() }
    }

    /// iOS handed over the APNs token: every paired computer's relay gets it.
    func registered(_ data: Data, sources: [Source]) async {
        token = data.map { String(format: "%02x", $0) }.joined()
        for source in sources { await register(source, token: token) }
    }

    /// A computer paired while notifications are on gets the token too.
    func paired(_ source: Source) async {
        if allowed, let token { await register(source, token: token) }
    }

    private func register(_ source: Source, token: String?) async {
        guard let relay = source.relay, let credential = Keychain.load(device: source.id),
              let client = RelayClient(relay: relay, device: source.id, secret: credential.secret) else { return }
        try? await client.registerAPNs(token: token, environment: Self.environment)
    }

    /// The APNs environment this build's entitlement names.
    static var environment: String {
        #if DEBUG
        "sandbox"
        #else
        "production"
        #endif
    }

    static func permits(_ status: UNAuthorizationStatus) -> Bool {
        status == .authorized || status == .provisional || status == .ephemeral
    }
}

/// The app's delegate: push registration and the notification center's callbacks.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    let model = AppModel()

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        Task {
            await PushNotification.keep(nil, center: center)
            await model.notifier.refresh()
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        // Each paired computer's relay, and Workspaces' device door (M7) when signed in.
        model.pushToken = deviceToken
        Task { await model.notifier.registered(deviceToken, sources: model.sources) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    /// In the front: shown as a banner. A push the extension did not dress is
    /// dressed here first, with the same code, so it never reads as the
    /// relay's generic words.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        // A push is one of the moments the app reads again (on the relay path the
        // only one besides the person's own). On a phone the extension has already
        // dressed it, which replaces the envelope `e` with the summary; a push it
        // did not dress (the simulator never runs extensions) still carries `e`.
        if PushNotification.read(content.userInfo) != nil || content.userInfo["e"] != nil, let session = model.session {
            Task { await session.reconnect() }
        }
        guard PushNotification.isUndressed(content.userInfo), let mutable = content.mutableCopy() as? UNMutableNotificationContent else { return [.banner, .list, .sound] }
        // Answer the system at once; the dressed copy follows as its own notification.
        let identifier = notification.request.identifier
        Task {
            let devices = Keychain.all().map { (id: $0.device, secret: $0.credential.secret) }
            let dressed = await PushNotification.dress(mutable, devices: devices, answersOnLockScreen: NotificationSettings.answerOnLockScreen, center: center)
            try? await center.add(UNNotificationRequest(identifier: identifier, content: dressed, trigger: nil))
        }
        return []
    }

    /// A tap opens the thread; a choice (7.2) picks and sends at once.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        let devices = { Keychain.all().map { (id: $0.device, secret: $0.credential.secret) } }
        guard let (device, summary) = PushNotification.read(info) ?? (info["e"] as? String).flatMap({ PushSummary.open($0, devices: devices()) }) else { return }
        let action = response.actionIdentifier
        if action == UNNotificationDefaultActionIdentifier {
            model.open(thread: summary.threadId, device: device)
        } else if action.hasPrefix("choice."), let index = Int(action.dropFirst("choice.".count)) {
            await model.answer(summary, choice: index, device: device)
        }
    }
}

extension AppModel {
    /// A tapped notification: its computer shown, its thread pushed.
    func open(thread id: String, device: String) {
        guard let source = sources.first(where: { $0.id == device }) else { return }
        show(source)
        // Next turn, once the Inbox tab has followed the change of source.
        Task { opening = ThreadRoute(id: id) }
    }

    /// A choice tapped on a notification (7.2): one Send with the pick inside
    /// it (exchange 7.11), to the computer directly when the Wi-Fi or the
    /// tailnet answers (both asked at once, 3 s), else up through the relay
    /// with the same idempotency key (section 6), so it is applied once either
    /// way. Each step has a short wait, so the whole answer fits well inside
    /// the background time iOS gives an action (about 30 s): 3 s, then 5 s
    /// directly or 5 s to the relay. One the relay holds for an offline
    /// computer waits there, and its thread says so (owner item 26). A Send
    /// that lands nowhere says so in a notification of its own, so the person
    /// never believes an answer went that did not.
    func answer(_ summary: PushSummary, choice index: Int, device: String) async {
        guard let question = summary.question, question.choices.indices.contains(index),
              let source = sources.first(where: { $0.id == device }), let credential = Keychain.load(device: device) else { return }
        let label = question.choices[index].label
        let pick = QuestionAnswer(key: question.key, kind: "single", prompt: question.prompt, selected: [label])
        // One key per message and choice: a different choice later is a new Send, never the first one's replay.
        let keyName = "lock-screen|\(summary.messageId)|\(index)"
        let send = InboxClient.ReplyBody(
            idempotencyKey: SendKeys.key(source: device, message: keyName),
            words: "",
            questions: [.init(key: question.key, revision: question.revision, answer: pick)]
        )
        if let direct = await InboxClient.firstReachable(source.directClients(token: credential.token)).client {
            do throws(InboxError) {
                _ = try await direct.reply(message: summary.messageId, send, timeout: 5)
                SendKeys.clear(source: device, message: keyName)
                if session?.id == device {
                    await session?.refresh()
                    await session?.loadThread(summary.threadId)
                }
                return
            } catch where error.isDefinite {
                SendKeys.clear(source: device, message: keyName)
                let words = session?.id == device ? session?.notSent(error) : nil
                await tell(summary, device: device, words.map { "“\(label)”: \($0)" } ?? "“\(label)” was not sent. \(error.message)")
                return
            } catch {
                // No answer directly: the relay next, with the same key.
            }
        }
        guard relayOn(source), let relay = source.relay.flatMap({ RelayClient(relay: $0, device: device, secret: credential.secret) }),
              let carried = try? await relay.reply(message: summary.messageId, send, timeout: 5) else {
            // No definite answer from the computer or the relay: the Send may have landed before the connection died.
            await tell(summary, device: device, "“\(label)” may not have been sent: your computer can't be reached. Open the thread to check.")
            return
        }
        // The relay holds it under its key until the Inbox applies it; the thread shows it waiting until the reply lands.
        SendKeys.clear(source: device, message: keyName)
        PendingSend.add(PendingSend(source: device, thread: summary.threadId, message: summary.messageId, key: send.idempotencyKey, words: label, body: send))
        if session?.id == device { session?.reloadPending() }
        if !carried.inboxOnline { await tell(summary, device: device, "“\(label)” sent. Waiting for your computer.") }
    }

    /// A word about a lock-screen answer, as a notification that opens its thread.
    private func tell(_ summary: PushSummary, device: String, _ words: String) async {
        var plain = summary
        plain.question = nil
        let content = UNMutableNotificationContent()
        content.title = summary.title
        content.body = words
        content.threadIdentifier = summary.threadId
        content.categoryIdentifier = PushNotification.messageCategory
        content.userInfo = PushNotification.userInfo(device: device, summary: plain)
        try? await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "answer-\(summary.messageId)", content: content, trigger: nil))
    }
}
