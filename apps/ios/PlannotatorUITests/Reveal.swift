import XCTest

extension XCUIApplication {
    /// An element of a list that may sit below the fold: a List creates only
    /// the rows on screen, so the proof scrolls until it is there. 9.2 (M6)
    /// is taller than the screen when a row's words wrap at a larger text
    /// size, or when the relay row says it is not available.
    func reveal(_ id: String, timeout: TimeInterval = 30) -> XCUIElement {
        let target = descendants(matching: .any).matching(identifier: id).firstMatch
        let deadline = Date().addingTimeInterval(timeout)
        while !(target.exists && target.isHittable), Date() < deadline {
            if !target.waitForExistence(timeout: 2) || !target.isHittable { swipeUp(velocity: .slow) }
        }
        return target
    }
}
