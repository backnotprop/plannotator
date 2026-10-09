import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { privateWrite, type T3Credentials } from "./auth";
import { T3Thread, type T3SentMessage } from "./t3-client";

interface Delivery {
  thread: string;
  requestId: string;
  text: string;
  epoch: string;
  receipt?: T3SentMessage;
}

export class T3Delivery {
  readonly directory: string;
  private readonly connectionEpoch: string | undefined;
  constructor(readonly thread: T3Thread, readonly credentials: T3Credentials) {
    this.connectionEpoch = credentials.read()?.epoch;
    this.directory = join(credentials.directory, "deliveries", createHash("sha256").update(thread.id).digest("hex"));
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  async send(text: string, requestId: string): Promise<T3SentMessage> {
    const epoch = this.credentials.read()?.epoch;
    if (!epoch) throw new Error("Sign in to T3 before sending.");
    if (epoch !== this.connectionEpoch) throw new Error("T3 credentials changed. Restart this thread's companion before sending.");
    const path = join(this.directory, `${createHash("sha256").update(requestId).digest("hex")}.json`);
    const previous = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Delivery : undefined;
    if (previous && (previous.thread !== this.thread.id || previous.requestId !== requestId || previous.text !== text)) throw new Error("A T3 delivery retry changed its scope or content.");
    if (previous?.receipt) return previous.receipt;
    // A new OAuth grant changes T3's retry namespace. Never replay an uncertain send under it.
    if (previous && previous.epoch !== epoch) throw new Error("This delivery is uncertain after T3 reauthorization. Check the T3 thread before retrying it.");
    const delivery: Delivery = previous ?? { thread: this.thread.id, requestId, text, epoch };
    privateWrite(path, delivery);
    const receipt = await this.thread.send(text, requestId);
    privateWrite(path, { ...delivery, receipt });
    return receipt;
  }

}
