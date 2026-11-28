import Foundation
import InboxCore
import InboxWire

/// A thread whose messages carry files, for the tests and the screenshots. Invented, like the rest. The files made
/// of words are here; pictures, a video and a PDF are drawn by whoever seats the stand-in (the app's debug stage),
/// since this package has no drawing.
extension StandInData {
  public static let files = ThreadID("msg_STANDIN0000000000000060")
  public static let filesFirst = MessageID("msg_STANDIN0000000000000060")
  public static let filesSecond = MessageID("msg_STANDIN0000000000000061")

  public static func filesThread(now: Date) -> InboxThread {
    let claude = agent("claude-code", "ses_files")
    func message(_ id: MessageID, seq: Int64, minutesAgo: Double, _ body: String) -> InboxMessageWire {
      InboxMessageWire(seq: seq, id: id, projectId: ProjectID("prj_api-server"), threadId: files, author: claude, body: body, createdAt: iso(now.addingTimeInterval(-minutesAgo * 60)))
    }
    return InboxThread(
      threadId: files, project: project("api-server"), threadName: "Relay retries: plan and evidence",
      messages: [
        message(filesFirst, seq: 700, minutesAgo: 9, "The plan for the relay client's retries is attached, with the change itself and the run that shows the drop."),
        message(filesSecond, seq: 701, minutesAgo: 4, "The flame graph and the canary page are here too. The recording is the stand-up note about the cap."),
      ])
  }

  public static let planName = "retry-plan.md"
  public static let plan = """
    # Retry plan for the relay client

    Status: **draft** · Owner: `relay` · Target: next release

    ## Problem

    The client drops its socket when the laptop sleeps and never comes back. It retries at once, three times, then gives up, so a phone that was away for a minute stays away until the app is opened again.

    ## Proposal

    1. Retry with a growing wait, capped at 60 seconds.
    2. Add jitter so a fleet does not retry in step.
    3. Stop after ten minutes and say so.

    - [x] Reproduce on a sleeping laptop
    - [ ] Ship behind a flag
      - Off by default for one release

    | Attempt | Wait | Jitter |
    |---|---:|---:|
    | 1 | 1 s | 250 ms |
    | 2 | 2 s | 250 ms |
    | 3 | 4 s | 250 ms |
    | 6 and later | 60 s | 250 ms |

    ```ts
    const wait = Math.min(60_000, 1000 * 2 ** tries)
    await sleep(wait + jitter(250))
    ```

    > Ten minutes is a guess.
    > Measure it on the canary before the release.

    ---

    ### Open questions

    Whether the cap should be lower on a metered connection, and who decides when the client has given up for good.

    ## Rollout

    Ten percent of phones for a day, then everyone. The canary page shows the reconnect rate; a rate under 99% stops the rollout by itself.

    ## Not in this change

    - The server's own keep-alive
    - Push as a wake signal
    """

  public static let codeName = "client.ts"
  public static let code = """
    import { jitter, sleep } from "./time"

    const CAP_MS = 60_000
    const GIVE_UP_MS = 10 * 60_000

    export type Socket = { open(): Promise<void>; closed: Promise<void> }

    /** Keep a socket open: when it closes, open it again with a growing wait. */
    export async function keepOpen(socket: Socket, now: () => number = Date.now): Promise<"gave-up"> {
      let tries = 0
      let since = now()
      for (;;) {
        try {
          await socket.open()
          tries = 0
          since = now()
          await socket.closed
        } catch (error) {
          if (now() - since > GIVE_UP_MS) return "gave-up"
          const wait = Math.min(CAP_MS, 1000 * 2 ** tries) + jitter(250)
          console.warn(`relay: socket closed, opening again in ${Math.round(wait / 1000)} s (try ${tries + 1})`, error)
          tries += 1
          await sleep(wait)
        }
      }
    }
    """

  public static let logName = "relay-run.log"
  public static let log = (1...60).map { n in
    let second = String(format: "%02d", n % 60)
    switch n % 6 {
    case 0: return "09:14:\(second) WARN  relay socket closed code=1006 reason=\"\" device=phone-\(n) after=\(n * 37) ms"
    case 3: return "09:14:\(second) INFO  relay opening again wait=\(min(60, 1 << (n % 7))) s try=\(n % 7 + 1)"
    default: return "09:14:\(second) DEBUG relay ping ok rtt=\(20 + n) ms"
    }
  }.joined(separator: "\n") + "\n"

  public static let notesName = "stand-up notes.txt"
  public static let notes = """
    Stand-up, Tuesday

    The cap stays at a minute for now. Lower it only if the canary shows phones waiting on a network that is already back.

    Next: the flag, then the canary.
    """

