import Foundation
import InboxWire

/// Why a call to the door did not give its answer.
public enum DoorFailure: Error, Sendable {
  /// No answer at all: the computer is off, asleep or on another network.
  /// `mayHaveArrived` is false only when the connection was never made, so the request cannot have been taken.
  case unreachable(String, mayHaveArrived: Bool = true)
  /// The door answered with a refusal. Act on `code`; `error.error` holds the Inbox's own words.
  case refused(status: Int, error: DoorError)
  /// `426 app_needs_update`: this app is older than the Inbox serves.
  case appNeedsUpdate(minAppContract: Int?)
  /// An answer this app could not read.
  case unreadable(status: Int)
  /// The route is not one this Inbox lists in `health.door.routes`: never called.
  case notOffered(route: String)

  public var code: WireErrorCode? {
    if case .refused(_, let error) = self { return WireErrorCode(rawValue: error.code) }
    return nil
  }

  /// A definite answer: the write was applied or refused, so its idempotency key is spent.
  public var isDefinite: Bool {
    switch self {
    // The product's own outbox rule (`classifyAnswer`, packages/server/inbox-outbox.ts:116-126): a 401 is final
    // only when it says the device is revoked or its token is not known; any other 401 is tried again.
    case .refused(401, let error): return error.code == "device_revoked" || error.code == "device_token_invalid"
    case .refused(let status, _): return status < 500 && status != 408 && status != 429
    case .appNeedsUpdate, .notOffered: return true
    // A 4xx that is not the Inbox's JSON (a proxy's page): still a refusal, never retried for ever.
    // 408 and 429 are not: whatever stands in front asked for another try.
    case .unreadable(let status): return (400..<500).contains(status) && status != 408 && status != 429
    case .unreachable: return false
    }
  }

  /// Whether a request that failed this way can have reached the door: not when no connection was ever made.
  static func mayHaveArrived(_ error: Error) -> Bool {
    guard let code = (error as? URLError)?.code else { return true }
    return ![.cannotConnectToHost, .cannotFindHost, .dnsLookupFailed, .notConnectedToInternet, .dataNotAllowed, .internationalRoamingOff, .secureConnectionFailed, .serverCertificateUntrusted].contains(code)
  }

  static func from(status: Int, headers: [String: String], body: Data) -> DoorFailure {
    guard let error = try? JSONDecoder().decode(DoorError.self, from: body) else { return .unreadable(status: status) }
    if status == 426, error.code == "app_needs_update" {
      var floor: Int?
      if case .number(let value)? = error.unknownFields["min_app_contract"] { floor = Int(value) }
      return .appNeedsUpdate(minAppContract: floor)
    }
    return .refused(status: status, error: error)
  }
}

/// The list as read: a row this app cannot decode is left out, never the whole list.
public struct ListRead: Sendable {
  public var model: ListModel
  public var unreadableRows: Int
}

/// A health answer: what the Inbox says of itself, and what the app makes of its door.
public struct HealthRead: Sendable {
  public var health: InboxHealth?
  public var skew: DoorSkew
}

/// The door of one computer, spoken through one transport. Every answer is decoded by Wire.swift's types.
public struct DoorClient: Sendable {
  public let transport: any DoorTransport
  public let token: String?
  public let app: AppIdentity

  public init(transport: any DoorTransport, token: String?, app: AppIdentity) {
    self.transport = transport
    self.token = token
    self.app = app
  }

  func headers(for request: DoorRequest, body: Bool) -> [String: String] {
    var headers = [AppIdentity.headerName: app.headerValue, "Accept": "application/json"]
    if request.route.needsToken, let token { headers["Authorization"] = "Bearer \(token)" }
    if body { headers["Content-Type"] = "application/json" }
    return headers
  }

  func call(_ request: DoorRequest, query: [URLQueryItem] = [], body: Data? = nil) async throws -> DoorAnswerBytes {
    let call = DoorCall(method: request.route.method, path: request.path, query: query, headers: headers(for: request, body: body != nil), body: body)
    let answer: DoorAnswerBytes
    do {
      answer = try await transport.send(call)
    } catch let failure as DoorFailure {
      throw failure
    } catch {
      throw DoorFailure.unreachable((error as NSError).localizedDescription, mayHaveArrived: DoorFailure.mayHaveArrived(error))
    }
    guard (200..<300).contains(answer.status) else { throw DoorFailure.from(status: answer.status, headers: answer.headers, body: answer.body) }
    return answer
  }

  func decode<T: Decodable>(_ type: T.Type, _ answer: DoorAnswerBytes) throws -> T {
    do { return try JSONDecoder().decode(type, from: answer.body) } catch { throw DoorFailure.unreadable(status: answer.status) }
  }

  func get<T: Decodable>(_ request: DoorRequest, query: [URLQueryItem] = [], as type: T.Type) async throws -> T {
    try decode(type, try await call(request, query: query))
  }

  func post<Body: Encodable, T: Decodable>(_ request: DoorRequest, _ body: Body, as type: T.Type) async throws -> T {
    try decode(type, try await call(request, body: try JSONEncoder().encode(body)))
  }

  // MARK: Pairing

