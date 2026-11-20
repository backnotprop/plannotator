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
  let close: () -> Void
  @State private var picture: (image: UIImage, pixels: CGSize)?
  @State private var unreadable = false
  /// VoiceOver keeps the bars: with them away there would be nothing to move to but the picture.
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver

  var body: some View {
    Group {
      if let picture {
        PictureView(picture: picture.image, pixels: picture.pixels, name: item.name, bars: UIEdgeInsets(top: bars.top, left: bars.leading, bottom: bars.bottom, right: bars.trailing)) {
          if !voiceOver { bare.toggle() }
        } pulledDown: {
          close()
        }
        .ignoresSafeArea()
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
  let tapped: () -> Void
  let pulledDown: () -> Void

  func makeUIView(context: Context) -> PictureScroll {
    let view = PictureScroll()
    view.bars = bars
    view.show(picture, pixels: pixels, name: name)
    view.tapped = tapped
    view.pulledDown = pulledDown
    return view
  }

  func updateUIView(_ view: PictureScroll, context: Context) {
    if view.picture.image !== picture { view.show(picture, pixels: pixels, name: name) }
    if view.bars != bars { view.bars = bars }
    view.tapped = tapped
    view.pulledDown = pulledDown
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
    let twice = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
    twice.numberOfTapsRequired = 2
    let once = UITapGestureRecognizer(target: self, action: #selector(singleTapped))
    once.require(toFail: twice)
    addGestureRecognizer(twice)
    addGestureRecognizer(once)
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
    guard recognizer === panGestureRecognizer, zoomScale <= whole * 1.01 else { return super.gestureRecognizerShouldBegin(recognizer) }
    let velocity = panGestureRecognizer.velocity(in: self)
    return velocity.y > 0 && abs(velocity.y) > abs(velocity.x)
  }

  func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }
  func scrollViewDidZoom(_ scrollView: UIScrollView) { centre() }

  func scrollViewWillEndDragging(_ scrollView: UIScrollView, withVelocity velocity: CGPoint, targetContentOffset: UnsafeMutablePointer<CGPoint>) {
    guard zoomScale <= whole * 1.01 else { return }
    // Past 15% of the height, or a flick down.
    let pulled = -(contentOffset.y + contentInset.top)
    if pulled > bounds.height * 0.15 || (pulled > 24 && velocity.y < -1.2) { pulledDown() }
  }

  @objc private func singleTapped() { tapped() }

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
