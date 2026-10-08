import Carbon
import Foundation

/// Global hotkeys through Carbon's RegisterEventHotKey: no Accessibility or
/// Input Monitoring permission (an event tap or a global key monitor would need
/// one). ⌥⇧⌘4 Screen Capture, ⌥⇧⌘5 App Capture, ⌥⇧⌘P show or hide the HUD.
final class HotKeys {
    enum Action: UInt32 {
        case screenCapture = 1
        case appCapture = 2
        case toggle = 3
    }

    private static var handler: ((Action) -> Void)?
    private var refs: [EventHotKeyRef] = []
    private var eventHandler: EventHandlerRef?
    private(set) var failures: [String] = []

    init(onPress: @escaping (Action) -> Void) {
        HotKeys.handler = onPress
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var id = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil, MemoryLayout<EventHotKeyID>.size, nil, &id)
            if let action = Action(rawValue: id.id) {
                DispatchQueue.main.async { HotKeys.handler?(action) }
            }
            return noErr
        }, 1, &spec, nil, &eventHandler)
        let modifiers = UInt32(optionKey | shiftKey | cmdKey)
        register(UInt32(kVK_ANSI_4), modifiers, .screenCapture, "⌥⇧⌘4")
        register(UInt32(kVK_ANSI_5), modifiers, .appCapture, "⌥⇧⌘5")
        register(UInt32(kVK_ANSI_P), modifiers, .toggle, "⌥⇧⌘P")
    }

    private func register(_ key: UInt32, _ modifiers: UInt32, _ action: Action, _ label: String) {
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(key, modifiers, EventHotKeyID(signature: OSType(0x504E5348), id: action.rawValue), GetApplicationEventTarget(), 0, &ref)
        if status == noErr, let ref {
            refs.append(ref)
        } else {
            failures.append(label)
            log("hotkey \(label) is taken by another app (\(status))")
        }
    }

    deinit {
        for ref in refs { UnregisterEventHotKey(ref) }
        if let eventHandler { RemoveEventHandler(eventHandler) }
    }
}
