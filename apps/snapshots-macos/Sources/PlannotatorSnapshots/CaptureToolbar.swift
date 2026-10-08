import AppKit

/// The capture overlay's toolbar, the way macOS's own ⌘⇧5 bar works: a small
/// floating bar at the bottom center of the display with the pointer, so the
/// two modes can be seen and clicked, not only typed.
///
///   [✕] │ [▢ Screen Capture  drag] [▭ Window  Space] [▣ Full Screen  F] │ [◫ App Capture  A]
///
/// It is its own panel ABOVE the overlay (one level higher), never part of the
/// frozen image: the freeze happens before it is shown, region crops come from
/// that image, and window captures are taken window by window. It never takes
/// the keyboard (the overlay keeps Esc, Space, F, A, N, arrows), hides while a
/// box is being dragged, and follows the pointer to another display.
final class CaptureToolbar {
    enum Item { case cancel, screen, window, fullScreen, app }

    private let panel: ToolbarPanel
    private let bar: ToolbarView
    private var screen: NSScreen?
    private var dragHidden = false
    var onPick: ((Item) -> Void)?

    init() {
        bar = ToolbarView()
        panel = ToolbarPanel(contentRect: NSRect(origin: .zero, size: bar.fittingSize), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.screenSaver.rawValue + 1)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.sharingType = .none
        panel.isReleasedWhenClosed = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true
        panel.allowsToolTipsWhenApplicationIsInactive = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.contentView = bar
        bar.onPick = { [weak self] item in self?.onPick?(item) }
    }

    /// Show it on `screen`, fading in (at once with Reduce Motion).
    func show(on screen: NSScreen, selected: Item) {
        bar.selected = selected
        place(on: screen)
        panel.alphaValue = Config.reduceMotion ? 1 : 0
        panel.orderFrontRegardless()
        fade(to: 1)
    }

    func select(_ item: Item) { bar.selected = item }

    /// The pointer moved to another display: the bar goes with it.
    func follow(_ screen: NSScreen) {
        guard screen != self.screen else { return }
        place(on: screen)
    }

    /// Out of the way while a box is dragged; back if the drag ends without a capture.
    func setDragging(_ dragging: Bool) {
        guard dragging != dragHidden else { return }
        dragHidden = dragging
        panel.ignoresMouseEvents = dragging
        fade(to: dragging ? 0 : 1)
    }

    func close() {
        panel.orderOut(nil)
    }

    private func place(on screen: NSScreen) {
        self.screen = screen
        let size = bar.fittingSize
        // Bottom center, clear of the Dock, like the system bar.
        let origin = NSPoint(x: (screen.frame.midX - size.width / 2).rounded(), y: (screen.visibleFrame.minY + 28).rounded())
        panel.setFrame(NSRect(origin: origin, size: size), display: true)
    }

    private func fade(to alpha: CGFloat) {
        if Config.reduceMotion {
            panel.alphaValue = alpha
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = alpha > 0 ? 0.16 : 0.1
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            panel.animator().alphaValue = alpha
        }
    }
}

final class ToolbarPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

/// The bar: vibrant glass, 48 pt tall, segments 36 pt tall inside 6 pt of padding.
private final class ToolbarView: NSVisualEffectView {
    static let padding: CGFloat = 6
    static let gap: CGFloat = 2
    static let separatorMargin: CGFloat = 6

    var onPick: ((CaptureToolbar.Item) -> Void)?
    var selected: CaptureToolbar.Item = .screen {
        didSet { segments.forEach { $0.isSelected = $0.item == selected } }
    }
    private var segments: [ToolbarSegment] = []
    private var separators: [NSView] = []

    init() {
        super.init(frame: .zero)
        material = .hudWindow
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        layer?.cornerRadius = 14
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = true
        setAccessibilityElement(true)
        setAccessibilityRole(.toolbar)
        setAccessibilityLabel("Capture")

        let groups: [[ToolbarSegment]] = [
            [ToolbarSegment(.cancel, symbol: "xmark", title: nil, key: nil, label: "Cancel", help: "Cancel (Esc)", radio: false)],
            [
                ToolbarSegment(.screen, symbol: "rectangle.dashed", title: "Screen Capture", key: "drag", label: "Screen Capture", help: "Screen Capture: drag a box. Picture only. (⌥⇧⌘4)", radio: true),
                ToolbarSegment(.window, symbol: "macwindow", title: "Window", key: "Space", label: "Window", help: "Screen Capture of one window: click a window. Picture only. (Space)", radio: true),
                ToolbarSegment(.fullScreen, symbol: "display", title: "Full Screen", key: "F", label: "Full Screen", help: "Screen Capture of this whole screen. (F)", radio: false),
            ],
            [ToolbarSegment(.app, symbol: "text.viewfinder", title: "App Capture", key: "A", label: "App Capture", help: "App Capture: click a window to take it with its text, for the agent to read. (A; ⌥⇧⌘5 takes the front window)", radio: true)],
        ]
        for (index, group) in groups.enumerated() {
            if index > 0 {
                let separator = NSView()
                separator.wantsLayer = true
                separator.layer?.backgroundColor = NSColor.separatorColor.cgColor
                separators.append(separator)
                addSubview(separator)
            }
            for segment in group {
                segment.onPress = { [weak self] in self?.onPick?(segment.item) }
                segments.append(segment)
                addSubview(segment)
            }
        }
        selected = .screen
        layoutSegments()
    }

    required init?(coder: NSCoder) { fatalError() }

