// Generates the app icon master and menu-bar template candidates from the owner's mascot PNG.
import AppKit
import CoreGraphics
import Foundation

let src = CommandLine.arguments[1]
let out = CommandLine.arguments[2]
try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)

guard let data = FileManager.default.contents(atPath: src), let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage else { fatalError("bad png") }
let W = cg.width, H = cg.height
let space = CGColorSpaceCreateDeviceRGB()
var px = [UInt8](repeating: 0, count: W * H * 4)
let ctx = CGContext(data: &px, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
ctx.draw(cg, in: CGRect(x: 0, y: 0, width: W, height: H))
// px rows are top-first here (CGContext memory is top-down for the drawn image).

func at(_ x: Int, _ y: Int) -> (r: Int, g: Int, b: Int, a: Int) {
    let i = (y * W + x) * 4
    return (Int(px[i]), Int(px[i + 1]), Int(px[i + 2]), Int(px[i + 3]))
}

// Alpha bounding box.
var minX = W, minY = H, maxX = 0, maxY = 0
for y in 0..<H { for x in 0..<W where at(x, y).a > 8 { minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y) } }
let box = CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1)
print("alpha bbox: \(box)")

func writePNG(_ image: CGImage, _ path: String) {
    let r = NSBitmapImageRep(cgImage: image)
    try! r.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: path))
}

func canvas(_ size: Int) -> CGContext {
    let c = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.interpolationQuality = .high
    return c
}

// Crop (CG image coordinates are top-left for cropping).
let cropped = cg.cropping(to: box)!

// --- App icon master: the art fitted into Apple's 824 pt content box on a 1024 canvas, transparent.
func master(content: CGFloat, name: String) {
    let c = canvas(1024)
    let scale = min(content / box.width, content / box.height)
    let w = box.width * scale, h = box.height * scale
    c.draw(cropped, in: CGRect(x: (1024 - w) / 2, y: (1024 - h) / 2, width: w, height: h))
    writePNG(c.makeImage()!, "\(out)/\(name)")
}
master(content: 824, name: "icon-1024.png")

// --- Template candidates: a mask from a per-pixel test, cropped to its own bbox, fitted at 18 and 36 px.
func mask(_ keep: (Int, Int) -> Bool) -> (CGImage, CGRect) {
    var m = [UInt8](repeating: 0, count: W * H * 4)
    var bx0 = W, by0 = H, bx1 = 0, by1 = 0
    for y in 0..<H { for x in 0..<W where keep(x, y) {
        let i = (y * W + x) * 4
        m[i + 3] = 255
        bx0 = min(bx0, x); bx1 = max(bx1, x); by0 = min(by0, y); by1 = max(by1, y)
    } }
    let mc = CGContext(data: &m, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    return (mc.makeImage()!, CGRect(x: bx0, y: by0, width: bx1 - bx0 + 1, height: by1 - by0 + 1))
}

func luma(_ p: (r: Int, g: Int, b: Int, a: Int)) -> Int { (p.r * 299 + p.g * 587 + p.b * 114) / 1000 }

let silhouette = mask { x, y in at(x, y).a > 128 }
// The camera alone: the dark body and the blue lens.
let camera = mask { x, y in
    let p = at(x, y)
    guard p.a > 128, x > 400, y < 640 else { return false }
    let l = luma(p)
    let blue = p.b > p.r + 30 && p.b > 90 && x > 640
    return l < 95 || blue
}

func template(_ m: (CGImage, CGRect), _ size: Int, _ name: String) {
    let c = canvas(size)
    let pad = CGFloat(size) * 0.06
    let room = CGFloat(size) - pad * 2
    let scale = min(room / m.1.width, room / m.1.height)
    let w = m.1.width * scale, h = m.1.height * scale
    c.draw(m.0.cropping(to: m.1)!, in: CGRect(x: (CGFloat(size) - w) / 2, y: (CGFloat(size) - h) / 2, width: w, height: h))
    writePNG(c.makeImage()!, "\(out)/\(name)")
}
for (m, label) in [(silhouette, "silhouette"), (camera, "camera")] {
    template(m, 18, "menubar-\(label)-18.png")
    template(m, 36, "menubar-\(label)-36.png")
}
print("done")
