#if DEBUG
  import AVFoundation
  import InboxCore
  import InboxStandIn
  import InboxWire
  import UIKit

  /// The stand-in computer's files that are drawn, not written: pictures, a short video and a PDF, made here for the
  /// tests and the screenshots. Invented, like everything on the stand-in.
  @MainActor
  enum StandInMedia {
    /// A flame graph: very wide (2400 × 576), so the viewer must show it whole first.
    static func flameGraph() -> Data {
      let size = CGSize(width: 2400, height: 576)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
        UIColor(red: 0.07, green: 0.08, blue: 0.11, alpha: 1).setFill()
        context.fill(CGRect(origin: .zero, size: size))
        let names = ["relay.keepOpen", "socket.open", "tls.handshake", "sleep", "jitter", "dns.lookup", "retry", "encode", "ping", "flush", "decode", "close"]
        var seed: UInt64 = 42
        func next() -> CGFloat {
          seed = seed &* 6364136223846793005 &+ 1442695040888963407
          return CGFloat((seed >> 33) % 1000) / 1000
        }
        for row in 0..<12 {
          var x: CGFloat = 8 + CGFloat(row) * 14
          let end = size.width - 8 - CGFloat(row) * 60
          let y = size.height - 44 - CGFloat(row) * 42
          var n = row
          while x < end - 40 {
            let width = min(end - x, 60 + next() * (520 - CGFloat(row) * 30))
            UIColor(hue: 0.03 + next() * 0.09, saturation: 0.65 + next() * 0.25, brightness: 0.82 + next() * 0.16, alpha: 1).setFill()
            let bar = CGRect(x: x, y: y, width: width - 3, height: 38)
            UIBezierPath(roundedRect: bar, cornerRadius: 3).fill()
            if width > 150 {
              let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedSystemFont(ofSize: 19, weight: .medium), .foregroundColor: UIColor(white: 0.08, alpha: 1)]
              (names[n % names.count] as NSString).draw(in: bar.insetBy(dx: 8, dy: 7), withAttributes: attributes)
            }
            n += 1
            x += width
          }
        }
        let title: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 24, weight: .semibold), .foregroundColor: UIColor(white: 0.92, alpha: 1)]
        ("relay client · reconnect after sleep · 4.2 s of samples" as NSString).draw(at: CGPoint(x: 16, y: 12), withAttributes: title)
      }
    }

    /// A phone screen: tall (780 × 2400).
    static func tallScreen() -> Data {
      let size = CGSize(width: 780, height: 2400)
      let format = UIGraphicsImageRendererFormat()
      format.scale = 1
      format.opaque = true
      return UIGraphicsImageRenderer(size: size, format: format).pngData { context in
        UIColor(white: 0.97, alpha: 1).setFill()
        context.fill(CGRect(origin: .zero, size: size))
        let title: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 44, weight: .bold), .foregroundColor: UIColor(white: 0.1, alpha: 1)]
        ("Reconnecting" as NSString).draw(at: CGPoint(x: 48, y: 96), withAttributes: title)
        let line: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 30), .foregroundColor: UIColor(white: 0.35, alpha: 1)]
        for row in 0..<22 {
          let y = 220 + CGFloat(row) * 96
          UIColor.white.setFill()
          UIBezierPath(roundedRect: CGRect(x: 32, y: y, width: size.width - 64, height: 80), cornerRadius: 18).fill()
          UIColor(hue: 0.38, saturation: 0.6, brightness: row % 5 == 3 ? 0.0 : 0.72, alpha: row % 5 == 3 ? 0.18 : 1).setFill()
          UIBezierPath(ovalIn: CGRect(x: 56, y: y + 28, width: 24, height: 24)).fill()
          ("Try \(row + 1) · waited \(min(60, 1 << min(row, 6))) s" as NSString).draw(at: CGPoint(x: 104, y: y + 22), withAttributes: line)
        }
      }
    }

    static func pdf() -> Data {
      let page = CGRect(x: 0, y: 0, width: 612, height: 792)
      return UIGraphicsPDFRenderer(bounds: page).pdfData { context in
        for number in 1...2 {
          context.beginPage()
          let title: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 26, weight: .bold)]
          let body: [NSAttributedString.Key: Any] = [.font: UIFont.systemFont(ofSize: 13), .foregroundColor: UIColor.darkGray]
          ((number == 1 ? "Relay client: reconnect report" : "Appendix: the canary's numbers") as NSString).draw(at: CGPoint(x: 56, y: 64), withAttributes: title)
          let words = "The client now opens its socket again after the laptop wakes. The wait doubles after each failed try and is capped at a minute; a quarter of a second of jitter keeps a fleet from coming back in step."
          for paragraph in 0..<5 {
            (words as NSString).draw(in: CGRect(x: 56, y: 124 + CGFloat(paragraph) * 86, width: 500, height: 80), withAttributes: body)
          }
          ("Page \(number) of 2" as NSString).draw(at: CGPoint(x: 56, y: 730), withAttributes: body)
        }
      }
    }

    /// Three seconds of a bar crossing a dark ground, 640 × 360, H.264 in an MP4.
    static func video() async -> Data? {
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("stand-in-\(UUID().uuidString).mp4")
      let width = 640
      let height = 360
      guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return nil }
      let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height])
      let adaptor = AVAssetWriterInputPixelBufferAdaptor(
        assetWriterInput: input,
        sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32ARGB, kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height])
      writer.add(input)
      guard writer.startWriting() else { return nil }
      writer.startSession(atSourceTime: .zero)
      let frames = 30
      for frame in 0..<frames {
        var waited = 0
        while !input.isReadyForMoreMediaData, waited < 200 {
          try? await Task.sleep(for: .milliseconds(10))
          waited += 1
        }
        var made: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32ARGB, nil, &made)
        guard let buffer = made else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        if let context = CGContext(
          data: CVPixelBufferGetBaseAddress(buffer), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buffer), space: CGColorSpaceCreateDeviceRGB(),
          bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue)
        {
          context.setFillColor(UIColor(red: 0.07, green: 0.09, blue: 0.13, alpha: 1).cgColor)
          context.fill(CGRect(x: 0, y: 0, width: width, height: height))
          context.setFillColor(UIColor(red: 0.25, green: 0.72, blue: 0.4, alpha: 1).cgColor)
          let across = CGFloat(frame) / CGFloat(frames - 1)
          context.fill(CGRect(x: 40, y: 150, width: 560 * across, height: 60))
          context.setStrokeColor(UIColor(white: 1, alpha: 0.5).cgColor)
          context.stroke(CGRect(x: 40, y: 150, width: 560, height: 60))
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        adaptor.append(buffer, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 10))
      }
      input.markAsFinished()
      await writer.finishWriting()
      return try? Data(contentsOf: url)
    }

    /// The files thread, whole: the files made of words, then the drawn ones on its second message.
    static func seat(on door: StandInDoor) async {
      await door.addFilesThread()
      let thread = StandInData.files
      let second = StandInData.filesSecond
      _ = await door.addFile(thread: thread, message: second, name: "reconnect-flamegraph.png", kind: .image, bytes: flameGraph(), mediaType: "image/png", width: 2400, height: 576)
      _ = await door.addFile(thread: thread, message: second, name: "reconnecting-screen.png", kind: .image, bytes: tallScreen(), mediaType: "image/png", width: 780, height: 2400)
      if let video = await video() {
        _ = await door.addFile(thread: thread, message: second, name: "reconnect-demo.mp4", kind: .video, bytes: video, mediaType: "video/mp4", width: 640, height: 360, durationMs: 3000)
      }
      _ = await door.addFile(thread: thread, message: second, name: "reconnect-report.pdf", kind: .pdf, bytes: pdf(), mediaType: "application/pdf")
      _ = await door.addFile(thread: thread, message: second, name: "relay-traces.zip", kind: .file, bytes: Data((0..<48_000).map { UInt8(truncatingIfNeeded: $0 &* 31) }), mediaType: "application/zip")
    }
  }
#endif
