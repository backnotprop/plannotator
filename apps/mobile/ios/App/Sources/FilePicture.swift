import InboxCore
import SwiftUI
import UIKit

/// A picture, on black: all of it at first, however wide or tall, then pinched into (the owner's ruling for a very
/// wide picture: whole first). Two taps go in and back out; one tap puts the bars away; pulled down while whole, it
/// closes.
struct PicturePage: View {
  let session: InboxSession
  let url: URL
  let item: AttachmentItem
  let bars: EdgeInsets
  @Binding var bare: Bool
  let context: CommentContext
  /// The page on screen: only its picture is held ready to flatten a drawing onto.
  var current = true
  let close: () -> Void
  @State private var picture: (image: UIImage, pixels: CGSize)?
  @State private var unreadable = false
  /// VoiceOver keeps the bars: with them away there would be nothing to move to but the picture.
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  var body: some View {
    Group {
      if let picture {
        let desk = context.desk
        let kept = context.session.comments(context.thread, on: item.id).compactMap(\.marks)
        PictureView(
          picture: picture.image, pixels: picture.pixels, name: item.name, bars: UIEdgeInsets(top: bars.top, left: bars.leading, bottom: bars.bottom, right: bars.trailing),
          marking: desk.marking && context.takes, kept: kept, drawn: desk.marks[item.id] ?? [], sought: desk.sought?.comment.attachment == item.id ? desk.sought : nil
        ) {
          if !voiceOver { bare.toggle() }
        } pulledDown: {
          close()
        } marked: { mark in
          desk.marks[item.id, default: []].append(mark)
        }
        .ignoresSafeArea()
        .onChange(of: current, initial: true) { _, on in
          let file = item.id
          guard on else {
            // Another file is on screen: the desk lets go of this picture.
            if desk.flatten?.file == file { desk.flatten = nil }
            return
          }
          let image = picture.image
          let pixels = picture.pixels
          let (session, thread) = (context.session, context.thread)
          desk.flatten = (file, { marks in
            guard let flat = PictureInk.flattened(image, pixels: pixels, kept: session.comments(thread, on: file).compactMap(\.marks), drawn: marks) else { return nil }
            return await PictureInk.png(flat)
          })
        }
        .onDisappear { if desk.flatten?.file == item.id { desk.flatten = nil } }
      } else if unreadable {
        // A picture in a format the phone cannot read (an SVG), or one that says it is too large to decode: what
        // it is, and Share.
        FileCard(session: session, item: item, url: url, note: PhoneWords.fileNotShown(item.name))
      } else {
        Waiting()
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.black.ignoresSafeArea())
    .task(id: url) {
      let read = await Task.detached { Pictures.whole(url) }.value
      picture = read
      unreadable = read == nil
    }
    .onChange(of: voiceOver) { _, on in if on { bare = false } }
  }
}

struct PictureView: UIViewRepresentable {
  let picture: UIImage
  /// The picture's own size in pixels (the image may be drawn from fewer).
  let pixels: CGSize
  let name: String
  let bars: UIEdgeInsets
  /// The picture takes the finger: a drag draws on it, a touch pins a spot; two fingers move it and look into it.
  var marking = false
  /// What each waiting comment drew, and what is drawn and not yet commented.
  var kept: [[PictureMark]] = []
  var drawn: [PictureMark] = []
  /// A comment asked for: the picture shows the part it marked.
  var sought: CommentDesk.Sought?
  let tapped: () -> Void
  let pulledDown: () -> Void
  var marked: (PictureMark) -> Void = { _ in }

  func makeUIView(context: Context) -> PictureScroll {
    let view = PictureScroll()
    view.bars = bars
    view.show(picture, pixels: pixels, name: name)
    view.tapped = tapped
    view.pulledDown = pulledDown
    view.marked = marked
    view.marking = marking
    view.draw(kept: kept, drawn: drawn)
    return view
  }

