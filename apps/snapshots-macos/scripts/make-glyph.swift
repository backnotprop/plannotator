// The menu-bar template image, built for the pixel grid.
//  - 18 px (@1x): authored pixel by pixel. Straight edges are whole pixels; the lens is an 11 px
//    disc sampled at pixel centres, with partial alpha only where the curve crosses a pixel.
//  - 36 px (@2x): the same geometry at twice the size, every straight edge on a whole pixel,
//    curves antialiased by 16× supersampling.
import AppKit

let out = CommandLine.arguments[1]

func write(_ alpha: [[Double]], _ path: String) {
    let n = alpha.count
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: n, pixelsHigh: n, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    for y in 0..<n { for x in 0..<n { rep.setColor(NSColor(deviceRed: 0, green: 0, blue: 0, alpha: CGFloat(alpha[y][x])), atX: x, y: y) } }
    try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

// The shape, in 18-pt units (y down). Coverage of a point.
// Body: x 1…10, y 7…15 (bottom edge at 15), small rounded outer corners.
// Prism: x 3…6, y 5…7.
// Lens: disc centre (11.5, 9.5), radius 5.5; glass (hole) radius 2.5.
func inside(_ x: Double, _ y: Double, scale s: Double) -> Bool {
    let lx = x - 11.5, ly = y - 9.5
    let d = (lx * lx + ly * ly).squareRoot()
    if d < 2.5 { return false }                               // the glass
    if s >= 2, (x - 10.4) * (x - 10.4) + (y - 8.4) * (y - 8.4) < 0.36 { return false == true } // (glint drawn separately)
    if d <= 5.5 { return true }                               // the lens
    if x >= 3 && x <= 6 && y >= 5 && y <= 7 { return true }  // the prism
    if x >= 1 && x <= 10.5 && y >= 7 && y <= 15 {             // the body
        let r = 1.0
        for (cx, cy) in [(1 + r, 7 + r), (1 + r, 15 - r)] {
            let inCorner = (x < cx) && ((cy < 10) ? (y < cy) : (y > cy))
            if inCorner && (x - cx) * (x - cx) + (y - cy) * (y - cy) > r * r { return false }
        }
        return true
    }
    return false
}

func render(size: Int) -> [[Double]] {
    let s = Double(size) / 18
    let ss = 16
    var a = Array(repeating: Array(repeating: 0.0, count: size), count: size)
    for py in 0..<size { for px in 0..<size {
        var hit = 0
        for sy in 0..<ss { for sx in 0..<ss {
            let x = (Double(px) + (Double(sx) + 0.5) / Double(ss)) / s
            let y = (Double(py) + (Double(sy) + 0.5) / Double(ss)) / s
            if inside(x, y, scale: s) { hit += 1 }
        } }
        a[py][px] = Double(hit) / Double(ss * ss)
    } }
    return a
}

// 18 px: start from the supersampled shape, then snap. A straight edge never leaves a partial
// pixel; the lens keeps partial alpha only on its curve.
var a18 = render(size: 18)
for y in 0..<18 { for x in 0..<18 {
    let v = a18[y][x]
    let onCurve: Bool = {
        let lx = Double(x) + 0.5 - 11.5, ly = Double(y) + 0.5 - 9.5
        let d = (lx * lx + ly * ly).squareRoot()
        return abs(d - 5.5) < 0.9 || abs(d - 2.5) < 0.9
    }()
    a18[y][x] = onCurve ? (v < 0.12 ? 0 : v > 0.88 ? 1 : (v * 4).rounded() / 4) : (v < 0.5 ? 0 : 1)
} }
write(a18, "\(out)/MenuBarIcon.png")

var a36 = render(size: 36)
// The glint in the glass, @2x only: a 2×2 dot.
for (x, y) in [(21, 16), (22, 16), (21, 17), (22, 17)] { a36[y][x] = 1 }
write(a36, "\(out)/MenuBarIcon@2x.png")

for (name, a) in [("18", a18), ("36", a36)] {
    print("\(name) px alpha (· clear, # solid, 1-9 partial):")
    for row in a { print(row.map { $0 < 0.04 ? "·" : $0 > 0.96 ? "#" : String(Int($0 * 10)) }.joined()) }
}
