import Foundation
import UserNotifications

/// What the notification service extension does to a push from the relay
/// (contract section 4, "Push"; renders 7.1 and 7.2), and what the app reads
/// back when the person acts on it.
public enum PushNotification {
    /// Every notification's category. With previews hidden the lock screen
    /// shows only "Question from an agent": no subject, no agent text.
    public static let messageCategory = "message"
    public static let hiddenPreviewBody = "Question from an agent"
    /// `userInfo` keys the extension writes for the app.
    public static let deviceKey = "device"
    public static let summaryKey = "summary"

    /// The plain category, registered by the app at launch and kept by the extension.
    public static var plainCategory: UNNotificationCategory {
        UNNotificationCategory(identifier: messageCategory, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: hiddenPreviewBody, options: [])
    }

    /// A question's own category: its choices as actions, recommended first,
    /// each `choice.<n>` and asking for Face ID or the passcode first (7.2).
    public static func category(for summary: PushSummary) -> UNNotificationCategory? {
        let actions = summary.actions.map { choice in
            UNNotificationAction(identifier: "choice.\(choice.index)", title: choice.label, options: [.authenticationRequired], icon: UNNotificationActionIcon(systemImageName: "arrow.up.circle"))
        }
        guard !actions.isEmpty else { return nil }
        return UNNotificationCategory(identifier: "question.\(summary.messageId)", actions: actions, intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: hiddenPreviewBody, options: [])
    }

    /// The extension's work: open `e` with the paired devices' keys, write the
    /// subject and "<agent> in <project>", and give a single-choice question its
    /// choices. A push no key opens reads "Question from an agent".
    nonisolated(nonsending) public static func dress(_ content: UNMutableNotificationContent, devices: [(id: String, secret: String)], answersOnLockScreen: Bool, center: UNUserNotificationCenter) async -> UNNotificationContent {
        content.categoryIdentifier = messageCategory
        guard let envelope = content.userInfo["e"] as? String, let opened = PushSummary.open(envelope, devices: devices) else {
            content.title = "Plannotator"
            content.body = hiddenPreviewBody
            // Nothing of it is kept: no envelope to try again (the app would
            // dress it once more, forever), no plaintext the relay put beside it.
            content.userInfo = [:]
            await keep(nil, center: center)
            return content
        }
        let summary = opened.summary
        content.title = summary.title
        content.body = summary.body.isEmpty ? hiddenPreviewBody : summary.body
        content.threadIdentifier = summary.threadId
        content.userInfo = userInfo(device: opened.device, summary: summary)
        let question = answersOnLockScreen ? category(for: summary) : nil
        if let question { content.categoryIdentifier = question.identifier }
        await keep(question, center: center)
        return content
    }

    /// Registers the plain category and a question's own, and drops the
    /// question categories no delivered notification uses any more, so they
    /// do not pile up.
    nonisolated(nonsending) public static func keep(_ question: UNNotificationCategory?, center: UNUserNotificationCenter) async {
        let delivered = Set(await center.deliveredNotifications().map(\.request.content.categoryIdentifier))
        var categories = await center.notificationCategories().filter { $0.identifier != messageCategory && delivered.contains($0.identifier) }
        categories.insert(plainCategory)
        if let question { categories.update(with: question) }
        center.setNotificationCategories(categories)
        // setNotificationCategories applies asynchronously: read back so the
        // category is in place before the content is handed to the system.
        _ = await center.notificationCategories()
    }

    /// What a dressed notification carries for the app: the device and the summary.
    public static func userInfo(device: String, summary: PushSummary) -> [AnyHashable: Any] {
        guard let data = try? InboxClient.encoder.encode(summary) else { return [:] }
        return [deviceKey: device, summaryKey: String(decoding: data, as: UTF8.self)]
    }

    /// The summary and device the extension stored on a delivered notification.
    public static func read(_ userInfo: [AnyHashable: Any]) -> (device: String, summary: PushSummary)? {
        guard let device = userInfo[deviceKey] as? String, let text = userInfo[summaryKey] as? String,
              let summary = try? InboxClient.decoder.decode(PushSummary.self, from: Data(text.utf8)) else { return nil }
        return (device, summary)
    }

    /// A push the extension did not dress (it ran out of time, or a simulator
    /// push, which never runs extensions) still carries its envelope.
    public static func isUndressed(_ userInfo: [AnyHashable: Any]) -> Bool {
        userInfo["e"] is String && userInfo[summaryKey] == nil
    }
}

/// The two switches of 9.1, kept where the extension can read them.
public enum NotificationSettings {
    static var defaults: UserDefaults { UserDefaults(suiteName: Keychain.group) ?? .standard }

    /// "Allow notifications": the person's own switch (the system's permission is read separately).
    public static var allow: Bool {
        get { defaults.bool(forKey: "notifications.allow") }
        set { defaults.set(newValue, forKey: "notifications.allow") }
    }

    /// "Answer from the lock screen", on unless the person turned it off.
    public static var answerOnLockScreen: Bool {
        get { defaults.object(forKey: "notifications.lockScreen") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "notifications.lockScreen") }
    }
}