  func updateUIView(_ view: PictureScroll, context: Context) {
    if view.picture.image !== picture { view.show(picture, pixels: pixels, name: name) }
    if view.bars != bars { view.bars = bars }
    view.tapped = tapped
    view.pulledDown = pulledDown
    view.marked = marked
    if view.marking != marking { view.marking = marking }
    view.draw(kept: kept, drawn: drawn)
    if let sought, sought.turn != view.soughtTurn {
      view.soughtTurn = sought.turn
      view.look(at: sought.comment.marks ?? [])
    }
  }
}

/// The picture in a scroll view that zooms. `content` is the picture's own size in points (one per pixel), so a
/// place on it is a place in the file: `marks`, over the picture and zoomed with it, is where drawn marks and
/// comment pins go.
final class PictureScroll: UIScrollView, UIScrollViewDelegate {
  let content = UIView()
  let picture = UIImageView()
  let marks = UIView()
  var tapped: () -> Void = {}
  var pulledDown: () -> Void = {}
  var marked: (PictureMark) -> Void = { _ in }
  var soughtTurn = 0
  /// The picture takes one finger for marks; the view's own moving and pinching take two.
  var marking = false {
    didSet {
      panGestureRecognizer.minimumNumberOfTouches = marking ? 2 : 1
      pen.isEnabled = marking
      twice.isEnabled = !marking
    }
  }
  private let pen = UIPanGestureRecognizer()
  private let twice = UITapGestureRecognizer()
  private let line = CAShapeLayer()
  private var stroke: [CGPoint] = []
  private var shownMarks: [[PictureMark]] = []
  /// What the bars cover: the picture rests clear of them while whole.
  var bars = UIEdgeInsets.zero { didSet { setNeedsLayout() } }
  private var fitted = CGSize.zero
  private var whole: CGFloat = 1

