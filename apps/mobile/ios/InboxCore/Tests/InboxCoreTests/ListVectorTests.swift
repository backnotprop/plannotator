import Foundation
import XCTest
@testable import InboxCore
import InboxWire

/// apps/mobile/contract/vectors/snooze.json and rows.json: the window's own snooze and list rules, run on invented
/// input, and the phone's ports run on the same input.
final class ListVectorTests: XCTestCase {
  private func date(_ iso: String, file: StaticString = #filePath, line: UInt = #line) throws -> Date {
    try XCTUnwrap(SnoozeRules.date(iso), "not a time: \(iso)", file: file, line: line)
  }

  // MARK: Snooze, in every zone the suite names

  func testSnoozeChoicesDaysAndTimesMatchTheWindowInEveryZone() throws {
    let suite = try Contract.json("vectors/snooze.json")
    let zones = try suite.at("zones").items
    XCTAssertGreaterThanOrEqual(zones.count, 6, "the suite crosses several zones")
    for zone in zones {
      let name = try zone.at("time_zone").str()
      let rules = SnoozeRules(timeZone: try XCTUnwrap(TimeZone(identifier: name), name))
      for moment in try zone.at("nows").items {
        let iso = try moment.at("now").str()
        let now = try date(iso)
        let at = "\(name) at \(iso)"
        let choices = rules.choices(now: now)
        let expected = try moment.at("choices").items
        XCTAssertEqual(choices.map(\.id.rawValue), try expected.map { try $0.at("id").str() }, "choices, \(at)")
        XCTAssertEqual(choices.map(\.label), try expected.map { try $0.at("label").str() }, "labels, \(at)")
        XCTAssertEqual(choices.map { $0.until.timeIntervalSince1970 }, try expected.map { try date($0.at("until").str()).timeIntervalSince1970 }, "until, \(at)")

        let days = try moment.at("days").items
        // The suite asks for a few days; the phone's own count is the window's 60.
        let mine = rules.days(now: now, count: try XCTUnwrap(Contract.json("fixtures/snooze.json")["pick_days_count"]?.whole))
        XCTAssertEqual(mine.map(\.key), try days.map { try $0.at("key").str() }, "days, \(at)")
        XCTAssertEqual(mine.map(\.label), try days.map { try $0.at("label").str() }, "day labels, \(at)")

        let first = try moment.at("first_pick")
        let pick = rules.firstPick(now: now)
        XCTAssertEqual(pick.day, try first.at("day").str(), "first pick, \(at)")
        XCTAssertEqual(pick.time, try first.at("time").str(), "first pick time, \(at)")

        for day in try moment.at("times").items {
          let key = try day.at("day").str()
          let times = rules.times(day: key, now: now)
          let wanted = try day.at("times").items
          XCTAssertEqual(times.map(\.key), try wanted.map { try $0.at("key").str() }, "times of \(key), \(at)")
          XCTAssertEqual(times.map(\.label), try wanted.map { try $0.at("label").str() }, "time labels of \(key), \(at)")
          XCTAssertEqual(times.map { $0.until.timeIntervalSince1970 }, try wanted.map { try date($0.at("until").str()).timeIntervalSince1970 }, "time instants of \(key), \(at)")
        }

        for case_ in try moment.at("when").items {
          XCTAssertEqual(rules.when(try case_.at("iso").str(), now: now), try case_.at("words").str(), "when \(case_), \(at)")
        }
      }

      let keep = try zone.at("keep_time")
      let times = rules.times(day: try keep.at("day").str(), now: try date(keep.at("now").str()))
      for case_ in try keep.at("cases").items {
        XCTAssertEqual(SnoozeRules.keepTime(times, try case_.at("time").str()), case_["kept"]?.text, "keep \(case_), \(name)")
      }
    }
  }

  func testSnoozeRefusalsMatchTheWindow() throws {
    let suite = try Contract.json("vectors/snooze.json")
    let now = try date(try suite.at("zones").items[0].at("nows").items[0].at("now").str())
    for case_ in try suite.at("refusals").items {
      let until = case_["until"]?.text
      XCTAssertEqual(SnoozeRules.refusal(until, now: now)?.rawValue, case_["refusal"]?.text, "refusal of \(case_)")
    }
  }

  /// A row of the snooze fixture, filled out to a whole list row.
  private func row(_ partial: JSONValue, base: JSONValue) throws -> InboxListRow {
    guard case .object(var fields) = base, case .object(let given) = partial else { throw XCTSkip("not an object") }
    for (key, value) in given where key != "note" { fields[key] = value }
    return try JSONValue.object(fields).decoded(InboxListRow.self)
  }

  private func baseRow() throws -> JSONValue { try Contract.json("fixtures/rows.json").at("rows").items[0] }

