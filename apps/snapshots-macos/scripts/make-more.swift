// Round two: silhouette with the lens knocked out, and an app icon on Apple's squircle.
import AppKit
import CoreGraphics
import Foundation

let src = CommandLine.arguments[1]
let out = CommandLine.arguments[2]
guard let data = FileManager.default.contents(atPath: src), let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage else { fatalError("bad png") }
let W = cg.width, H = cg.height
let space = CGColorSpaceCreateDeviceRGB()
var px = [UInt8](repeating: 0, count: W * H * 4)
let ctx = CGContext(data: &px, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
func at(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) { let i = (y * W + x) * 4; return (Int(px[i]), Int(px[i + 1]), Int(px[i + 2]), Int(px[i + 3])) }
func writePNG(_ image: CGImage, _ path: String) { try! NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path)) }
func canvas(_ size: Int) -> CGContext { let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!; c.interpolationQuality = .high; return c }

// The lens: the blue glass, found by colour, then filled as its bounding circle.
var lx0 = W, ly0 = H, lx1 = 0, ly1 = 0
for y in 260..<560 { for x in 720..<980 { let p = at(x, y); if p.a > 128 && p.b > p.r + 50 && p.b > 120 { lx0 = min(lx0, x); lx1 = max(lx1, x); ly0 = min(ly0, y); ly1 = max(ly1, y) } } }
let lcx = Double(lx0 + lx1) / 2, lcy = Double(ly0 + ly1) / 2, lr = Double(max(lx1 - lx0, ly1 - ly0)) / 2 * 0.95
print("lens: \(lx0)...\(lx1), \(ly0)...\(ly1)")

var m = [UInt8](repeating: 0, count: W * H * 4)
var bx0 = W, by0 = H, bx1 = 0, by1 = 0
for y in 0..<H { for x in 0..<W {
    guard at(x, y).a > 128 else { continue }
    let d = ((Double(x) - lcx) * (Double(x) - lcx) + (Double(y) - lcy) * (Double(y) - lcy)).squareRoot()
    if d < lr { continue } // lens knocked out
    let i = (y * W + x) * 4
    m[i + 3] = 255
    bx0 = min(bx0, x); bx1 = max(bx1, x); by0 = min(by0, y); by1 = max(by1, y)
} }
let mc = CGContext(data: &m, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
let maskImage = mc.makeImage()!
let mbox = CGRect(x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1)
for size in [18, 36] {
    let c = canvas(size)
    let room = CGFloat(size) * 0.94
    let s = min(room / mbox.width, room / mbox.height)
    c.draw(maskImage.cropping(to: mbox)!, in: CGRect(x: (CGFloat(size) - mbox.width * s) / 2, y: (CGFloat(size) - mbox.height * s) / 2, width: mbox.width * s, height: mbox.height * s))
    writePNG(c.makeImage()!, "\(out)/menubar-lens-\(size).png")
}

// App icon B: the mascot on Apple's macOS squircle (824 pt box, continuous corners), a soft light ground.
let c = canvas(1024)
let tile = CGRect(x: 100, y: 100, width: 824, height: 824)
let path = NSBezierPath(roundedRect: tile, xRadius: 185, yRadius: 185).cgPath
c.saveGState()
c.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor(white: 0, alpha: 0.28).cgColor)
c.addPath(path)
c.setFillColor(NSColor.white.cgColor)
c.fillPath()
c.restoreGState()
c.saveGState()
c.addPath(path)
c.clip()
let grad = CGGradient(colorsSpace: space, colors: [NSColor(srgbRed: 1.0, green: 0.97, blue: 0.91, alpha: 1).cgColor, NSColor(srgbRed: 0.99, green: 0.86, blue: 0.68, alpha: 1).cgColor] as CFArray, locations: [0, 1])!
c.drawLinearGradient(grad, start: CGPoint(x: 512, y: 924), end: CGPoint(x: 512, y: 100), options: [])
var ax0 = W, ay0 = H, ax1 = 0, ay1 = 0
for y in 0..<H { for x in 0..<W where at(x, y).a > 8 { ax0 = min(ax0, x); ax1 = max(ax1, x); ay0 = min(ay0, y); ay1 = max(ay1, y) } }
let abox = CGRect(x: ax0, y: ay0, width: ax1 - ax0 + 1, height: ay1 - ay0 + 1)
let art = cg.cropping(to: abox)!
let s = min(700 / abox.width, 700 / abox.height)
c.draw(art, in: CGRect(x: 512 - abox.width * s / 2, y: 512 - abox.height * s / 2 - 6, width: abox.width * s, height: abox.height * s))
c.restoreGState()
writePNG(c.makeImage()!, "\(out)/icon-1024-squircle.png")
print("done")