    override var fittingSize: NSSize {
        let widths = segments.reduce(0) { $0 + $1.width } + CGFloat(segments.count - 1 - separators.count) * Self.gap
        let separatorsWidth = CGFloat(separators.count) * (1 + 2 * Self.separatorMargin)
        return NSSize(width: Self.padding * 2 + widths + separatorsWidth, height: Self.padding * 2 + ToolbarSegment.height)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        separators.forEach { $0.layer?.backgroundColor = NSColor.separatorColor.cgColor }
    }

    private func layoutSegments() {
        var x = Self.padding
        var separatorIndex = 0
        var previous: ToolbarSegment?
        for segment in segments {
            if let previous {
                // A new group starts after the cancel button and before App Capture.
                if (previous.item == .cancel || segment.item == .app), separatorIndex < separators.count {
                    x += Self.separatorMargin
                    separators[separatorIndex].frame = NSRect(x: x, y: Self.padding + (ToolbarSegment.height - 22) / 2, width: 1, height: 22)
                    separatorIndex += 1
                    x += 1 + Self.separatorMargin
                } else {
                    x += Self.gap
                }
            }
            segment.frame = NSRect(x: x, y: Self.padding, width: segment.width, height: ToolbarSegment.height)
            x += segment.width
            previous = segment
        }
    }
}

/// One segment: an SF Symbol, a title and its key, drawn on a rounded fill
/// that marks the current mode (and, lighter, the pointer over it).
private final class ToolbarSegment: NSView {
    static let height: CGFloat = 36
    private static let titleFont = NSFont.systemFont(ofSize: 13, weight: .medium)
    private static let keyFont = NSFont.systemFont(ofSize: 10.5, weight: .semibold)

    let item: CaptureToolbar.Item
    private let symbol: NSImage?
    private let title: String?
    private let key: String?
    private let radio: Bool
    var onPress: (() -> Void)?
    var isSelected = false {
        didSet {
            needsDisplay = true
            if radio { setAccessibilityValue(isSelected ? 1 : 0) }
        }
    }
    private var hovered = false { didSet { needsDisplay = true } }
    private var pressed = false { didSet { needsDisplay = true } }

    init(_ item: CaptureToolbar.Item, symbol: String, title: String?, key: String?, label: String, help: String, radio: Bool) {
        self.item = item
        self.symbol = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium))
        self.title = title
        self.key = key
        self.radio = radio
        super.init(frame: .zero)
        toolTip = help
        setAccessibilityElement(true)
        setAccessibilityRole(radio ? .radioButton : .button)
        setAccessibilityLabel(label)
        setAccessibilityHelp(help)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self, userInfo: nil))
    }

    required init?(coder: NSCoder) { fatalError() }

    var width: CGFloat {
        guard let title else { return Self.height }
        var width: CGFloat = 10 + 16 + 6 + (title as NSString).size(withAttributes: [.font: Self.titleFont]).width.rounded(.up)
        if let key { width += 7 + keySize(key).width }
        return width + 10
    }

    private func keySize(_ key: String) -> NSSize {
        let text = (key as NSString).size(withAttributes: [.font: Self.keyFont])
        return NSSize(width: (text.width + 10).rounded(.up), height: 18)
    }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func cursorUpdate(with event: NSEvent) { NSCursor.arrow.set() }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func mouseDown(with event: NSEvent) { pressed = true }
    override func mouseDragged(with event: NSEvent) { pressed = bounds.contains(convert(event.locationInWindow, from: nil)) }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        if inside { onPress?() }
    }

    override func accessibilityPerformPress() -> Bool {
        onPress?()
        return true
    }

    override func draw(_ dirtyRect: NSRect) {
        let fillAlpha: CGFloat = pressed ? 0.22 : isSelected ? 0.16 : hovered ? 0.08 : 0
        if fillAlpha > 0 {
            NSColor.labelColor.withAlphaComponent(fillAlpha).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 9, yRadius: 9).fill()
        }
        let strong = isSelected || pressed || hovered
        let color: NSColor = strong ? .labelColor : .secondaryLabelColor
        var x: CGFloat = title == nil ? (bounds.width - 16) / 2 : 10
        if let symbol {
            let tinted = symbol.withSymbolConfiguration(.init(paletteColors: [color])) ?? symbol
            let size = tinted.size
            let scale = min(16 / size.width, 16 / size.height, 1)
            let drawn = NSSize(width: size.width * scale, height: size.height * scale)
            tinted.draw(in: NSRect(x: x + (16 - drawn.width) / 2, y: (bounds.height - drawn.height) / 2, width: drawn.width, height: drawn.height))
        }
        x += 16 + 6
        guard let title else { return }
        let titleText = NSAttributedString(string: title, attributes: [.font: Self.titleFont, .foregroundColor: color])
        let titleSize = titleText.size()
        titleText.draw(at: NSPoint(x: x, y: ((bounds.height - titleSize.height) / 2).rounded()))
        x += titleSize.width.rounded(.up) + 7
        guard let key else { return }
        let box = NSRect(origin: NSPoint(x: x, y: ((bounds.height - 18) / 2).rounded()), size: keySize(key))
        NSColor.labelColor.withAlphaComponent(0.1).setFill()
        NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
        let keyText = NSAttributedString(string: key, attributes: [.font: Self.keyFont, .foregroundColor: NSColor.secondaryLabelColor])
        let keySize = keyText.size()
        keyText.draw(at: NSPoint(x: box.midX - keySize.width / 2, y: box.midY - keySize.height / 2))
    }
}