  func testSnoozedRowsWakeAndSortAsTheWindowDoes() throws {
    let fixture = try Contract.json("fixtures/snooze.json")
    let vector = try Contract.json("vectors/snooze.json").at("rows")
    let base = try baseRow()
    let now = try date(vector.at("now").str())
    let rows = try fixture.at("rows").items.map { try row($0, base: base) }
    let split = ListRules.splitSnoozed(rows, now: now)
    XCTAssertEqual(split.rows.map(\.threadId.rawValue), try vector.at("listed").strings)
    XCTAssertEqual(split.snoozed.map(\.threadId.rawValue), try vector.at("snoozed").strings)
    for expected in try vector.at("as_of").items {
      let id = try expected.at("thread_id").str()
      let mine = try XCTUnwrap((split.rows + split.snoozed).first { $0.threadId.rawValue == id })
      XCTAssertEqual(mine.section.rawValue, try expected.at("section").str(), id)
      XCTAssertEqual(mine.unread, expected["unread"]?.flag, id)
      XCTAssertEqual(mine.lastAt, try expected.at("last_at").str(), id)
      XCTAssertEqual(mine.snoozeBack, expected["snooze_back"]?.text, id)
      XCTAssertEqual(mine.snoozed?.until, expected["snoozed"]?["until"]?.text, id)
    }
    for running in try vector.at("running").items {
      let id = try running.at("thread_id").str()
      let mine = try XCTUnwrap(rows.first { $0.threadId.rawValue == id })
      XCTAssertEqual(mine.snoozed.map { SnoozeRules.running($0.until, now: now) } ?? false, running["running"]?.flag, id)
    }
    let delay = SnoozeRules.delay(rows.compactMap { $0.snoozed?.until }, now: now)
    XCTAssertEqual(delay.map { Int(($0 * 1000).rounded()) }, vector["delay_ms"]?.whole)

    // Sections the window already holds, with the woken rows sorted in.
    let sectionRows = try fixture.at("section_rows").items.map { try row($0, base: base) }
    let byID = Dictionary((sectionRows + rows).map { ($0.threadId.rawValue, $0) }, uniquingKeysWith: { first, _ in first })
    let sections = try fixture.at("sections").items.map { section in
      InboxListSection(id: InboxListGroupId(rawValue: try section.at("id").str()), label: try section.at("label").str(), threads: section["threads"]!.strings.compactMap { byID[$0] })
    }
    let asOf = ListRules.sectionsAsOf(sections, snoozed: rows, now: now)
    XCTAssertEqual(asOf.sections.map(\.id.rawValue), try vector.at("sections").items.map { try $0.at("id").str() })
    XCTAssertEqual(asOf.sections.map { $0.threads.map(\.threadId.rawValue) }, try vector.at("sections").items.map { try $0.at("threads").strings })
    XCTAssertEqual(asOf.snoozed.map(\.threadId.rawValue), try vector.at("band").strings)
  }

  // MARK: The list and its rows

  private func listFixture() throws -> (now: Date, rows: [InboxListRow], pins: [ThreadID]) {
    let fixture = try Contract.json("fixtures/rows.json")
    let rows = try fixture.at("rows").items.map { try $0.without("note").decoded(InboxListRow.self) }
    return (try date(fixture.at("now").str()), rows, try fixture.at("pins").strings.map { ThreadID($0) })
  }

  /// The door's answer with no query: every row in its section, archived ones in Quiet, snoozed ones where they are.
  private func model(_ rows: [InboxListRow], pins: [ThreadID]) -> ListModel {
    var model = ListModel(serverSession: "s", version: "1", cursor: 1, projects: [], sections: ListRules.sections(rows))
    model.pins = pins.compactMap { id in rows.first { $0.threadId == id } }
    return model
  }

  func testTheListIsDrawnAsTheWindowDrawsIt() throws {
    let vector = try Contract.json("vectors/rows.json")
    let (now, rows, pins) = try listFixture()
    // The door's answer, as the product sorts it.
    let answer = ListRules.sections(rows)
    XCTAssertEqual(answer.map(\.id.rawValue), try vector.at("answer").items.map { try $0.at("id").str() })
    XCTAssertEqual(answer.map(\.label), try vector.at("answer").items.map { try $0.at("label").str() })
    XCTAssertEqual(answer.map { $0.threads.map(\.threadId.rawValue) }, try vector.at("answer").items.map { try $0.at("threads").strings })

    let view = ListView.of(model(rows, pins: pins), now: now)
    XCTAssertEqual(view.groups.map(\.id.rawValue), try vector.at("groups").items.map { try $0.at("id").str() })
    XCTAssertEqual(view.groups.map(\.label), try vector.at("groups").items.map { try $0.at("label").str() })
    XCTAssertEqual(view.groups.map { $0.threads.map(\.threadId.rawValue) }, try vector.at("groups").items.map { try $0.at("threads").strings })
    XCTAssertEqual(view.badge, try vector.at("badge").at("count").int())
    XCTAssertEqual(view.badgeLabel, try vector.at("badge").at("label").str())
    XCTAssertEqual(view.waiting, try vector.at("waiting").int())
    XCTAssertEqual(view.nextWake.map { Int(($0.timeIntervalSince(now) * 1000).rounded()) }, vector["wake_ms"]?.whole)
    XCTAssertEqual(view.archived.map(\.threadId.rawValue), try vector.at("archived").strings)
    XCTAssertEqual(view.pins.map { ListRules.pinnedState($0).rawValue }, try vector.at("pins").items.map { try $0.at("state").str() })

    // The same list read as the window reads it (archived and snoozed apart) draws the same.
    var excluded = ListModel(serverSession: "s", version: "1", cursor: 1, projects: [], sections: ListRules.sections(rows.filter { !ListRules.archived($0) && $0.snoozed == nil }))
    excluded.snoozed = rows.filter { !ListRules.archived($0) && $0.snoozed != nil }
    excluded.pins = model(rows, pins: pins).pins
    XCTAssertEqual(ListView.of(excluded, now: now).groups.map { $0.threads.map(\.threadId) }, view.groups.map { $0.threads.map(\.threadId) })
  }

