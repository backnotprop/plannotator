import AppKit

/// The capture overlay: one borderless, non-activating panel per display over
/// a frozen image of that display. The app you were in stays the active app
/// (its menu bar stays); the overlay holds the keyboard only while you select.
/// The toolbar at the bottom (CaptureToolbar) offers the same choices by click.
///
///   drag            a box (region): a Screen Capture
///   Space           pick a window instead (click or Return takes it), picture only
///   F               the whole display under the pointer
///   A               App Capture: pick a window, taken with its accessibility text
///   N               a centered box to adjust by keyboard (arrows move, ⇧ arrows resize)
///   Return          take the box (or the highlighted window)
///   Esc             cancel, leaving nothing behind
final class OverlayController {
    enum Mode { case region, window, app }
    enum Result {
        case region(FrozenDisplay, CGRect) // AppKit global rect
        /// `withText`: an App Capture (the window plus its accessibility text).
        case window(WindowInfo, FrozenDisplay?, withText: Bool)
        case display(FrozenDisplay)
        /// App Capture was chosen, but Accessibility has not been asked for yet.
        case needsAccessibility
        case cancelled
    }

    private(set) var mode: Mode = .region
    private var panels: [OverlayPanel] = []
    private var completion: ((Result) -> Void)?
    private let toolbar = CaptureToolbar()
    /// Accessibility is on, or was declined for this session ("Not now": the window without text).
    private let textAllowed: Bool
    let windows: [WindowInfo]
    var hoverWindow: WindowInfo? { didSet { panels.forEach { $0.overlay.needsDisplay = true } } }

    init(displays: [FrozenDisplay], startMode: Mode, textAllowed: Bool, completion: @escaping (Result) -> Void) {
        windows = Capture.windows()
        mode = startMode
        self.textAllowed = textAllowed
        self.completion = completion
        panels = displays.map { OverlayPanel(display: $0, controller: self) }
        toolbar.onPick = { [weak self] item in self?.pick(item) }
    }

    var windowNumbers: [Int] { panels.map(\.windowNumber) }

    func show() {
        for panel in panels { panel.orderFrontRegardless() }
        // The panel under the pointer takes the keys, without activating this app.
        let screen = NSScreen.withMouse
        (panels.first { $0.display.screen == screen } ?? panels.first)?.makeKey()
        NSCursor.crosshair.set()
        toolbar.show(on: screen, selected: toolbarItem)
        updateHover()
    }

    private var toolbarItem: CaptureToolbar.Item {
        switch mode {
        case .region: return .screen
        case .window: return .window
        case .app: return .app
        }
    }

    /// Space: a box ↔ a window (picture only).
    func toggleMode() {
        setMode(mode == .region ? .window : .region)
    }

    func setMode(_ next: Mode) {
        if next == .app && !textAllowed {
            // Accessibility is asked for only now, the way ⌥⇧⌘5 asks: the card needs the screen back.
            finish(.needsAccessibility)
            return
        }
        mode = next
        panels.forEach { $0.overlay.clearSelection() }
        toolbar.select(toolbarItem)
        updateHover()
    }

    private func pick(_ item: CaptureToolbar.Item) {
        switch item {
        case .cancel: finish(.cancelled)
        case .screen: setMode(.region)
        case .window: setMode(.window)
        case .app: setMode(.app)
        case .fullScreen:
            if let display = displayUnderMouse() { finish(.display(display)) }
        }
    }

    /// The pointer moved: the toolbar follows it to another display.
    func pointerMoved(on screen: NSScreen) {
        toolbar.follow(screen)
        updateHover()
    }

    /// A box is being dragged: the toolbar steps out of the way.
    func setDragging(_ dragging: Bool) {
        toolbar.setDragging(dragging)
    }

    func takeWindow(_ window: WindowInfo) {
        finish(.window(window, frozenDisplay(containing: window), withText: mode == .app))
    }

    func updateHover() {
        guard mode != .region else {
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
        toolbar.close()
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
        setAccessibilityLabel("Capture overlay. Drag a box for a Screen Capture, Space to pick a window, F for the whole screen, A for an App Capture with the window's text, Escape to cancel.")
    }

    func clearSelection() {
        selection = nil
        dragStart = nil
        keyboardBox = false
        needsDisplay = true
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

        if controller.mode != .region, let window = controller.hoverWindow {
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
                let name = [window.app, window.title].filter { !$0.isEmpty }.joined(separator: " — ")
                drawLabel(controller.mode == .app ? "\(name)  ·  App Capture, with its text" : name, at: CGPoint(x: rect.minX + 8, y: rect.maxY - 30))
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

    // MARK: Mouse

    override func mouseMoved(with event: NSEvent) {
        NSCursor.crosshair.set()
        controller.pointerMoved(on: display.screen)
        if controller.mode == .region, selection == nil { needsDisplay = true }
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeKey()
        if controller.mode != .region { return }
        keyboardBox = false
        dragStart = convert(event.locationInWindow, from: nil)
        selection = nil
        controller.setDragging(true)
    }

    override func mouseDragged(with event: NSEvent) {
        guard controller.mode == .region, let start = dragStart else { return }
        let point = convert(event.locationInWindow, from: nil)
        selection = CGRect(x: min(start.x, point.x), y: min(start.y, point.y), width: abs(point.x - start.x), height: abs(point.y - start.y)).intersection(bounds)
        needsDisplay = true
    }

    override func mouseUp(with event: NSEvent) {
        if controller.mode != .region {
            if let window = controller.hoverWindow { controller.takeWindow(window) }
            return
        }
        dragStart = nil
        guard let selection, selection.width >= 4, selection.height >= 4 else {
            self.selection = nil
            needsDisplay = true
            controller.setDragging(false)
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
            if controller.mode != .region, let window = controller.hoverWindow {
                controller.takeWindow(window)
            } else if let selection, selection.width >= 4, selection.height >= 4 {
                commitSelection(selection)
            }
        case 3: // F
            if let display = controller.displayUnderMouse() { controller.finish(.display(display)) }
        case 0: // A
            controller.setMode(.app)
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
