import { DurableObject } from "cloudflare:workers";
import { CREATE_LIMIT, CREATE_WINDOW_MS, windowCounter } from "./brake";

export class CreateBrake extends DurableObject {
  private readonly counter = windowCounter(CREATE_LIMIT, CREATE_WINDOW_MS);

  admit(): boolean {
    return this.counter();
  }
}