  override init(frame: CGRect) {
    super.init(frame: frame)
    delegate = self
    backgroundColor = .black
    showsVerticalScrollIndicator = false
    showsHorizontalScrollIndicator = false
    contentInsetAdjustmentBehavior = .never
    // Pulled down while whole, the picture follows the finger a little way and closes.
    alwaysBounceVertical = true
    decelerationRate = .fast
    picture.contentMode = .scaleToFill
    picture.isAccessibilityElement = true
    picture.accessibilityTraits = .image
    picture.accessibilityIdentifier = "file-picture"
    marks.backgroundColor = .clear
    marks.isUserInteractionEnabled = false
    content.addSubview(picture)
    content.addSubview(marks)
    addSubview(content)
    twice.addTarget(self, action: #selector(doubleTapped(_:)))
    twice.numberOfTapsRequired = 2
    let once = UITapGestureRecognizer(target: self, action: #selector(singleTapped(_:)))
    once.require(toFail: twice)
    addGestureRecognizer(twice)
    addGestureRecognizer(once)
    pen.addTarget(self, action: #selector(penMoved(_:)))
    pen.maximumNumberOfTouches = 1
    pen.isEnabled = false
    addGestureRecognizer(pen)
    marks.accessibilityIdentifier = "picture-marks"
  }

  // MARK: Marks

  /// The longer side of the picture, in its own pixels: what a mark's least size is measured by.
  private var longest: Double { Double(max(pixels.width, pixels.height)) }

  /// Draw the marks, each in the picture's own pixels (`marks` is zoomed with the picture, so a mark stays on the
  /// part of the picture it was made on).
  func draw(kept: [[PictureMark]], drawn: [PictureMark]) {
    let all = kept + [drawn]
    guard all != shownMarks else { return }
    shownMarks = all
    marks.layer.sublayers?.forEach { $0.removeFromSuperlayer() }
    var number = 0
    for (index, group) in all.enumerated() {
      for mark in group {
        if mark.kind == .pin { number += 1 }
        for layer in PictureInk.layers(mark, number: number, waiting: index == all.count - 1) { marks.layer.addSublayer(layer) }
      }
    }
    marks.accessibilityValue = "\(all.joined().count)"
    marks.isAccessibilityElement = !all.joined().isEmpty
  }

  /// Show the part of the picture a comment marked, with room about it; a comment with no marks shows it whole.
  func look(at marks: [PictureMark]) {
    let animated = !UIAccessibility.isReduceMotionEnabled
    guard let box = PictureMark.bounds(marks) else { return setZoomScale(whole, animated: animated) }
    let pad = max(box.width, box.height) * 0.6 + 40 / Double(max(zoomScale, 0.0001))
    zoom(to: CGRect(x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad), animated: animated)
  }

  @objc private func penMoved(_ pen: UIPanGestureRecognizer) {
    let point = pen.location(in: content)
    switch pen.state {
    case .began:
      stroke = [point]
      line.strokeColor = PictureInk.ink.cgColor
      line.fillColor = nil
      line.lineCap = .round
      line.lineJoin = .round
      line.lineWidth = PictureMark.strokeSize(zoom: Double(zoomScale), longest: longest)
      marks.layer.addSublayer(line)
    case .changed:
      stroke.append(point)
      let path = UIBezierPath()
      path.move(to: stroke[0])
      for next in stroke.dropFirst() { path.addLine(to: next) }
      line.path = path.cgPath
    case .ended:
      line.removeFromSuperlayer()
      line.path = nil
      // Kept inside the picture: a line drawn off its edge ends at the edge.
      let inside = stroke.map { CGPoint(x: min(max($0.x, 0), pixels.width), y: min(max($0.y, 0), pixels.height)) }
      if inside.count > 1 { marked(PictureMark(kind: .stroke, points: inside.flatMap { [Double($0.x), Double($0.y)] }, size: PictureMark.strokeSize(zoom: Double(zoomScale), longest: longest))) }
      stroke = []
    default:
      line.removeFromSuperlayer()
      line.path = nil
      stroke = []
    }
  }

  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  /// The picture's own size in pixels, which is the content's size in points.
  private var pixels = CGSize.zero

  func show(_ image: UIImage, pixels: CGSize, name: String) {
    picture.image = image
    picture.accessibilityLabel = name
    self.pixels = pixels
    zoomScale = 1
    content.frame = CGRect(origin: .zero, size: pixels)
    picture.frame = content.bounds
    marks.frame = content.bounds
    contentSize = pixels
    fitted = .zero
    setNeedsLayout()
  }

  /// The room the picture is shown in: the screen less the bars.
  private var room: CGRect { bounds.inset(by: bars) }

  override func layoutSubviews() {
    super.layoutSubviews()
    let size = room.size
    guard size.width > 0, size.height > 0, picture.image != nil, size != fitted else { return centre() }
    let wasWhole = fitted == .zero || zoomScale <= whole * 1.01
    fitted = size
    whole = PictureFit.whole(width: pixels.width, height: pixels.height, roomWidth: size.width, roomHeight: size.height)
    minimumZoomScale = whole
    maximumZoomScale = PictureFit.most(whole: whole)
    if wasWhole { zoomScale = whole }
    centre()
  }

  /// A picture smaller than the room rests in its middle, clear of the bars.
  private func centre() {
    let safe = bars
    let size = room.size
    let extraX = max(0, (size.width - content.frame.width) / 2)
    let extraY = max(0, (size.height - content.frame.height) / 2)
    let insets = UIEdgeInsets(top: safe.top + extraY, left: safe.left + extraX, bottom: safe.bottom + extraY, right: safe.right + extraX)
    if contentInset != insets { contentInset = insets }
  }

  /// While the picture is whole, only a pull down is this view's own (it closes the picture): a drag sideways is left
  /// to the cover, which steps to the next file. Looked into, every drag moves the picture.
  override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
    guard recognizer === panGestureRecognizer, zoomScale <= whole * 1.01, !marking else { return super.gestureRecognizerShouldBegin(recognizer) }
    let velocity = panGestureRecognizer.velocity(in: self)
    return velocity.y > 0 && abs(velocity.y) > abs(velocity.x)
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }

  func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    guard zoomScale <= whole * 1.01, !marking else { return }
    // Past 15% of the height, or a flick down.
    let pulled = -(contentOffset.y + contentInset.top)
    if pulled > bounds.height * 0.15 || (pulled > 24 && velocity.y < -1.2) { pulledDown() }
  }

  @objc private func singleTapped(_ tap: UITapGestureRecognizer) {
    guard marking else { return tapped() }
    // A touch pins the spot under it, in the picture's own pixels.
    let point = tap.location(in: content)
    guard CGRect(origin: .zero, size: pixels).contains(point) else { return }
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
    marked(PictureMark(kind: .pin, points: [Double(point.x), Double(point.y)], size: PictureMark.pinSize(zoom: Double(zoomScale), longest: longest)))
  }

  @objc private func doubleTapped(_ tap: UITapGestureRecognizer) {
    guard picture.image != nil else { return }
    let size = room.size
    // Reduce Motion: the picture is at its new size at once.
    let animated = !UIAccessibility.isReduceMotionEnabled
    let target = PictureFit.doubleTap(from: zoomScale, whole: whole, width: pixels.width, height: pixels.height, roomWidth: size.width, roomHeight: size.height)
    guard target > whole * 1.01 else { return setZoomScale(whole, animated: animated) }
    // In, about the place tapped.
    let point = tap.location(in: content)
    let width = size.width / target
    let height = size.height / target
    zoom(to: CGRect(x: point.x - width / 2, y: point.y - height / 2, width: width, height: height), animated: animated)
  }
}

/// How a mark is drawn: on the screen (layers in the picture's own pixels) and flattened onto the picture for the
/// computer. One ink for both, with a light edge so a mark reads on a dark picture and on a pale one.
@MainActor
enum PictureInk {
  /// The mark's colour: the window's markup red (packages/ui/components/ImageAnnotator: its default pen).
  static let ink = UIColor(red: 0.94, green: 0.27, blue: 0.27, alpha: 1)
  static let edge = UIColor.white