  /// Redeem a pairing offer: by the QR code's secret, or by the six digits (the tailnet only).
  public func pair(secret: String? = nil, code: String? = nil, deviceName: String) async throws -> DoorPairAnswer {
    try await post(Door.postPair(), DoorPairRequest(secret: secret, code: code, name: deviceName, platform: app.platform), as: DoorPairAnswer.self)
  }

  /// Remove this phone from the computer. Repeating it changes nothing.
  public func revoke() async throws {
    _ = try await call(Door.postRevoke(), body: Data("{}".utf8))
  }

  // MARK: Reads

  public func health() async throws -> HealthRead {
    let answer = try await call(Door.getHealth())
    let raw = try decode(JSONValue.self, answer)
    return HealthRead(health: try? JSONDecoder().decode(InboxHealth.self, from: answer.body), skew: DoorSkew.read(health: raw, client: .thisApp))
  }

  public func threads() async throws -> ListRead {
    try Self.readList(try await call(Door.getThreads()).body)
  }

  public func thread(_ id: ThreadID) async throws -> ThreadModel {
    try await get(Door.getThread(thread: id), as: ThreadModel.self)
  }

  /// The list, its rows decoded one by one so one row this app cannot read does not blank the list.
  public static func readList(_ data: Data) throws -> ListRead {
    guard var root = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DoorFailure.unreadable(status: 200) }
    var unreadable = 0
    let decoder = JSONDecoder()
    func rows(_ value: Any?) -> [InboxListRow] {
      guard let items = value as? [Any] else { return [] }
      return items.compactMap { item in
        guard let bytes = try? JSONSerialization.data(withJSONObject: item), let row = try? decoder.decode(InboxListRow.self, from: bytes) else {
          unreadable += 1
          return nil
        }
        return row
      }
    }
    let sections = (root["sections"] as? [[String: Any]]) ?? []
    let sectionRows = sections.map { rows($0["threads"]) }
    let snoozed = root["snoozed"].map { rows($0) }
    let pins = root["pins"].map { rows($0) }
    root["sections"] = sections.map { section -> [String: Any] in
      var bare = section
      bare["threads"] = [Any]()
      return bare
    }
    root["snoozed"] = nil
    root["pins"] = nil
    var model: ListModel
    do { model = try decoder.decode(ListModel.self, from: try JSONSerialization.data(withJSONObject: root)) } catch { throw DoorFailure.unreadable(status: 200) }
    for index in model.sections.indices where index < sectionRows.count { model.sections[index].threads = sectionRows[index] }
    model.snoozed = snoozed
    model.pins = pins
    return ListRead(model: model, unreadableRows: unreadable)
  }

  // MARK: Writes (each carries the idempotency key of its intent)

  /// The person looked at the thread, up to the newest message the phone showed.
  public func seen(_ thread: ThreadID, throughSeq: Int64?, idempotencyKey: String) async throws {
    _ = try await call(Door.postThreadSeen(thread: thread), body: try JSONEncoder().encode(DoorSeenBody(idempotencyKey: idempotencyKey, throughSeq: throughSeq)))
  }

  public func picks(_ message: MessageID, body: DoorPicksBody) async throws -> DoorPicksAnswer {
    try await post(Door.postMessagePicks(message: message), body, as: DoorPicksAnswer.self)
  }

  public func reply(_ message: MessageID, body: DoorReplyBody) async throws -> ReplyResult {
    try await post(Door.postMessageReply(message: message), body, as: ReplyResult.self)
  }

  /// A write whose body is a file's own bytes (a drawing): its idempotency key rides the query.
  public func sendBytes(path: String, query: [URLQueryItem], body: Data, type: String) async throws -> DoorAnswerBytes {
    let call = DoorCall(
      method: .post, path: path, query: query,
      headers: [AppIdentity.headerName: app.headerValue, "Accept": "application/json", "Content-Type": type].merging(token.map { ["Authorization": "Bearer \($0)"] } ?? [:]) { $1 },
      body: body)
    let answer: DoorAnswerBytes
    do { answer = try await transport.send(call) } catch let failure as DoorFailure { throw failure } catch { throw DoorFailure.unreachable((error as NSError).localizedDescription, mayHaveArrived: DoorFailure.mayHaveArrived(error)) }
    guard (200..<300).contains(answer.status) else { throw DoorFailure.from(status: answer.status, headers: answer.headers, body: answer.body) }
    return answer
  }

  /// A write whose body was kept in the outbox: sent again exactly as it was first made.
  public func resend(method: DoorMethod, path: String, body: Data) async throws -> DoorAnswerBytes {
    let call = DoorCall(
      method: method, path: path,
      headers: [AppIdentity.headerName: app.headerValue, "Accept": "application/json", "Content-Type": "application/json"].merging(token.map { ["Authorization": "Bearer \($0)"] } ?? [:]) { $1 },
      body: body)
    let answer: DoorAnswerBytes
    do { answer = try await transport.send(call) } catch let failure as DoorFailure { throw failure } catch { throw DoorFailure.unreachable((error as NSError).localizedDescription, mayHaveArrived: DoorFailure.mayHaveArrived(error)) }
    guard (200..<300).contains(answer.status) else { throw DoorFailure.from(status: answer.status, headers: answer.headers, body: answer.body) }
    return answer
  }
}
