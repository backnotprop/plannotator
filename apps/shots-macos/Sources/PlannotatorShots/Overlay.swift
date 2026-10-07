import AppKit

/// The capture overlay: one borderless, non-activating panel per display over
/// a frozen image of that display. The app you were in stays the active app
/// (its menu bar stays); the overlay holds the keyboard only while you select.
///
///   drag            a box (region)
///   Space           pick a window instead (click or Return takes it)
///   F               the whole display under the pointer
///   N               a centered box to adjust by keyboard (arrows move, ⇧ arrows resize)
///   Return          take the box (or the highlighted window)
///   Esc             cancel, leaving nothing behind
final class OverlayController {
    enum Mode { case region, window }
    enum Result {
        case region(FrozenDisplay, CGRect) // AppKit global rect
        case window(WindowInfo, FrozenDisplay?)
        case display(FrozenDisplay)
        case cancelled
    }

    private(set) var mode: Mode = .region
    private var panels: [OverlayPanel] = []
    private var completion: ((Result) -> Void)?
    let windows: [WindowInfo]
    var hoverWindow: WindowInfo? { didSet { panels.forEach { $0.overlay.needsDisplay = true } } }

    init(displays: [FrozenDisplay], startInWindowMode: Bool, completion: @escaping (Result) -> Void) {
        windows = Capture.windows()
        mode = startInWindowMode ? .window : .region
        self.completion = completion
        panels = displays.map { OverlayPanel(display: $0, controller: self) }
    }

    var windowNumbers: [Int] { panels.map(\.windowNumber) }

    func show() {
        for panel in panels { panel.orderFrontRegardless() }
        // The panel under the pointer takes the keys, without activating this app.
        let screen = NSScreen.withMouse
        (panels.first { $0.display.screen == screen } ?? panels.first)?.makeKey()
        NSCursor.crosshair.set()
        updateHover()
    }

    func toggleMode() {
        mode = mode == .region ? .window : .region
        panels.forEach { $0.overlay.selection = nil; $0.overlay.needsDisplay = true }
        updateHover()
    }

    func updateHover() {
        guard mode == .window else {
            hoverWindow = nil
            return
        }
        let point = NSEvent.mouseLocation
        let global = CGPoint(x: point.x, y: Coords.primaryHeight - point.y)
        let next = windows.first { $0.bounds.contains(global) }
        if next?.id != hoverWindow?.id { hoverWindow = next }
    }

    func displayUnderMouse() -> FrozenDisplay? {
        let screen = NSScreen.withMouse
        return panels.first { $0.display.screen == screen }?.display ?? panels.first?.display
    }

    func finish(_ result: Result) {
        guard let completion else { return }
        self.completion = nil
        for panel in panels { panel.orderOut(nil) }
        NSCursor.arrow.set()
        panels = []
        completion(result)
    }

    func frozenDisplay(containing window: WindowInfo) -> FrozenDisplay? {
        let rect = Coords.toAppKit(window.bounds)
        return panels.map(\.display).max { $0.screen.frame.intersection(rect).area < $1.screen.frame.intersection(rect).area }
    }
}

private extension CGRect {
    var area: CGFloat { isNull ? 0 : width * height }
}

final class OverlayPanel: NSPanel {
    let display: FrozenDisplay
    let overlay: OverlayView

