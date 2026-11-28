import Foundation
import InboxWire

/// What this app knows about itself for the version handshake (`InboxDoorClient` in
/// packages/core/inbox-door-version.ts).
public struct DoorClientFacts: Hashable, Sendable {
  public var contract: Int
  /// The oldest Inbox contract the app still serves (0: one from before the handshake).
  public var minInboxContract: Int
  /// The routes an Inbox from before the handshake answers, in the words `health.door.routes` uses.
  public var routesBeforeDoor: [String]
  public var notByRelayBeforeDoor: [String]

  public init(contract: Int, minInboxContract: Int, routesBeforeDoor: [String], notByRelayBeforeDoor: [String] = []) {
    self.contract = contract
    self.minInboxContract = minInboxContract
    self.routesBeforeDoor = routesBeforeDoor
    self.notByRelayBeforeDoor = notByRelayBeforeDoor
  }

  /// This build: an Inbox with no `door` is read as today's route list for a phone (door.json).
  public static let thisApp = DoorClientFacts(
    contract: wireContract,
    minInboxContract: 0,
    routesBeforeDoor: DoorRoutes.all.filter { $0.grant == .phone }.map(\.name),
    notByRelayBeforeDoor: DoorRoutes.all.filter { $0.grant == .phone && !$0.relay }.map(\.name)
  )
}

/// What the app does with one Inbox (`InboxDoorSkew`, `readInboxDoorHealth`).
public enum DoorSkew: Hashable, Sendable {
  /// Offer exactly what `routes` names: a route that is not listed is never called.
  case ok(contract: Int, routes: [String], notByRelay: [String], grants: [String])
  /// This Inbox is older than the app serves: its threads are not listed.
  case inboxNeedsUpdate(contract: Int, minInboxContract: Int)
  /// This Inbox refuses the app everywhere but health, pair and revoke.
  case appNeedsUpdate(contract: Int, minAppContract: Int)

  public enum Path: Sendable { case direct, relay }

  /// A whole number from 0 to 2^53 - 1, as JavaScript's `Number.isSafeInteger` reads one.
  static func wholeNumber(_ value: JSONValue?) -> Int? {
    guard case .number(let number)? = value, number >= 0, number <= 9_007_199_254_740_991, number.rounded() == number else { return nil }
    return Int(number)
  }

  static func strings(_ value: JSONValue?) -> [String]? {
    guard case .array(let items)? = value else { return nil }
    var out: [String] = []
    for item in items {
      guard case .string(let text) = item else { return nil }
      out.append(text)
    }
    return out
  }

  /// The `door` of a health answer, or nil for an Inbox from before the handshake (absent, or not in this shape).
  public static func door(of health: JSONValue) -> InboxDoorHealth? {
    guard case .object(let fields) = health, case .object(let door)? = fields["door"] else { return nil }
    guard let contract = wholeNumber(door["contract"]), let floor = wholeNumber(door["min_app_contract"]), let routes = strings(door["routes"]) else { return nil }
    return InboxDoorHealth(
      contract: Double(contract), routes: routes, notByRelay: strings(door["not_by_relay"]) ?? [], grants: strings(door["grants"]) ?? [], minAppContract: Double(floor))
  }

  /// Read a health answer from the door. The Inbox's floor wins over the app's, since it refuses the app's every call.
  public static func read(health: JSONValue, client: DoorClientFacts = .thisApp) -> DoorSkew {
    let door = door(of: health)
    let contract = door.map { Int($0.contract) } ?? 0
    if let door, client.contract < Int(door.minAppContract) { return .appNeedsUpdate(contract: contract, minAppContract: Int(door.minAppContract)) }
    if contract < client.minInboxContract { return .inboxNeedsUpdate(contract: contract, minInboxContract: client.minInboxContract) }
    if let door { return .ok(contract: contract, routes: door.routes, notByRelay: door.notByRelay, grants: door.grants) }
    return .ok(contract: contract, routes: client.routesBeforeDoor, notByRelay: client.notByRelayBeforeDoor, grants: [])
  }

  /// Whether the app may call a route (`POST messages/:id/reply`) on this Inbox, on the path it would use.
  public func offers(_ route: String, path: Path = .direct) -> Bool {
    guard case .ok(_, let routes, let notByRelay, _) = self else { return false }
    return routes.contains(route) && (path == .direct || !notByRelay.contains(route))
  }

  public func offers(_ route: DoorRoute, path: Path = .direct) -> Bool { offers(route.name, path: path) }
}
