import AppKit
import QuartzCore

/// The capture flight: the cut-out lifts off the frozen screen and flies into
/// its slot in the strip (or the panel's stage, for the first snapshot). Native
/// draws the flight; the page says where the slot is and shows the thumbnail
/// when the flight lands, then waits two frames before native removes its
/// layer, so there is no gap or double image at the hand-off.
final class Flight {
    private let window: NSWindow
    private let layer = CALayer()
    private var done = false

    init(image: CGImage, from: NSRect) {
        let screen = NSScreen.screens.first { $0.frame.intersects(from) } ?? NSScreen.withMouse
        let bounds = NSScreen.screens.reduce(screen.frame) { $0.union($1.frame) }
        window = NSWindow(contentRect: bounds, styleMask: [.borderless], backing: .buffered, defer: false)
        window.level = .statusBar
        window.isOpaque = false
        window.backgroundColor = .clear
        window.ignoresMouseEvents = true
        window.hasShadow = false
        window.sharingType = .none
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        let host = NSView(frame: NSRect(origin: .zero, size: bounds.size))
        host.wantsLayer = true
        window.contentView = host
        layer.contents = image
        layer.contentsGravity = .resizeAspectFill
        layer.masksToBounds = true
        layer.cornerRadius = 4
        layer.borderWidth = 0.5
        layer.borderColor = NSColor(white: 0, alpha: 0.12).cgColor
        layer.frame = from.offsetBy(dx: -bounds.minX, dy: -bounds.minY)
        host.layer?.addSublayer(layer)
        origin = bounds.origin
        window.orderFrontRegardless()
    }

    private let origin: CGPoint

    /// Fly to `target` (screen coordinates). `landed` runs when the motion ends.
    func fly(to target: NSRect, landed: @escaping () -> Void) {
        let end = target.offsetBy(dx: -origin.x, dy: -origin.y)
        CATransaction.begin()
        CATransaction.setCompletionBlock(landed)
        if Config.reduceMotion {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 1
            fade.toValue = 0
            fade.duration = 0.12
            layer.opacity = 0
            layer.add(fade, forKey: "fade")
        } else {
            let start = layer.frame
            let position = CASpringAnimation(keyPath: "position")
            position.fromValue = NSValue(point: CGPoint(x: start.midX, y: start.midY))
            position.toValue = NSValue(point: CGPoint(x: end.midX, y: end.midY))
            position.damping = 18
            position.stiffness = 170
            position.mass = 1
            position.initialVelocity = 0
            position.duration = min(0.45, position.settlingDuration)
            let bounds = CASpringAnimation(keyPath: "bounds")
            bounds.fromValue = NSValue(rect: CGRect(origin: .zero, size: start.size))
            bounds.toValue = NSValue(rect: CGRect(origin: .zero, size: end.size))
            bounds.damping = 18
            bounds.stiffness = 170
            bounds.duration = position.duration
            layer.frame = end
            layer.cornerRadius = 6
            layer.add(position, forKey: "position")
            layer.add(bounds, forKey: "bounds")
        }
        CATransaction.commit()
    }

    /// The page has shown the thumbnail: take the native copy away.
    func remove() {
        guard !done else { return }
        done = true
        window.orderOut(nil)
    }
}