    init(display: FrozenDisplay, controller: OverlayController) {
        self.display = display
        overlay = OverlayView(display: display, controller: controller)
        super.init(contentRect: display.screen.frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        level = .screenSaver
        isOpaque = true
        backgroundColor = .black
        hasShadow = false
        sharingType = .none
        isReleasedWhenClosed = false
        acceptsMouseMovedEvents = true
        hidesOnDeactivate = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        setFrame(display.screen.frame, display: false)
        contentView = overlay
        overlay.frame = NSRect(origin: .zero, size: display.screen.frame.size)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class OverlayView: NSView {
    let display: FrozenDisplay
    unowned let controller: OverlayController
    var selection: CGRect? // local view coordinates
    private var dragStart: CGPoint?
    private var keyboardBox = false

    init(display: FrozenDisplay, controller: OverlayController) {
        self.display = display
        self.controller = controller
        super.init(frame: .zero)
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .activeAlways, .inVisibleRect, .cursorUpdate], owner: self, userInfo: nil)
        addTrackingArea(area)
        setAccessibilityRole(.layoutArea)
        setAccessibilityLabel("Capture overlay. Drag a box, Space to pick a window, F for the whole screen, Escape to cancel.")
    }

    required init?(coder: NSCoder) { fatalError() }

    override var acceptsFirstResponder: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func cursorUpdate(with event: NSEvent) { NSCursor.crosshair.set() }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.interpolationQuality = .high
        ctx.draw(display.image, in: bounds)
        let veil = NSColor(white: 0, alpha: controller.mode == .region && selection != nil ? 0.30 : 0.18)

        if controller.mode == .window, let window = controller.hoverWindow {
            let rect = Coords.toAppKit(window.bounds).offsetBy(dx: -display.screen.frame.minX, dy: -display.screen.frame.minY)
            veil.setFill()
            let path = NSBezierPath(rect: bounds)
            path.append(NSBezierPath(rect: rect).reversed)
            path.fill()
            NSColor.controlAccentColor.withAlphaComponent(0.16).setFill()
            rect.fill()
            NSColor.controlAccentColor.setStroke()
            let outline = NSBezierPath(rect: rect.insetBy(dx: 1, dy: 1))
            outline.lineWidth = 2
            outline.stroke()
            if rect.intersects(bounds) {
                drawLabel([window.app, window.title].filter { !$0.isEmpty }.joined(separator: " — "), at: CGPoint(x: rect.minX + 8, y: rect.maxY - 30))
            }
        } else if let selection {
            veil.setFill()
            let path = NSBezierPath(rect: bounds)
            path.append(NSBezierPath(rect: selection).reversed)
            path.fill()
            NSColor.white.setStroke()
            let outline = NSBezierPath(rect: selection.insetBy(dx: -0.75, dy: -0.75))
            outline.lineWidth = 1.5
            outline.stroke()
            let w = Int((selection.width * display.scale).rounded())
            let h = Int((selection.height * display.scale).rounded())
            drawLabel("\(w) × \(h) px", at: CGPoint(x: selection.maxX - 90, y: selection.minY - 26), alignRight: selection.maxX)
        } else {
            veil.setFill()
            bounds.fill()
            if controller.mode == .region, let mouse = window?.mouseLocationOutsideOfEventStream, bounds.contains(mouse) {
                NSColor(white: 1, alpha: 0.65).setFill()
                NSRect(x: 0, y: mouse.y.rounded() - 0.5, width: bounds.width, height: 1).fill()
                NSRect(x: mouse.x.rounded() - 0.5, y: 0, width: 1, height: bounds.height).fill()
                let px = Int(mouse.x * display.scale), py = Int((bounds.height - mouse.y) * display.scale)
                drawLabel("\(px), \(py)", at: CGPoint(x: mouse.x + 12, y: mouse.y - 28))
            }
        }
        drawHint()
    }