  static func path(_ mark: PictureMark) -> UIBezierPath {
    let path = UIBezierPath()
    var index = 0
    while index + 1 < mark.points.count {
      let point = CGPoint(x: mark.points[index], y: mark.points[index + 1])
      if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
      index += 2
    }
    return path
  }

  /// `waiting`: drawn and not yet part of a comment (a little lighter until it is kept).
  static func layers(_ mark: PictureMark, number: Int, waiting: Bool) -> [CALayer] {
    let size = CGFloat(mark.size)
    switch mark.kind {
    case .stroke:
      let under = CAShapeLayer()
      under.path = path(mark).cgPath
      under.strokeColor = edge.withAlphaComponent(0.9).cgColor
      under.lineWidth = size * 1.6
      let over = CAShapeLayer()
      over.path = under.path
      over.strokeColor = ink.cgColor
      over.lineWidth = size
      for layer in [under, over] {
        layer.fillColor = nil
        layer.lineCap = .round
        layer.lineJoin = .round
        layer.opacity = waiting ? 0.85 : 1
      }
      return [under, over]
    case .pin:
      guard mark.points.count >= 2 else { return [] }
      let disc = CAShapeLayer()
      disc.path = UIBezierPath(ovalIn: CGRect(x: mark.points[0] - size, y: mark.points[1] - size, width: size * 2, height: size * 2)).cgPath
      disc.fillColor = ink.cgColor
      disc.strokeColor = edge.cgColor
      disc.lineWidth = size * 0.16
      disc.opacity = waiting ? 0.85 : 1
      let label = CATextLayer()
      label.string = NSAttributedString(string: "\(number)", attributes: [.font: UIFont.systemFont(ofSize: size * 1.15, weight: .bold), .foregroundColor: edge])
      label.alignmentMode = .center
      label.contentsScale = 3
      label.frame = CGRect(x: mark.points[0] - size, y: mark.points[1] - size * 0.72, width: size * 2, height: size * 1.5)
      return [disc, label]
    }
  }

  /// The longest side of a flattened picture, in pixels: a drawing is something to look at, not a copy of the file.
  static let flatCap: CGFloat = 4096

  /// The picture with the marks on it, as a PNG: what the computer keeps and the agent opens. The marks of the
  /// comments already kept are not on it: each comment's drawing is its own.
  /// A drawn picture's pixels, ready to encode.
  struct Flat: @unchecked Sendable { let image: CGImage }

  /// The PNG of a flattened picture, encoded off the main thread (a large picture takes a while).
  static func png(_ flat: Flat) async -> Data? {
    await Task.detached(priority: .userInitiated) { UIImage(cgImage: flat.image).pngData() }.value
  }

  /// The picture with the drawing on it, as the window sends it: drawn here (the marks are layers, drawn on the main
  /// thread), encoded by `png`.
  static func flattened(_ image: UIImage, pixels: CGSize, kept: [[PictureMark]], drawn: [PictureMark]) -> Flat? {
    guard pixels.width > 0, pixels.height > 0 else { return nil }
    let scale = min(1, flatCap / max(pixels.width, pixels.height))
    let size = CGSize(width: (pixels.width * scale).rounded(), height: (pixels.height * scale).rounded())
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let pinsBefore = kept.joined().filter { $0.kind == .pin }.count
    let drawnImage = UIGraphicsImageRenderer(size: size, format: format).image { context in
      UIColor.black.setFill()
      context.fill(CGRect(origin: .zero, size: size))
      image.draw(in: CGRect(origin: .zero, size: size))
      context.cgContext.scaleBy(x: scale, y: scale)
      var number = pinsBefore
      for mark in drawn {
        if mark.kind == .pin { number += 1 }
        for layer in layers(mark, number: number, waiting: false) {
          layer.opacity = 1
          // A layer draws itself from its own corner: put that where its frame is.
          context.cgContext.saveGState()
          context.cgContext.translateBy(x: layer.frame.minX, y: layer.frame.minY)
          layer.render(in: context.cgContext)
          context.cgContext.restoreGState()
        }
      }
    }
    return drawnImage.cgImage.map(Flat.init)
  }
}
