import InboxCore
import SwiftUI

/// The time the snooze menus read: the system's clock, or, in a debug build, one a test set with `-clockAt` (an
/// ISO 8601 moment: the clock reads it when first asked, and runs on), so a test of the menu does not depend on the day.
enum AppClock {
  static let shift: TimeInterval = {
    #if DEBUG
      if let at = UserDefaults.standard.string(forKey: "clockAt"), let moment = ISO8601DateFormatter().date(from: at) { return moment.timeIntervalSinceNow }
    #endif
    return 0
  }()

  static func now() -> Date { Date().addingTimeInterval(shift) }
}

/// Snooze's times as a menu's items (the window's "Snooze until": Later today, Tomorrow, In 3 days, Next week, each
/// with its real local time, then Pick a time…). Used inside a row's menu, the thread's More menu and the picks' bar.
struct SnoozeTimes: View {
  let pick: (Date) -> Void
  let pickATime: () -> Void

  var body: some View {
    let rules = SnoozeRules()
    let now = AppClock.now()
    Section(PhoneWords.snoozeUntil) {
      ForEach(rules.choices(now: now), id: \.id) { choice in
        Button {
          pick(choice.until)
        } label: {
          Text(choice.label)
          Text(rules.when(choice.untilISO, now: now))
        }
      }
    }
    Button(PhoneWords.pickATime, systemImage: "calendar.badge.clock", action: pickATime)
  }
}

/// Pick a time: a day (sixty of them, today first) and a half hour, as the window lists them. Today lists only the
/// half hours still ahead; a newly picked day keeps the picked time, or the next one on.
struct SnoozePickSheet: View {
  let pick: (Date) -> Void
  @Environment(\.dismiss) private var dismiss
  @State private var day = ""
  @State private var time = ""
  @State private var opened = Date()
  /// The wheels' height: five rows at the text's size.
  @ScaledMetric(relativeTo: .body) private var wheels: CGFloat = 180
  /// The button's height as its words grow.
  @ScaledMetric(relativeTo: .body) private var button: CGFloat = Size.wideButton

  private let rules = SnoozeRules()
  private var days: [SnoozeRules.Day] { rules.days(now: opened) }
  private var times: [SnoozeRules.Time] { rules.times(day: day, now: opened) }
  private var until: Date? { times.first { $0.key == time }?.until }

  var body: some View {
    NavigationStack {
      VStack(spacing: Space.card) {
        HStack(spacing: 0) {
          Picker(PhoneWords.day, selection: $day) {
            ForEach(days, id: \.key) { Text($0.label).tag($0.key) }
          }
          Picker(PhoneWords.time, selection: $time) {
            ForEach(times, id: \.key) { Text($0.label).tag($0.key) }
          }
        }
        .pickerStyle(.wheel)
        .frame(height: min(wheels, 280))
        Button {
          if let until { pick(until) }
          dismiss()
        } label: {
          Text(PhoneWords.snooze).actionGround(until == nil ? .off : .filled, height: Size.wideButton)
        }
        .buttonStyle(PressStyle())
        .disabled(until == nil)
      }
      .padding(.horizontal, Space.page)
      .padding(.bottom, Space.card)
      .frame(maxHeight: .infinity, alignment: .top)
      .background(Surface.sheet.ignoresSafeArea())
      .navigationTitle(PhoneWords.pickATimeTitle)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button(PhoneWords.cancel) { dismiss() } } }
    }
    // As tall as its title, its wheels and its button, and no taller; the largest text sizes can pull it up.
    .presentationDetents([.height(min(wheels, 280) + button + Space.card * 2 + Size.barSide), .large])
    .presentationDragIndicator(.visible)
    .presentationBackground(Surface.sheet)
    .onAppear {
      let now = Date()
      opened = now
      let first = rules.firstPick(now: now)
      day = first.day
      time = SnoozeRules.keepTime(rules.times(day: first.day, now: now), first.time) ?? first.time
    }
    .onChange(of: day) { _, _ in
      if let kept = SnoozeRules.keepTime(times, time) { time = kept }
    }
  }
}