    private func drawLabel(_ text: String, at point: CGPoint, alignRight: CGFloat? = nil) {
        let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11, weight: .semibold), .foregroundColor: NSColor.white]
        let size = (text as NSString).size(withAttributes: attributes)
        var origin = point
        if let right = alignRight { origin.x = right - size.width - 14 + 1 }
        let box = NSRect(x: origin.x, y: origin.y, width: size.width + 14, height: 20)
        NSColor(white: 0, alpha: 0.66).setFill()
        NSBezierPath(roundedRect: box, xRadius: 5, yRadius: 5).fill()
        (text as NSString).draw(at: CGPoint(x: box.minX + 7, y: box.minY + 3), withAttributes: attributes)
    }

    private func drawHint() {
        let segments: [(key: String, text: String)] = controller.mode == .region
            ? [("drag", "a box"), ("Space", "window"), ("F", "screen"), ("Esc", "cancel")]
            : [("click", "a window"), ("Space", "box"), ("F", "screen"), ("Esc", "cancel")]
        let keyFont = NSFont.systemFont(ofSize: 11, weight: .medium)
        let textFont = NSFont.systemFont(ofSize: 12, weight: .medium)
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let fg = dark ? NSColor(white: 0.96, alpha: 1) : NSColor(white: 0.11, alpha: 1)
        var width: CGFloat = 14
        var parts: [(NSAttributedString, NSAttributedString)] = []
        for segment in segments {
            let key = NSAttributedString(string: segment.key, attributes: [.font: keyFont, .foregroundColor: fg])
            let text = NSAttributedString(string: segment.text, attributes: [.font: textFont, .foregroundColor: fg])
            parts.append((key, text))
            width += key.size().width + 10 + 4 + text.size().width + 14
        }
        let pill = NSRect(x: (bounds.width - width) / 2, y: bounds.height - 40 - 32, width: width, height: 32)
        (dark ? NSColor(white: 0.16, alpha: 0.86) : NSColor(white: 0.96, alpha: 0.88)).setFill()
        NSBezierPath(roundedRect: pill, xRadius: 16, yRadius: 16).fill()
        var x = pill.minX + 14
        for (key, text) in parts {
            let keyBox = NSRect(x: x, y: pill.midY - 9, width: key.size().width + 10, height: 18)
            (dark ? NSColor(white: 1, alpha: 0.12) : NSColor(white: 0, alpha: 0.08)).setFill()
            NSBezierPath(roundedRect: keyBox, xRadius: 4, yRadius: 4).fill()
            key.draw(at: CGPoint(x: keyBox.minX + 5, y: keyBox.minY + 2))
            x = keyBox.maxX + 4
            text.draw(at: CGPoint(x: x, y: pill.midY - text.size().height / 2))
            x += text.size().width + 14
        }
    }

    // MARK: Mouse

    override func mouseMoved(with event: NSEvent) {
        NSCursor.crosshair.set()
        controller.updateHover()
        if controller.mode == .region, selection == nil { needsDisplay = true }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        if controller.mode == .window { return }
        keyboardBox = false
        dragStart = convert(event.locationInWindow, from: nil)
        selection = nil
    }

    override func mouseDragged(with event: NSEvent) {
        guard controller.mode == .region, let start = dragStart else { return }
        let point = convert(event.locationInWindow, from: nil)
        selection = CGRect(x: min(start.x, point.x), y: min(start.y, point.y), width: abs(point.x - start.x), height: abs(point.y - start.y)).intersection(bounds)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if controller.mode == .window {
            if let window = controller.hoverWindow { controller.finish(.window(window, controller.frozenDisplay(containing: window))) }
            return
        }
        dragStart = nil
        guard let selection, selection.width >= 4, selection.height >= 4 else {
            self.selection = nil
            needsDisplay = true
            return
        }
        commitSelection(selection)
    }

    private func commitSelection(_ rect: CGRect) {
        controller.finish(.region(display, rect.offsetBy(dx: display.screen.frame.minX, dy: display.screen.frame.minY)))
    }

    // MARK: Keys

    override func keyDown(with event: NSEvent) {
        let shift = event.modifierFlags.contains(.shift)
        switch event.keyCode {
        case 53: // Esc
            if keyboardBox || selection != nil, controller.mode == .region {
                selection = nil
                keyboardBox = false
                needsDisplay = true
            } else {
                controller.finish(.cancelled)
            }
        case 49: // Space
            controller.toggleMode()
        case 36, 76: // Return
            if controller.mode == .window, let window = controller.hoverWindow {
                controller.finish(.window(window, controller.frozenDisplay(containing: window)))
            } else if let selection, selection.width >= 4, selection.height >= 4 {
                commitSelection(selection)
            }
        case 3: // F
            if let display = controller.displayUnderMouse() { controller.finish(.display(display)) }
        case 45: // N
            if controller.mode == .region {
                keyboardBox = true
                selection = CGRect(x: bounds.midX - 200, y: bounds.midY - 120, width: 400, height: 240)
                needsDisplay = true
            }
        case 123, 124, 125, 126:
            guard var box = selection else { return }
            let step: CGFloat = event.modifierFlags.contains(.option) ? 10 : 2
            let dx: CGFloat = event.keyCode == 123 ? -step : event.keyCode == 124 ? step : 0
            let dy: CGFloat = event.keyCode == 125 ? -step : event.keyCode == 126 ? step : 0
            if shift {
                box.size.width = max(8, box.width + dx)
                box.size.height = max(8, box.height - dy)
                box.origin.y += dy
            } else {
                box = box.offsetBy(dx: dx, dy: dy)
            }
            selection = box.intersection(bounds)
            needsDisplay = true
        default:
            super.keyDown(with: event)
        }
    }
}