  public static let pageName = "canary.html"
  public static let page = """
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Canary rollout</title>
    <style>
      body { margin: 0; font: 16px/1.45 -apple-system, system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
      header { padding: 20px; border-bottom: 1px solid #30363d; }
      h1 { margin: 0 0 4px; font-size: 20px; }
      p { margin: 0; color: #9da7b3; font-size: 14px; }
      section { margin: 16px 20px; padding: 16px; border: 1px solid #30363d; border-radius: 12px; background: #161b22; }
      .n { font-size: 34px; font-weight: 700; margin: 6px 0; }
      .ok { color: #3fb950; } .warn { color: #d29922; }
      .bar { height: 10px; border-radius: 5px; background: #21262d; overflow: hidden; }
      .bar i { display: block; height: 100%; width: 25%; background: #3fb950; }
      table { width: 100%; border-collapse: collapse; font-size: 15px; }
      th, td { text-align: left; padding: 8px 4px; border-bottom: 1px solid #30363d; }
      button { font: inherit; padding: 10px 14px; border-radius: 10px; border: 1px solid #30363d; background: #21262d; color: inherit; }
    </style>
    </head>
    <body>
    <header><h1>Canary rollout · relay client</h1><p>Stage 2 of 4 · 25% of phones · started 13:40</p></header>
    <section><p>Phones on the canary</p><div class="n">25%</div><div class="bar"><i></i></div></section>
    <section><p>Reconnect rate</p><div class="n ok">99.6%</div><p>baseline 97.1% · stops under 99%</p></section>
    <section><p>Longest wait</p><div class="n warn">58 s</div><p>cap 60 s</p></section>
    <section><table><tr><th>Region</th><th>Phones</th><th>Rate</th></tr><tr><td>North</td><td>412</td><td class="ok">99.8%</td></tr><tr><td>South</td><td>288</td><td class="ok">99.5%</td></tr><tr><td>East</td><td>131</td><td class="warn">99.1%</td></tr></table></section>
    <section><button id="b" onclick="this.textContent = 'Refreshed'">Refresh</button></section>
    </body>
    </html>
    """

  /// A page that tries every way out of its viewer once it has loaded: a fetch, a scripted click on a link to a site
  /// and on a phone number, and a move of `location` to another page. On the phone none of them goes anywhere; the page says what it
  /// tried, and what its policy refused.
  /// A page whose frame is meant to let touches through (its own inline `pointer-events: none`) to the button under it.
  public static let framedPageName = "framed.html"
  public static let framedPage = """
    <!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font:17px -apple-system,sans-serif;margin:0;padding:24px} .stack{position:relative;height:180px} button{position:absolute;left:0;top:0;width:100%;height:180px;font-size:20px} iframe{position:absolute;left:0;top:0;width:100%;height:180px;border:0;background:transparent}</style>
    </head><body><h1>Framed</h1>
    <div class="stack"><button onclick="this.textContent = 'Pressed'">Under the frame</button><iframe title="Overlay" srcdoc="<p></p>" style="pointer-events: none"></iframe></div>
    </body></html>
    """

  public static let leavingPageName = "leaving.html"
  public static let leavingPage = """
    <!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Leaving</title>
    <style>body { margin: 20px; font: 17px/1.45 -apple-system, system-ui, sans-serif; }</style>
    </head>
    <body>
    <h1>A page that tries to leave</h1>
    <p id="net">Network: not tried</p>
    <p id="moved">Links: not tried</p>
    <a id="site" href="https://example.invalid/away">A site</a>
    <a id="call" href="tel:5550100">A call</a>
    <script>
    document.addEventListener("securitypolicyviolation", (event) => {
      if (event.effectiveDirective === "connect-src") document.getElementById("net").textContent = "Network: refused by connect-src";
    });
    document.getElementById("net").textContent = "Network: tried";
    fetch("https://example.invalid/data").catch(() => {});
    setTimeout(() => {
      document.getElementById("site").click();
      document.getElementById("call").click();
      document.getElementById("moved").textContent = "Links: clicked by the page";
      // A page that loads when allowed (a site that cannot be reached would leave this one up).
      setTimeout(() => { location.href = "about:blank"; }, 300);
    }, 1500);
    </script>
    </body>
    </html>
    """

  /// A second of a quiet tone, as a WAV file: 8 kHz, 8 bits, one channel.
  public static func tone(seconds: Int = 3) -> Data {
    let rate = 8000
    let count = rate * seconds
    var data = Data()
    func le32(_ value: Int) { withUnsafeBytes(of: UInt32(value).littleEndian) { data.append(contentsOf: $0) } }
    func le16(_ value: Int) { withUnsafeBytes(of: UInt16(value).littleEndian) { data.append(contentsOf: $0) } }
    data.append(contentsOf: Array("RIFF".utf8))
    le32(36 + count)
    data.append(contentsOf: Array("WAVEfmt ".utf8))
    le32(16); le16(1); le16(1); le32(rate); le32(rate); le16(1); le16(8)
    data.append(contentsOf: Array("data".utf8))
    le32(count)
    for n in 0..<count {
      let wave = sin(Double(n) * 2 * .pi * 330 / Double(rate))
      data.append(UInt8(128 + 24 * wave))
    }
    return data
  }
}

extension StandInDoor {
  /// The files thread with the files that are made of words (and a recording), on its two messages.
  @discardableResult
  public func addFilesThread(now: Date = Date()) -> [InboxAttachment] {
    add(StandInData.filesThread(now: now))
    var made: [InboxAttachment] = []
    made.append(addFile(thread: StandInData.files, message: StandInData.filesFirst, name: StandInData.planName, kind: .markdown, bytes: Data(StandInData.plan.utf8)))
    made.append(addFile(thread: StandInData.files, message: StandInData.filesFirst, name: StandInData.codeName, kind: .code, bytes: Data(StandInData.code.utf8)))
    made.append(addFile(thread: StandInData.files, message: StandInData.filesFirst, name: StandInData.logName, kind: .text, bytes: Data(StandInData.log.utf8)))
    made.append(addFile(thread: StandInData.files, message: StandInData.filesFirst, name: StandInData.notesName, kind: .text, bytes: Data(StandInData.notes.utf8)))
    made.append(addFile(thread: StandInData.files, message: StandInData.filesSecond, name: StandInData.pageName, kind: .html, bytes: Data(StandInData.page.utf8)))
    made.append(addFile(thread: StandInData.files, message: StandInData.filesSecond, name: "stand-up.wav", kind: .audio, bytes: StandInData.tone(), mediaType: "audio/wav", durationMs: 3000))
    return made
  }
}