  func testEachRowOffersWhatTheWindowsMenuAndSwipesOffer() throws {
    let vector = try Contract.json("vectors/rows.json")
    let (now, rows, pins) = try listFixture()
    let view = ListView.of(model(rows, pins: pins), now: now)
    let stamp = try vector.at("now").str()
    func standing(_ id: String) throws -> InboxListRow {
      let original = try XCTUnwrap(rows.first { $0.threadId.rawValue == id })
      return ListRules.asOf(original, now: now)
    }
    func check(_ expected: JSONValue, drawn: InboxListGroupId?, _ row: InboxListRow, file: StaticString = #filePath, line: UInt = #line) throws {
      let id = row.threadId.rawValue
      let menu = RowOffers.menu(row, drawn: drawn, pinned: row.pinnedAt != nil)
      XCTAssertEqual(menu.map(\.rawValue), try expected.at("menu").strings, "menu of \(id) drawn in \(drawn?.rawValue ?? "none")", file: file, line: line)
      let swipe = RowOffers.swipe(row, drawn: drawn)
      XCTAssertEqual(swipe.lead?.rawValue, expected["swipe"]?["lead"]?.text, "lead swipe of \(id)", file: file, line: line)
      XCTAssertEqual(swipe.trail?.rawValue, expected["swipe"]?["trail"]?.text, "trail swipe of \(id)", file: file, line: line)
    }
    for expected in try vector.at("rows").items {
      let id = try expected.at("thread_id").str()
      let row = try standing(id)
      let drawn = expected["drawn"]?.text.map(InboxListGroupId.init(rawValue:))
      XCTAssertEqual(view.group(of: row.threadId), drawn, "group of \(id)")
      try check(expected, drawn: drawn, row)
      let aside = RowOffers.setAside(row)
      XCTAssertEqual(aside.questions, try expected.at("set_aside").at("questions").int(), "set aside of \(id)")
      XCTAssertEqual(aside.actions, try expected.at("set_aside").at("actions").int(), "set aside of \(id)")
      // Where a row goes back to when it leaves Priority: the toast's group.
      let back = RowOffers.backIn(row)
      let label = back == .archived ? "Archived" : back == .snoozed ? Words.groupSnoozed : Words.sections[back.rawValue] ?? ""
      XCTAssertEqual("Back in \(label)", expected["priority_back_in"]?.text, "back in, \(id)")
      // What Mark read and Archive draw at once, as the window patches the row.
      let read = ThreadAct.read.drawn(row, at: stamp)
      XCTAssertEqual(read.readAt, try expected.at("read_patch").at("read_at").str())
      XCTAssertEqual(read.unread, expected["read_patch"]?["unread"]?.flag)
      XCTAssertEqual(Int(read.unseen), try expected.at("read_patch").at("unseen").int())
      let archived = ThreadAct.archive.drawn(row, at: stamp)
      XCTAssertEqual(archived.resolvedAt, try expected.at("archived_patch").at("resolved_at").str(), "archive of \(id)")
      XCTAssertEqual(archived.section.rawValue, try expected.at("archived_patch").at("section").str())
      XCTAssertEqual(archived.unread, expected["archived_patch"]?["unread"]?.flag)
    }
    for expected in try vector.at("drawn").items {
      let id = try expected.at("thread_id").str()
      try check(expected, drawn: expected["drawn"]?.text.map(InboxListGroupId.init(rawValue:)), try standing(id))
    }
    for move in try vector.at("moves").items {
      let order = ListRules.movePin(pins, ThreadID(try move.at("thread_id").str()), by: try move.at("by").int())
      XCTAssertEqual(order.map(\.rawValue), try move.at("order").strings, "move \(move)")
    }
  }
}
