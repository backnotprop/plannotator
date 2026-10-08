import Foundation
import PlannotatorKit
import UserNotifications

/// The notification service extension (contract section 4, "Push"): opens a
/// relay push with this phone's device keys from the shared Keychain group and
/// writes what renders 7.1 and 7.2 draw. The relay only ever sees ciphertext.
///
/// The system calls it once per push, on its own queue; it holds that one
/// push's content until the content handler has it.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var deliver: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private var fallback: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
        deliver = contentHandler
        self.content = content
        fallback = plain(content)
        Task {
            guard let content = self.content else { return }
            let devices = Keychain.all().map { (id: $0.device, secret: $0.credential.secret) }
            let dressed = await PushNotification.dress(content, devices: devices, answersOnLockScreen: NotificationSettings.answerOnLockScreen, center: .current())
            self.finish(dressed)
        }
    }

    /// Out of time: the plain words, never the relay's generic alert.
    override func serviceExtensionTimeWillExpire() {
        if let fallback { finish(fallback) }
    }

    /// The dressed content and the time-out fallback race to here from two
    /// threads; the lock lets exactly one reach the system.
    private let lock = NSLock()

    private func finish(_ content: UNNotificationContent) {
        lock.lock()
        let handler = deliver
        deliver = nil
        lock.unlock()
        handler?(content)
    }

    private func plain(_ content: UNNotificationContent) -> UNMutableNotificationContent {
        let plain = (content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
        plain.title = "Plannotator"
        plain.body = PushNotification.hiddenPreviewBody
        plain.categoryIdentifier = PushNotification.messageCategory
        // Only the envelope, for the app to open if it is in front; nothing the relay put beside it.
        plain.userInfo = (content.userInfo["e"] as? String).map { ["e": $0] } ?? [:]
        return plain
    }
}
